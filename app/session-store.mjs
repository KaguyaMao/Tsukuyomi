import { mkdir, open, readdir, rename, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

function clean(value) {
	return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function messageText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text").map((part) => part.text || "").join(" ");
}

// Session metadata (cwd, display name, first prompt) is written near the top of
// the log, and renames append session_info near the tail. Reading every file in
// full made `/sessions` parse hundreds of megabytes on the main thread and
// freeze the terminal. Read bounded head/tail windows instead and cache them by
// (mtime, size) so repeated opens are instant.
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const metadataCache = new Map();

/** Parse complete JSONL records from a window, dropping any partial edge lines. */
function parseWindow(text, { skipFirst = false, skipLast = false } = {}) {
	const records = [];
	let lines = text.split("\n");
	if (skipFirst && lines.length) lines = lines.slice(1);
	if (skipLast && lines.length) lines = lines.slice(0, -1);
	for (const line of lines) {
		if (!line) continue;
		try { records.push(JSON.parse(line)); } catch { /* trailing/partial */ }
	}
	return records;
}

async function readWindow(handle, position, length) {
	if (length <= 0) return "";
	const buffer = Buffer.allocUnsafe(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	if (bytesRead <= 0) return "";
	return buffer.toString("utf8", 0, bytesRead);
}

async function readMetadata(path, cwd, size) {
	let handle;
	try {
		handle = await open(path, "r");
		let sessionCwd = cwd;
		let name = "";
		let firstPrompt = "";
		const head = await readWindow(handle, 0, Math.min(size, HEAD_BYTES));
		// A head shorter than the file ends mid-line; its last line is partial.
		const headPartial = size > HEAD_BYTES;
		for (const entry of parseWindow(head, { skipLast: headPartial })) {
			if (entry?.type === "session" && typeof entry.cwd === "string") sessionCwd = resolve(cwd, entry.cwd);
			if (entry?.type === "session_info" && typeof entry.name === "string") name = entry.name;
			if (!firstPrompt && entry?.type === "message" && entry.message?.role === "user") firstPrompt = messageText(entry.message.content);
		}
		if (size > HEAD_BYTES && !name) {
			const tailStart = Math.max(HEAD_BYTES, size - TAIL_BYTES);
			const tail = await readWindow(handle, tailStart, size - tailStart);
			// The window starts mid-line but reaches EOF, so keep the final line.
			for (const entry of parseWindow(tail, { skipFirst: true })) {
				if (entry?.type === "session_info" && typeof entry.name === "string") name = entry.name;
			}
		}
		return { sessionCwd, name, firstPrompt };
	} catch {
		return { sessionCwd: cwd, name: "", firstPrompt: "" };
	} finally {
		await handle?.close().catch(() => {});
	}
}

export async function scanSessionCatalog(root, { cwd = process.cwd(), limit = 500 } = {}) {
	const files = [];
	async function visit(directory) {
		let entries;
		try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
		await Promise.all(entries.map(async (entry) => {
			if (entry.name === ".trash") return;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return visit(path);
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
			try {
				const info = await stat(path);
				if (info.size <= 20_000_000) files.push({ path, mtime: info.mtimeMs, size: info.size });
			} catch {}
		}));
	}
	await visit(root);
	files.sort((a, b) => b.mtime - a.mtime);
	const selected = files.slice(0, Math.max(1, limit));
	const live = new Set(selected.map((file) => file.path));
	const items = await Promise.all(selected.map(async (file) => {
		const cached = metadataCache.get(file.path);
		if (cached && cached.mtimeMs === file.mtime && cached.size === file.size) {
			return { ...file, cwd: cached.cwd, name: cached.name, id: sessionId(file.path) };
		}
		const metadata = await readMetadata(file.path, cwd, file.size);
		const item = {
			...file,
			cwd: metadata.sessionCwd,
			name: clean(metadata.name || metadata.firstPrompt).slice(0, 120),
			id: sessionId(file.path),
		};
		metadataCache.set(file.path, { mtimeMs: file.mtime, size: file.size, cwd: item.cwd, name: item.name });
		return item;
	}));
	for (const path of metadataCache.keys()) {
		if (!live.has(path)) metadataCache.delete(path);
	}
	return items;
}

function sessionId(path) {
	return basename(path, ".jsonl").split("_").at(-1)?.slice(0, 12) || basename(path, ".jsonl");
}

export async function trashSession(root, path) {
	const absoluteRoot = resolve(root);
	const absolutePath = resolve(path);
	if (!absolutePath.startsWith(`${absoluteRoot}/`)) throw new Error("Session is outside the session directory.");
	const trash = join(absoluteRoot, ".trash");
	await mkdir(trash, { recursive: true, mode: 0o700 });
	const target = join(trash, `${Date.now()}-${basename(absolutePath)}`);
	await rename(absolutePath, target);
	return target;
}

export function filterSessionCatalog(items, { query = "", workspace, currentOnly = false } = {}) {
	const needle = String(query).trim().toLocaleLowerCase();
	return (Array.isArray(items) ? items : []).filter((item) => {
		if (currentOnly && resolve(item.cwd) !== resolve(workspace || ".")) return false;
		if (!needle) return true;
		return `${item.name} ${item.cwd} ${item.id}`.toLocaleLowerCase().includes(needle);
	});
}
