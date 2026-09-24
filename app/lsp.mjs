import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve, join, dirname, extname, relative, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const digest = (text) => createHash("sha256").update(text).digest("hex");
const defaults = {
	typescript: { command: "typescript-language-server", args: ["--stdio"], fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"], rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"] },
	python: { command: "pyright-langserver", args: ["--stdio"], fileTypes: [".py"], rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", ".venv"] },
	rust: { command: "rust-analyzer", args: [], fileTypes: [".rs"], rootMarkers: ["Cargo.toml"] },
	go: { command: "gopls", args: ["serve"], fileTypes: [".go"], rootMarkers: ["go.mod", "go.work"] },
};
const languages = { ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".rs": "rust", ".go": "go" };
function readConfig(file) { if (!existsSync(file)) return {}; try { const value = JSON.parse(readFileSync(file, "utf8")); return value.servers || value; } catch { throw new Error(`Invalid LSP configuration: ${file}`); } }
export function lspConfig(cwd, agentDir) {
	const servers = { ...defaults };
	for (const file of [join(agentDir, "lsp.json")]) {
		for (const [name, value] of Object.entries(readConfig(file))) servers[name] = { ...servers[name], ...value };
	}
	return servers;
}
function binary(command, cwd) {
	const candidates = isAbsolute(command) ? [command] : [join(cwd, "node_modules/.bin", command), join(cwd, ".venv/bin", command), join(cwd, "venv/bin", command), ...(process.env.PATH || "").split(":").map((dir) => join(dir, command))];
	return candidates.find((path) => { try { return statSync(path).isFile(); } catch { return false; } });
}

export class LspClient {
	constructor(command, args, cwd, config = {}) {
		this.config = config; this.cwd = cwd; this.sequence = 0; this.pending = new Map(); this.diagnostics = new Map(); this.documents = new Map(); this.buffer = Buffer.alloc(0); this.status = "starting";
		this.child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.child.stdout.on("data", (chunk) => this.consume(chunk));
		this.child.stderr.on("data", () => {});
		this.child.on("error", (error) => this.fail(error));
		this.child.on("exit", () => this.fail(new Error("Language server exited")));
	}
	write(message) { const body = JSON.stringify({ jsonrpc: "2.0", ...message }); this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); }
	notify(method, params) { this.write({ method, params }); }
	consume(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		if (this.buffer.length > 32 * 1024 * 1024) { this.fail(new Error("Oversized LSP frame")); this.stop(); return; }
		for (;;) {
			const end = this.buffer.indexOf("\r\n\r\n"); if (end < 0) return;
			const match = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString());
			if (!match) { this.fail(new Error("Invalid LSP frame")); this.stop(); return; }
			const length = Number(match[1]); if (this.buffer.length < end + 4 + length) return;
			let message; try { message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length)); } catch { this.stop(); return; }
			this.buffer = this.buffer.subarray(end + 4 + length);
			if (message.method === "textDocument/publishDiagnostics") this.diagnostics.set(message.params.uri, message.params);
			if (message.method && message.id !== undefined) {
				let result = null;
				if (message.method === "workspace/configuration") result = message.params.items.map(({ section }) => section?.split(".").reduce((v, k) => v?.[k], this.config.settings) || {});
				if (message.method === "workspace/workspaceFolders") result = [{ uri: pathToFileURL(this.cwd).href, name: this.cwd }];
				if (message.method === "workspace/applyEdit") result = { applied: false, failureReason: "Use the preview/apply LSP tool" };
				this.write({ id: message.id, result });
			} else if (message.id !== undefined) {
				const request = this.pending.get(message.id); if (!request) continue;
				this.pending.delete(message.id); request.cleanup();
				if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
			}
		}
	}
	request(method, params, signal, timeout = 15000) {
		if (signal?.aborted) return Promise.reject(new Error("LSP request cancelled"));
		if (this.status === "stopped") return Promise.reject(new Error("Language server is stopped"));
		const id = ++this.sequence;
		return new Promise((resolvePromise, reject) => {
			const cancel = () => { if (!this.pending.delete(id)) return; cleanup(); this.notify("$/cancelRequest", { id }); reject(new Error(`LSP ${method} cancelled or timed out`)); };
			const timer = setTimeout(cancel, timeout);
			const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
			this.pending.set(id, { resolve: resolvePromise, reject, cleanup }); signal?.addEventListener("abort", cancel, { once: true });
			this.write({ id, method, params });
		});
	}
	async initialize(signal) {
		const result = await this.request("initialize", { processId: process.pid, rootUri: pathToFileURL(this.cwd).href, workspaceFolders: [{ uri: pathToFileURL(this.cwd).href, name: this.cwd }], capabilities: { workspace: { configuration: true, workspaceFolders: true, workspaceEdit: { documentChanges: true } }, textDocument: { publishDiagnostics: { versionSupport: true }, synchronization: { didSave: true }, diagnostic: {} }, general: { positionEncodings: ["utf-16"] } }, initializationOptions: this.config.initOptions }, signal);
		this.capabilities = result?.capabilities || {}; this.notify("initialized", {}); this.notify("workspace/didChangeConfiguration", { settings: this.config.settings || {} }); this.status = "ready";
	}
	open(file) {
		const uri = pathToFileURL(file).href, text = readFileSync(file, "utf8"), old = this.documents.get(uri);
		if (old?.text === text) return uri;
		const version = (old?.version || 0) + 1;
		this.documents.set(uri, { text, version }); this.diagnostics.delete(uri);
		if (old) this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
		else this.notify("textDocument/didOpen", { textDocument: { uri, version, languageId: this.config.languageId || languages[extname(file)] || "plaintext", text } });
		this.notify("textDocument/didSave", { textDocument: { uri }, text }); return uri;
	}
	fail(error) { this.status = "stopped"; for (const item of this.pending.values()) { item.cleanup(); item.reject(error); } this.pending.clear(); }
	stop() { this.fail(new Error("Language server stopped")); this.child.kill("SIGTERM"); const child = this.child; setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 500).unref(); }
}

