/**
 * Per-message transcript history cache.
 *
 * Grok Build caches each scrollback entry independently. Tsukuyomi does the same
 * for chat messages: a tool-output chunk only re-renders the messages that own
 * that tool. Walking signatures is O(messages) and cheap; wrapping and painting
 * stay off the per-frame path for unchanged history. Viewport materialization
 * copies only intersecting segments (O(viewport)).
 */

export function createHistoryCache() {
	return {
		layoutKey: "",
		source: undefined,
		thinkingKey: "",
		lastWorkMs: undefined,
		lastThoughtMs: undefined,
		lastAssistantIndex: -1,
		omitUserIndex: -1,
		entries: new Map(),
		segments: [],
		blocks: [],
		userBlocks: [],
		blockIndex: new Map(),
		toolIds: new Set(),
		toolRanges: [],
		toolMessageIndex: new Map(),
		toolResults: new Map(),
		total: 0,
		rendered: 0,
		reused: 0,
		assembles: 0,
		didAssemble: false,
	};
}

export function historyLayoutKey({ width, terminalRows, omitUserIndex, locale }) {
	return `${width}|${terminalRows}|${omitUserIndex ?? ""}|${locale}`;
}

export function thinkingCacheKey(thinkingAutoCollapse, thinkingExpanded) {
	if (!thinkingExpanded || thinkingExpanded.size === 0) return thinkingAutoCollapse ? "1" : "0";
	return `${thinkingAutoCollapse ? 1 : 0}:${[...thinkingExpanded].sort((a, b) => a - b).join(",")}`;
}

export function collectToolResults(messages) {
	const map = new Map();
	for (const message of Array.isArray(messages) ? messages : []) {
		if (message?.role === "toolResult") map.set(message.toolCallId, message);
	}
	return map;
}

export function indexToolMessages(messages) {
	const map = new Map();
	const list = Array.isArray(messages) ? messages : [];
	for (let index = 0; index < list.length; index++) {
		const message = list[index];
		if (!message || message.role !== "assistant") continue;
		for (const part of Array.isArray(message.content) ? message.content : []) {
			if (part?.type !== "toolCall" || part.name === "todo") continue;
			const id = part.id || part.toolCallId;
			if (!id) continue;
			const owners = map.get(id) ?? [];
			owners.push(index);
			map.set(id, owners);
		}
	}
	return map;
}

export function liveToolSignature(tool, now = 0) {
	if (!tool) return "0";
	const elapsed = tool.status === "running" && tool.startedAt
		? Math.floor(((now || 0) - tool.startedAt) / 1000)
		: 0;
	return `${tool.revision ?? 0}:${tool.expanded ? 1 : 0}:${tool.offset ?? 0}:${elapsed}`;
}

function partIdentity(part) {
	if (!part) return "";
	if (part.type === "text") {
		const text = part.text || "";
		return `t${text.length}:${text.slice(0, 24)}:${text.slice(-16)}`;
	}
	if (part.type === "thinking") return `h${(part.thinking || "").length}`;
	if (part.type === "toolCall") return `c${part.id || part.toolCallId || ""}:${part.name || ""}`;
	return part.type || "";
}

export function messageIdentity(message) {
	if (!message) return "";
	if (message.id != null) return `${message.role}:${message.id}`;
	const content = message.content;
	if (typeof content === "string") {
		return `${message.role}:${message.timestamp ?? ""}:${content.length}:${content.slice(0, 32)}`;
	}
	if (Array.isArray(content)) {
		return `${message.role}:${message.timestamp ?? ""}:${content.map(partIdentity).join("|")}`;
	}
	return `${message.role}:${message.timestamp ?? ""}:${message.command ?? ""}:${message.output?.length ?? 0}`;
}

export function messageSignature(message, {
	index,
	lastAssistantIndex,
	liveTools,
	thinkingAutoCollapse,
	thinkingExpanded,
	lastWorkMs,
	lastThoughtMs,
	now = 0,
} = {}) {
	const identity = messageIdentity(message);
	if (!message || message.role !== "assistant") return identity;
	const tools = [];
	let thinking = "-";
	for (const part of Array.isArray(message.content) ? message.content : []) {
		if (part?.type === "toolCall" && part.name !== "todo") {
			const id = part.id || part.toolCallId;
			if (id) tools.push(`${id}:${liveToolSignature(liveTools?.get(id), now)}`);
		} else if (part?.type === "thinking") {
			thinking = thinkingAutoCollapse && !thinkingExpanded?.has(index) ? "c" : "e";
		}
	}
	const last = index === lastAssistantIndex ? `w${lastWorkMs ?? ""}:t${lastThoughtMs ?? ""}` : "";
	return `${identity}|${tools.join(",")}|${thinking}|${last}`;
}

