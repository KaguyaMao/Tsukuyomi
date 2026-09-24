import { isDeepStrictEqual } from "node:util";
import { toolResultText } from "./tui-panels.mjs";
import { redactText } from "./redact.mjs";
import { sanitizeTerminalText } from "./ui-utils.mjs";

export class LiveTool {
	constructor(id) { this.id = id; this.status = "running"; this.args = {}; this.output = ""; this.offset = 0; this.expanded = false; this.revision = 0; this.startedAt = Date.now(); }
	update(event) {
		const previous = { name: this.name, args: this.args, output: this.output, details: this.details, status: this.status, endedAt: this.endedAt };
		if (event.toolName) this.name = event.toolName;
		if (event.args) this.args = event.args;
		const result = event.result ?? event.partialResult;
		if (result !== undefined) {
			const output = sanitizeTerminalText(redactText(toolResultText(result)));
			if (this.offset > 0 && output !== this.output) {
				this.offset += Math.max(0, output.split("\n").length - this.output.split("\n").length);
			}
			this.output = output.slice(-2_000_000);
			this.details = result.details || {};
		}
		if (event.type === "tool_execution_end") { this.status = event.isError ? "error" : "done"; this.endedAt ??= Date.now(); }
		if (this.details?.jobId && !this.details?.endedAt) { this.status = "running"; this.endedAt = undefined; }
		const changed = previous.name !== this.name || previous.output !== this.output ||
			previous.status !== this.status || previous.endedAt !== this.endedAt ||
			!isDeepStrictEqual(previous.args, this.args) || !isDeepStrictEqual(previous.details, this.details);
		if (changed) this.revision++;
		return changed;
	}
	scroll(amount) { this.offset = Math.max(0, Math.min(this.maxOffset || 0, this.offset + amount)); this.revision++; }
	rows(locale = "en", terminalRows = 40) {
		const zh = locale === "zh";
		const elapsed = Math.max(0, Math.floor(((this.endedAt || Date.now()) - this.startedAt) / 1000));
		const rowKey = `${this.revision}|${locale}|${terminalRows}|${this.expanded}|${this.offset}|${elapsed}`;
		if (this.rowKey === rowKey && this.rowCache) return this.rowCache;
		const title = this.args.command || this.args.path || this.args.file || this.args.task || this.args.action || "";
		const icon = this.status === "running" ? "●" : this.status === "error" ? "✖" : "✓";
		const output = [{ kind: "header", text: `${icon} ${this.name || "tool"} ${title} · ${elapsed}s` }];
		// Parsing a megabyte-sized result on every keypress/spinner frame blocks
		// the editor. Only rebuild the body when its source actually changes.
		let body = this.output;
		let diff = this.details?.diff || this.details?.patch;
		if (!diff && ["edit", "write"].includes(this.name) && this.status === "running") {
			const old = this.args.oldText || "", next = this.args.newText ?? this.args.content;
			if (typeof next === "string") {
				if (this.previewOld !== old || this.previewNext !== next) {
					this.previewOld = old;
					this.previewNext = next;
					this.previewDiff = [...old.split("\n").map((s) => `-${s}`), ...next.split("\n").map((s) => `+${s}`)].join("\n");
				}
				diff = this.previewDiff;
			}
		}
		if (diff) {
			output.push({ kind: "meta", text: this.status === "running" || this.details?.applied === false ? (zh ? "修改预览（尚未应用）" : "Preview (not applied)") : this.status === "error" ? (zh ? "修改失败" : "Edit failed") : (zh ? "已应用" : "Applied") });
			if (this.diffSource !== diff) {
				this.diffSource = diff;
				this.diffBody = sanitizeTerminalText(redactText(String(diff)));
			}
			body = this.diffBody;
		}
		if (this.bodySource !== body) {
			this.bodySource = body;
			this.bodyLines = String(body).split("\n");
		}
		const lines = this.bodyLines;
		if (["read", "view"].includes(this.name) && this.status !== "running" && body.trim()) {
			output.push({ kind: "meta", text: `${zh ? "已读取" : "Read"} ${lines.length} ${zh ? "行" : "lines"}` });
		}
		if (this.name === "bash" && this.status === "running" && !body.trim()) {
			output.push({ kind: "meta", text: zh ? "等待命令输出…" : "Waiting for command output…" });
		}
		const height = this.expanded ? Math.max(8, Math.floor(terminalRows * 0.65)) : 8;
		this.maxOffset = Math.max(0, lines.length - height);
		this.offset = Math.min(this.offset, this.maxOffset);
		const end = Math.max(height, lines.length - this.offset), start = Math.max(0, end - height);
		for (const text of lines.slice(start, end)) output.push({ kind: diff && text.startsWith("+") ? "add" : diff && text.startsWith("-") ? "remove" : "text", text });
		if (this.details?.cwd) output.push({ kind: "meta", text: this.details.cwd });
		if (this.details?.exitCode != null) output.push({ kind: "meta", text: `${zh ? "退出码" : "Exit"}: ${this.details.exitCode}` });
		output.push({ kind: "footer", text: `${this.expanded ? "▴" : "▾"} ${zh ? "展开/收起 · 滚轮查看" : "Expand/collapse · scroll"}${this.offset ? ` · ↓ ${zh ? "回到底部" : "Latest"}` : ""}${this.details?.jobId ? ` · ${zh ? "点击进入终端" : "Click to interact"}` : ""} · ${start + 1}–${Math.min(end, lines.length)}/${lines.length}` });
		this.rowKey = rowKey;
		this.rowCache = output;
		return output;
	}
}
