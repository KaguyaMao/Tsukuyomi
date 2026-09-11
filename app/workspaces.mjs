import { realpathSync } from "node:fs";
import { PiRpc } from "./rpc.mjs";

export function sessionlessArgs(args) {
	const out = [];
	for (let i = 0; i < args.length; i++) {
		if (["--session", "--session-id", "--resume", "-r"].includes(args[i])) { if (args[i + 1] && !args[i + 1].startsWith("-")) i++; continue; }
		if (["--continue", "-c"].includes(args[i]) || /^--(?:session|session-id|resume)=/.test(args[i])) continue;
		out.push(args[i]);
	}
	return out;
}

/** Kernels outlive their mounted view, but never outlive the application. */
export class WorkspacePool {
	constructor() { this.entries = new Map(); }
	acquire({ cwd, piBin, args, env }) {
		const key = realpathSync(cwd);
		let entry = this.entries.get(key);
		if (entry?.dead) { this.entries.delete(key); entry = undefined; }
		if (!entry) {
			const rpc = new PiRpc(piBin, args, env, key);
			entry = { key, rpc, active: false, pending: [], working: false, state: undefined, draft: "", error: "" };
			entry.record = (event) => {
				if (event.type === "agent_start") entry.working = true;
				if (event.type === "agent_settled") entry.working = false;
				if (entry.active) return;
				if (event.type === "tool_execution_update") {
					const old = entry.pending.findIndex((e) => e.type === event.type && e.toolCallId === event.toolCallId);
					if (old >= 0) entry.pending.splice(old, 1);
				}
				if (event.type === "message_end") entry.pending = entry.pending.filter((e) => e.type !== "message_update");
				entry.pending.push(event);
			};
			rpc.onEvent(entry.record);
			entry.onExit = ({ error }) => { entry.dead = true; entry.working = false; entry.error = error.message; };
			rpc.onExit(entry.onExit);
			this.entries.set(key, entry);
		}
		entry.active = true;
		return entry;
	}
	park(entry, state, draft) {
		entry.state = { ...state, stopped: false, mouseZones: [], pointer: undefined, panelScrollbarDrag: undefined, transcriptScrollbarDrag: undefined };
		entry.draft = draft; entry.active = false;
		entry.rpc.listeners.clear(); entry.rpc.listeners.add(entry.record);
		entry.rpc.stderrListeners.clear();
		entry.rpc.exitListeners.clear(); entry.rpc.exitListeners.add(entry.onExit);
	}
	remove(cwd) { const key = realpathSync(cwd); this.entries.get(key)?.rpc.stop(); this.entries.delete(key); }
	list() { return [...this.entries.values()].map((e) => ({ cwd: e.key, working: e.working, waiting: e.pending.some((event) => event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)), error: e.error })); }
	stop() { for (const entry of this.entries.values()) entry.rpc.stop(); this.entries.clear(); }
}
