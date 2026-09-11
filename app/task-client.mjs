import { connect } from "node:net";

export class TaskClient {
	constructor(env = process.env) {
		this.env = env;
		this.sequence = 0;
		this.pending = new Map();
		this.listeners = new Set();
		this.buffer = "";
		// TSUKUYOMI_* wins; KAGUYAPI_* is read once for in-flight upgrades.
		this.socketPath = env.TSUKUYOMI_TASK_SOCKET || env.KAGUYAPI_TASK_SOCKET;
		this.token = env.TSUKUYOMI_TASK_TOKEN || env.KAGUYAPI_TASK_TOKEN;
	}
	async connect() {
		if (this.ready) return this.ready;
		this.ready = new Promise((resolve, reject) => {
			if (!this.socketPath) { reject(new Error("Task service unavailable; launch through tsukuyomi")); return; }
			this.socket = connect(this.socketPath);
			this.socket.setEncoding("utf8"); this.socket.once("connect", resolve); this.socket.once("error", reject);
			this.socket.on("error", () => {});
			this.socket.on("close", () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Task service disconnected")); } this.pending.clear(); });
			this.socket.on("data", (data) => {
				this.buffer += data;
				for (;;) {
					const end = this.buffer.indexOf("\n"); if (end < 0) break;
					const message = JSON.parse(this.buffer.slice(0, end)); this.buffer = this.buffer.slice(end + 1);
					const p = this.pending.get(message.id);
					if (p) { this.pending.delete(message.id); clearTimeout(p.timer); if (message.error) p.reject(new Error(message.error)); else p.resolve(message.result); }
					else if (message.event) for (const listener of this.listeners) listener(message);
				}
			});
		}); return this.ready;
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
