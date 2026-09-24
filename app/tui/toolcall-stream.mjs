/** Assemble Pi's delta-only tool-call protocol; message_end remains authoritative. */
export function createToolCallStream() {
	const parts = new Map();
	return {
		reset() { parts.clear(); },
		accept(event) {
		if (!event || !Number.isSafeInteger(event.contentIndex) || event.contentIndex < 0) return undefined;
		const index = event.contentIndex;
		if (event.type === "toolcall_start") {
			if (typeof event.id !== "string" || !event.id || typeof event.toolName !== "string") return undefined;
			const part = { id: event.id, name: event.toolName, raw: "", args: {} };
			parts.set(index, part);
			return { id: part.id, name: part.name, args: part.args };
		}
		if (event.type === "toolcall_end") {
			const previous = parts.get(index);
			parts.delete(index);
			const result = event.toolCall;
			if (result?.id && result?.name) return { id: result.id, name: result.name, args: result.arguments || {} };
			return previous && { id: previous.id, name: previous.name, args: previous.args };
		}
		if (event.type !== "toolcall_delta") return undefined;
		const part = parts.get(index);
		if (!part) return undefined;
		if (typeof event.delta === "string" && part.raw.length < 131_072) part.raw += event.delta.slice(0, 131_072 - part.raw.length);
		try {
			const args = JSON.parse(part.raw);
			if (args && typeof args === "object" && !Array.isArray(args)) part.args = args;
		} catch { /* incomplete JSON; wait for the next delta or final call */ }
		return { id: part.id, name: part.name, args: part.args };
		},
	};
}
