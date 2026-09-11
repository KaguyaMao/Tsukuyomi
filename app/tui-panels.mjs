function textPart(part) {
	if (typeof part === "string") return part;
	if (!part || typeof part !== "object") return "";
	if (typeof part.text === "string") return part.text;
	if (part.type === "image") return "[image]";
	return "";
}

/** Flatten PI tool results into terminal-safe display text (sanitizing happens later). */
export function toolResultText(result) {
	if (result == null) return "";
	if (typeof result === "string") return result;
	if (Array.isArray(result)) return result.map(textPart).filter(Boolean).join("\n");
	if (typeof result.output === "string") return result.output;
	if (typeof result.text === "string") return result.text;
	if (Array.isArray(result.content)) return result.content.map(textPart).filter(Boolean).join("\n");
	if (typeof result.error === "string") return result.error;
	if (typeof result.errorMessage === "string") return result.errorMessage;
	return "";
}

/** OpenCode TodoItem status mapping for Tsukuyomi's boolean todo protocol. */
export function todoStatuses(todos, working = false) {
	let activeAssigned = false;
	return (Array.isArray(todos) ? todos : []).map((todo, index) => {
		let status = todo?.done ? "completed" : "pending";
		if (working && !todo?.done && !activeAssigned) {
			status = "in_progress";
			activeAssigned = true;
		}
		return { ...todo, id: todo?.id ?? String(index), status };
	});
}

/** Collapse potentially huge tool output using OpenCode's ten-line convention. */
export function collapseToolOutput(value, maxLines = 10, maxChars = Number.POSITIVE_INFINITY) {
	const text = String(value ?? "").replace(/\r\n?/g, "\n").trimEnd();
	if (!text) return { text: "", lines: [], overflow: false };
	const source = text.split("\n");
	const lineLimit = Math.max(1, Math.floor(maxLines));
	const charLimit = Math.max(1, Number(maxChars) || 1);
	const lines = [];
	let chars = 0;
	let overflow = false;
	for (const line of source) {
		if (lines.length >= lineLimit || chars + line.length > charLimit) {
			overflow = true;
			break;
		}
		lines.push(line);
		chars += line.length + 1;
	}
	if (lines.length < source.length) overflow = true;
	return { text: lines.join("\n"), lines, overflow };
}

/** Classify unified-diff lines so terminal renderers can apply semantic color. */
export function semanticDiffLines(value) {
	let oldLine; let newLine;
	return String(value ?? "").replace(/\r\n?/g, "\n").split("\n").map((text) => {
		const hunk = text.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
		if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { text, kind: "meta" }; }
		if (text.startsWith("@@")) return { text, kind: "meta" };
		if (text.startsWith("+++") || text.startsWith("---")) return { text, kind: "meta" };
		if (text.startsWith("+")) return { text, kind: "add", newLine: newLine++ };
		if (text.startsWith("-")) return { text, kind: "remove", oldLine: oldLine++ };
		const line = { text, kind: "context", oldLine, newLine };
		if (oldLine != null) oldLine++;
		if (newLine != null) newLine++;
		return line;
	});
}

/** Build Grok-style dock rows from the capabilities the PI RPC exposes. */
export function buildDockRows({ workflow = [], todos = [], queued = 0, working = false, expanded = true, maxTaskRows = 2 }) {
	const running = workflow.filter((item) => item?.status === "running");
	const todo = working ? todoStatuses(todos, true).find((item) => item.status === "in_progress") : undefined;
	const tasks = running.length
		? running.map((item) => ({ id: item.id, kind: item.name || "Tool", description: item.label || item.summary || item.name || "Tool", startedAt: item.startedAt }))
		: todo ? [{ id: `todo-${todo.id}`, kind: "Todo", description: todo.text || "Task" }] : [];
	const rows = [];
	if (tasks.length) {
		rows.push({ kind: "header", section: "tasks", count: tasks.length, expanded });
		if (expanded) {
			const shown = tasks.slice(0, Math.max(1, Math.floor(maxTaskRows)));
			for (const task of shown) rows.push({ kind: "task", section: "tasks", task });
			if (shown.length < tasks.length) rows.push({ kind: "more", section: "tasks", count: tasks.length - shown.length });
		}
	}
	const queueCount = Math.max(0, Math.floor(Number(queued) || 0));
	if (queueCount) rows.push({ kind: "header", section: "queued", count: queueCount, expanded: false });
	return rows;
}
