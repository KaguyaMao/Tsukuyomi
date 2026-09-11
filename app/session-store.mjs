import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

function clean(value) {
	return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function messageText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text").map((part) => part.text || "").join(" ");
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
	const items = await Promise.all(selected.map(async (file) => {
		let sessionCwd = cwd;
		let name = "";
		let firstPrompt = "";
		try {
			const data = await readFile(file.path, "utf8");
			for (const line of data.split("\n")) {
				let entry; try { entry = JSON.parse(line); } catch { continue; }
				if (entry?.type === "session" && typeof entry.cwd === "string") sessionCwd = resolve(cwd, entry.cwd);
				if (entry?.type === "session_info" && typeof entry.name === "string") name = entry.name;
				if (!firstPrompt && entry?.type === "message" && entry.message?.role === "user") firstPrompt = messageText(entry.message.content);
			}
		} catch {}
		return {
			...file,
			cwd: sessionCwd,
			name: clean(name || firstPrompt).slice(0, 120),
			id: basename(file.path, ".jsonl").split("_").at(-1)?.slice(0, 12) || basename(file.path, ".jsonl"),
		};
	}));
	return items;
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