function renderIndex(cache, index, message, ctx) {
	const rendered = ctx.renderMessage(index, message, cache);
	if (!rendered) {
		cache.entries.delete(index);
		return;
	}
	const signature = messageSignature(message, {
		index,
		lastAssistantIndex: cache.lastAssistantIndex,
		liveTools: ctx.liveTools,
		thinkingAutoCollapse: ctx.thinkingAutoCollapse,
		thinkingExpanded: ctx.thinkingExpanded,
		lastWorkMs: ctx.lastWorkMs,
		lastThoughtMs: ctx.lastThoughtMs,
		now: ctx.now,
	});
	cache.entries.set(index, { signature, message, lines: rendered.lines, block: rendered.block, localToolRanges: rendered.localToolRanges || [] });
	cache.rendered += 1;
}

export function assembleHistory(cache, messages) {
	let total = 0;
	const segments = [];
	const blocks = [];
	const userBlocks = [];
	const toolRanges = [];
	const toolIds = new Set();
	const blockIndex = new Map();
	const list = Array.isArray(messages) ? messages : [];
	for (let index = 0; index < list.length; index++) {
		const message = list[index];
		if (!message) continue;
		if (message.role === "user" && index === cache.omitUserIndex) continue;
		const entry = cache.entries.get(index);
		if (!entry) continue;
		const start = total;
		total += entry.lines.length;
		if (entry.block) {
			const block = { ...entry.block, start, end: total };
			blocks.push(block);
			if (block.kind === "user") userBlocks.push(block);
			blockIndex.set(`${block.kind}:${block.messageIndex}`, block);
		}
		for (const range of entry.localToolRanges || []) {
			toolRanges.push({ id: range.id, start: start + range.start, end: start + range.end });
			toolIds.add(range.id);
		}
		segments.push({ start, end: total, lines: entry.lines });
	}
	let assistantSeen = false;
	for (let index = blocks.length - 1; index >= 0; index--) {
		const block = blocks[index];
		if (block.kind === "assistant") assistantSeen = true;
		else if (block.kind === "user") block.replied = assistantSeen;
	}
	cache.total = total;
	cache.segments = segments;
	cache.blocks = blocks;
	cache.userBlocks = userBlocks;
	cache.blockIndex = blockIndex;
	cache.toolIds = toolIds;
	cache.toolRanges = toolRanges;
	cache.assembles += 1;
	cache.didAssemble = true;
}

/**
 * Re-render only messages whose signature changed.
 *
 * Fast path: same message array, layout, thinking bits, and no dirty tools —
 * reuse the previous segments without walking signatures. Dirty-tool path
 * re-renders just the owning messages. Replacing the messages array (RPC
 * refresh) walks signatures so equivalent content still hits.
 */