export function applyTextEdits(text, edits) {
	const offsets = [0]; for (let i = 0; i < text.length; i++) if (text[i] === "\n") offsets.push(i + 1);
	const offset = (position) => { const start = offsets[position.line]; if (start === undefined || position.character < 0 || start + position.character > (offsets[position.line + 1] ?? text.length + 1) - 1) throw new Error("Invalid LSP edit range"); return start + position.character; };
	const ordered = edits.map((edit) => ({ start: offset(edit.range.start), end: offset(edit.range.end), text: edit.newText })).sort((a, b) => b.start - a.start || b.end - a.end);
	let boundary = text.length;
	for (const edit of ordered) { if (edit.start > edit.end || edit.end > boundary) throw new Error("Overlapping LSP edits"); text = text.slice(0, edit.start) + edit.text + text.slice(edit.end); boundary = edit.start; }
	return text;
}

export class LspManager {
	constructor(cwd, agentDir) { this.cwd = realpathSync(cwd); this.config = lspConfig(cwd, agentDir); this.clients = new Map(); this.previews = new Map(); }
	file(value) {
		const path = realpathSync(value.startsWith("file:") ? fileURLToPath(value) : resolve(this.cwd, value));
		const rel = relative(this.cwd, path); if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("LSP path is outside this workspace"); return path;
	}
	async client(file, signal) {
		const match = Object.entries(this.config).find(([, config]) => !config.disabled && config.fileTypes?.includes(extname(file)) && (config.rootMarkers || []).some((marker) => existsSync(join(this.cwd, marker))));
		if (!match) throw new Error(`No LSP configured for ${extname(file)}; configure .tsukuyomi/lsp.json`);
		const [name, config] = match; let client = this.clients.get(name);
		if (!client || client.status === "stopped") {
			const command = binary(config.command, this.cwd); if (!command) throw new Error(`Install ${config.command} or configure its absolute path in lsp.json`);
			client = new LspClient(command, config.args || [], this.cwd, config); this.clients.set(name, client);
			client.ready = client.initialize(signal).catch((error) => { client.stop(); throw error; });
		}
		await client.ready; return client;
	}
	preview(edit, client) {
		const changes = { ...(edit.changes || {}) };
		for (const change of edit.documentChanges || []) {
			if (!change.textDocument) throw new Error("LSP file create/delete/rename operations are not supported; use symbol rename");
			const doc = client.documents.get(change.textDocument.uri);
			if (change.textDocument.version != null && doc?.version !== change.textDocument.version) throw new Error("Stale LSP document version");
			changes[change.textDocument.uri] = [...(changes[change.textDocument.uri] || []), ...change.edits];
		}
		const files = Object.entries(changes).map(([uri, edits]) => { const path = this.file(uri), before = readFileSync(path, "utf8"); return { path, before, hash: digest(before), after: applyTextEdits(before, edits) }; });
		const token = randomUUID(); this.previews.set(token, { files, createdAt: Date.now() });
		while (this.previews.size > 32) this.previews.delete(this.previews.keys().next().value);
		return { token, diff: files.map((f) => `--- ${relative(this.cwd, f.path)}\n+++ ${relative(this.cwd, f.path)}\n${f.before.split("\n").map((s) => `-${s}`).join("\n")}\n${f.after.split("\n").map((s) => `+${s}`).join("\n")}`).join("\n"), files: files.map((f) => relative(this.cwd, f.path)), applied: false };
	}
	apply(token) {
		const preview = this.previews.get(token); if (!preview || Date.now() - preview.createdAt > 10 * 60_000) throw new Error("LSP preview expired; request a new preview");
		for (const f of preview.files) if (this.file(f.path) !== f.path || digest(readFileSync(f.path, "utf8")) !== f.hash) throw new Error("File changed after preview; request a new preview");
		const written = [], staged = [];
		try {
			for (const f of preview.files) { const temp = `${f.path}.${token}.lsp-tmp`; writeFileSync(temp, f.after, { flag: "wx", mode: statSync(f.path).mode }); staged.push(temp); }
			for (let i = 0; i < preview.files.length; i++) { const f = preview.files[i]; if (digest(readFileSync(f.path, "utf8")) !== f.hash) throw new Error("Concurrent file modification"); renameSync(staged[i], f.path); written.push(f); }
		} catch (error) {
			for (const f of written.reverse()) if (readFileSync(f.path, "utf8") === f.after) writeFileSync(f.path, f.before);
			throw error;
		} finally { for (const file of staged) if (existsSync(file)) unlinkSync(file); }
		this.previews.delete(token); return { applied: true, files: preview.files.map((f) => relative(this.cwd, f.path)) };
	}
	async execute(params, signal) {
		const { action } = params;
		if (action === "status") return Object.entries(this.config).map(([name, c]) => ({ name, command: c.command, installed: !!binary(c.command, this.cwd), status: this.clients.get(name)?.status || "not started", disabled: !!c.disabled }));
		if (params.apply) { if (!params.token) throw new Error("Applying an LSP edit requires the token from a preview"); return this.apply(params.token); }
		const file = this.file(params.file || ""), client = await this.client(file, signal), uri = client.open(file);
		const document = { uri }, position = { line: Math.max(0, (params.line || 1) - 1), character: Math.max(0, (params.column || 1) - 1) };
		if (action === "diagnostics") {
			if (client.capabilities.diagnosticProvider) { const result = await client.request("textDocument/diagnostic", { textDocument: document }, signal, 5000); return result.items || []; }
			const version = client.documents.get(uri)?.version;
			const deadline = Date.now() + 2500;
			while (Date.now() < deadline && !signal?.aborted) {
				const result = client.diagnostics.get(uri);
				if (result && (result.version == null || result.version >= version)) return result.diagnostics;
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
			}
			return { pending: true, message: "Diagnostics not available yet" };
		}
		const methods = { definition: "textDocument/definition", references: "textDocument/references", hover: "textDocument/hover", symbols: "textDocument/documentSymbol", workspace_symbols: "workspace/symbol", rename: "textDocument/rename", format: "textDocument/formatting", code_actions: "textDocument/codeAction" };
		if (!methods[action]) throw new Error(`Unknown LSP action: ${action}`);
		const request = { textDocument: document, position, context: { includeDeclaration: true, diagnostics: client.diagnostics.get(uri)?.diagnostics || [] }, query: params.query || "", newName: params.newName, options: { tabSize: 4, insertSpaces: true }, range: { start: position, end: position } };
		const result = await client.request(methods[action], request, signal);
		if (action === "rename") return this.preview(result || {}, client);
		if (action === "format") return this.preview({ changes: { [uri]: result || [] } }, client);
		if (action === "code_actions") return (result || []).map((item) => ({ title: item.title, ...(item.edit ? this.preview(item.edit, client) : { unsupported: "This action requires a server command" }) }));
		return result;
	}
	stop() { for (const client of this.clients.values()) client.stop(); this.clients.clear(); }
}
