import { connect } from "node:net";
import { LineBuffer } from "./rpc.mjs";

export class TaskClient {
	constructor(env = process.env) {
		this.env = env;
		this.sequence = 0;
		this.pending = new Map();
		this.listeners = new Set();
		// Same O(n^2) hazard as the RPC pipe: a pty/subagent stream can deliver a
		// large single line, so buffer chunks instead of growing one string.
		this.lineBuffer = new LineBuffer();
		this.drainScheduled = undefined;
		// TSUKUYOMI_* wins; KAGUYAPI_* is read once for in-flight upgrades.
		this.socketPath = env.TSUKUYOMI_TASK_SOCKET || env.KAGUYAPI_TASK_SOCKET;
		this.token = env.TSUKUYOMI_TASK_TOKEN || env.KAGUYAPI_TASK_TOKEN;
	}
	async connect() {
		if (this.ready) return this.ready;
		this.ready = new Promise((resolve, reject) => {
			if (!this.socketPath) { reject(new Error("Task service unavailable; launch through tsukuyomi")); return; }
			this.socket = connect(this.socketPath);
			this.socket.once("connect", resolve); this.socket.once("error", reject);
			this.socket.on("error", () => {});
			this.socket.on("close", () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Task service disconnected")); } this.pending.clear(); });
			this.socket.on("data", (data) => this.#consume(data));
		}); return this.ready;
	}
	#consume(chunk) {
		this.lineBuffer.push(chunk);
		if (this.drainScheduled) return;
		const { lines, more } = this.lineBuffer.drain({ maxLines: 32, maxMs: 4 });
		for (const line of lines) this.#handleLine(line);
		if (more) {
			this.drainScheduled = setImmediate(() => { this.drainScheduled = undefined; this.#consume(undefined); });
			this.drainScheduled.unref?.();
		}
	}
	#handleLine(line) {
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line) return;
		let message;
		try { message = JSON.parse(line); } catch { return; }
		const p = this.pending.get(message.id);
		if (p) { this.pending.delete(message.id); clearTimeout(p.timer); if (message.error) p.reject(new Error(message.error)); else p.resolve(message.result); }
		else if (message.event) for (const listener of this.listeners) listener(message);
	}
	async request(method, params = {}) {
		await this.connect(); const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Task ${method} timed out`)); }, 30000);
			this.pending.set(id, { resolve, reject, timer });
			this.socket.write(`${JSON.stringify({ id, token: this.token, method, params })}\n`);
		});
	}
	onEvent(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
	close() { this.socket?.destroy(); }
}