export function syncHistoryCache(cache, ctx) {
	const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
	const layoutKey = ctx.layoutKey;
	const omitUserIndex = ctx.omitUserIndex ?? -1;
	const thinkingKey = thinkingCacheKey(ctx.thinkingAutoCollapse, ctx.thinkingExpanded);
	const lastAssistantIndex = messages.findLastIndex((message) => message?.role === "assistant");
	cache.rendered = 0;
	cache.reused = 0;
	cache.didAssemble = false;
	cache.omitUserIndex = omitUserIndex;
	cache.lastAssistantIndex = lastAssistantIndex;

	const layoutChanged = cache.layoutKey !== layoutKey;
	if (layoutChanged) {
		cache.entries.clear();
		cache.toolMessageIndex = new Map();
		cache.elapsedByTool = new Map();
		cache.layoutKey = layoutKey;
	}

	const dirty = ctx.dirtyToolIds;
	const touched = new Set();
	if (dirty?.size) {
		if (!cache.toolMessageIndex.size) cache.toolMessageIndex = indexToolMessages(messages);
		for (const id of dirty) {
			for (const index of cache.toolMessageIndex.get(id) ?? []) touched.add(index);
		}
		dirty.clear();
	}
	const lastMetaChanged = cache.lastWorkMs !== ctx.lastWorkMs || cache.lastThoughtMs !== ctx.lastThoughtMs;
	if (lastMetaChanged && lastAssistantIndex >= 0) touched.add(lastAssistantIndex);
	cache.lastWorkMs = ctx.lastWorkMs;
	cache.lastThoughtMs = ctx.lastThoughtMs;
	if (ctx.liveTools?.size && cache.toolMessageIndex.size) {
		cache.elapsedByTool ??= new Map();
		const now = ctx.now || 0;
		for (const [id, tool] of ctx.liveTools) {
			if (tool.status !== "running") continue;
			const elapsed = Math.floor((now - (tool.startedAt || 0)) / 1000);
			if (cache.elapsedByTool.get(id) !== elapsed) {
				cache.elapsedByTool.set(id, elapsed);
				for (const index of cache.toolMessageIndex.get(id) ?? []) touched.add(index);
			}
		}
	}

	const sameSource = cache.source === messages;
	const sameThinking = cache.thinkingKey === thinkingKey;
	cache.source = messages;
	cache.thinkingKey = thinkingKey;

	const canPartial = sameSource && !layoutChanged && sameThinking && cache.entries.size > 0;
	if (canPartial && touched.size === 0) {
		cache.reused = cache.entries.size;
		return cache;
	}
	if (canPartial) {
		if (!cache.toolResults.size) cache.toolResults = collectToolResults(messages);
		for (const index of touched) {
			const message = messages[index];
			if (!message) continue;
			renderIndex(cache, index, message, ctx);
		}
		cache.reused = Math.max(0, cache.entries.size - cache.rendered);
		assembleHistory(cache, messages);
		return cache;
	}

	cache.toolResults = collectToolResults(messages);
	cache.toolMessageIndex = indexToolMessages(messages);
	const keep = new Set();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!message) continue;
		if (message.role === "user" && index === omitUserIndex) continue;
		keep.add(index);
		const signature = messageSignature(message, {
			index,
			lastAssistantIndex,
			liveTools: ctx.liveTools,
			thinkingAutoCollapse: ctx.thinkingAutoCollapse,
			thinkingExpanded: ctx.thinkingExpanded,
			lastWorkMs: ctx.lastWorkMs,
			lastThoughtMs: ctx.lastThoughtMs,
			now: ctx.now,
		});
		const existing = cache.entries.get(index);
		if (existing && existing.signature === signature) {
			existing.message = message;
			cache.reused += 1;
			continue;
		}
		renderIndex(cache, index, message, ctx);
	}
	for (const index of cache.entries.keys()) {
		if (!keep.has(index)) cache.entries.delete(index);
	}
	assembleHistory(cache, messages);
	return cache;
}

function locateSegment(segments, index, endField) {
	let low = 0;
	let high = segments.length - 1;
	let found = 0;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const end = endField(segments[mid]);
		if (end <= index) low = mid + 1;
		else {
			found = mid;
			high = mid - 1;
		}
	}
	return found;
}

/**
 * Copy only the intersecting window of history segments plus the live tail.
 * Cost is the window length, not the session length.
 */
export function sliceFlow(historySegments, tailSegments, historyTotal, start, end) {
	const out = [];
	const from = Math.max(0, start);
	const segments = historySegments || [];
	const tails = tailSegments || [];
	let index = from;
	let segmentIndex = segments.length ? locateSegment(segments, index, (segment) => segment.end) : 0;
	let tailIndex = 0;
	if (tails.length) {
		const target = Math.max(0, index - historyTotal);
		tailIndex = locateSegment(tails, target, (segment) => segment.start + segment.rows.length);
	}
	while (index < end) {
		if (index < historyTotal) {
			const segment = segments[segmentIndex];
			if (!segment || index < segment.start) {
				out.push("");
				index += 1;
				continue;
			}
			const segmentEnd = Math.min(segment.end, end);
			while (index < segmentEnd) {
				out.push(segment.lines[index - segment.start]);
				index += 1;
			}
			segmentIndex += 1;
			continue;
		}
		const local = index - historyTotal;
		const tailSegment = tails[tailIndex];
		if (!tailSegment || local < tailSegment.start) {
			out.push("");
			index += 1;
			continue;
		}
		const segmentLocalEnd = tailSegment.start + tailSegment.rows.length;
		while (index < end && index - historyTotal < segmentLocalEnd) {
			const row = tailSegment.rows[index - historyTotal - tailSegment.start];
			out.push(tailSegment.paint ? tailSegment.paint(row ?? "") : (row ?? ""));
			index += 1;
		}
		tailIndex += 1;
	}
	return out;
}
