const CURSOR_HIGHLIGHT_RE = /\x1b\[7m([\s\S]*?)\x1b\[0m/;
const SGR_SEQUENCE = /\x1b\[[0-?]*[ -/]*m/g;
const SGR_SEQUENCE_TEST = /^\x1b\[[0-?]*[ -/]*m$/;
const TERMINAL_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const SCREEN_ROW_CLEAR = /(\x1b\[\d+;1H)\x1b\[2K/g;

function extractSgrBackground(sequence) {
	const body = sequence.slice(2, -1);
	const params = body ? body.split(";") : ["0"];
	let background;
	for (let index = 0; index < params.length; index++) {
		const param = params[index] || "0";
		const code = Number(param.split(":")[0]);
		// Extended foreground and underline colors use the same trailing shape as
		// background colors. Consume their complete payload so an RGB channel such
		// as 44 or 102 is never reinterpreted as a standalone background code.
		if ((code === 38 || code === 58) && !param.includes(":")) {
			if (params[index + 1] === "2" && params.length >= index + 5) index += 4;
			else if (params[index + 1] === "5" && params.length >= index + 3) index += 2;
			continue;
		}
		if (code === 38 || code === 58) continue;
		// SGR 0 resets the terminal, but the row background must be reapplied
		// from the previously active value. SGR 49 explicitly selects default.
		if (code === 49) {
			background = { code: "default" };
			continue;
		}
		if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
			background = { code: "color", value: `\x1b[${code}m` };
			continue;
		}
		if (code !== 48) continue;
		if (param.includes(":")) {
			const parts = param.split(":");
			if (parts[1] === "5" && parts.length >= 3) background = { code: "color", value: `\x1b[48:5:${parts[2]}m` };
			else if (parts[1] === "2" && parts.length >= 5) background = { code: "color", value: `\x1b[${param}m` };
			continue;
		}
		if (params[index + 1] === "2" && params.length >= index + 5) {
			background = { code: "color", value: `\x1b[48;2;${params.slice(index + 2, index + 5).join(";")}m` };
			index += 4;
			continue;
		}
		if (params[index + 1] === "5" && params.length >= index + 3) {
			background = { code: "color", value: `\x1b[48;5;${params[index + 2]}m` };
			index += 2;
		}
	}
	return background;
}

/** Keep display text safe while retaining SGR styling for normal output. */
export function sanitizeTerminalText(value) {
	const sgr = [];
	const text = String(value ?? "").replace(TERMINAL_SEQUENCE, (sequence) => {
		if (!SGR_SEQUENCE_TEST.test(sequence)) return "";
		const index = sgr.push(sequence) - 1;
		return `\uE000${index}\uE001`;
	});
	return text
		.replace(/\x1b/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, "")
		.replace(/\uE000(\d+)\uE001/g, (_match, index) => sgr[Number(index)] || "");
}

/**
 * Apply a full-cell background and restore it after every SGR reset.
 *
 * A rendered prompt may already contain its own background (for example the
 * user-message band). Do not overwrite that explicit background while adding
 * the row's fallback background; doing so makes the band disappear whenever a
 * color span is present.
 */
export function paintBackground(value, background) {
	let activeBackground = background;
	const painted = String(value).replace(SGR_SEQUENCE, (sequence) => {
		const explicit = extractSgrBackground(sequence);
		if (explicit?.code === "default") {
			activeBackground = background;
			return `${sequence}${activeBackground}`;
		}
		if (explicit?.code === "color") {
			activeBackground = explicit.value;
			return sequence;
		}
		return `${sequence}${activeBackground}`;
	});
	return `${background}${painted}\x1b[0m`;
}

export function paintScreenRowClears(value, background) {
	return String(value).replace(SCREEN_ROW_CLEAR, (_match, position) => `${position}${background}\x1b[2K`);
}

/**
 * Adaptive frame cadence, mirroring oh-my-pi/pi-tui's render backpressure.
 *
 * pi-tui's plain cadence is `max(0, minInterval - elapsed)`. A frame that costs
 * more than the interval then makes `elapsed` large, the delay collapse to zero,
 * and the render loop becomes a busy loop that starves keyboard input — worst on
 * a long transcript. Instead the next delay is at least the previous frame's
 * cost (so a heavy frame idles proportionally) while still capped so
 * responsiveness never falls below roughly 5 fps.
 */
export function adaptiveFrameDelay({ minIntervalMs, maxAdaptiveMs, lastCostMs = 0, elapsedMs = 0 }) {
	const cost = Number.isFinite(lastCostMs) && lastCostMs > 0 ? lastCostMs : 0;
	const target = Math.max(minIntervalMs, Math.min(cost, maxAdaptiveMs));
	return Math.max(0, target - Math.max(0, elapsedMs));
}

/**
 * Insertion-order LRU. `get` promotes a hit so a long session of identical
 * chrome rows (borders, blanks, panel titles) never re-runs pad+background
 * painting, while the cache stays bounded.
 */
export function createLruCache(max = 8192) {
	const map = new Map();
	const limit = Math.max(1, Math.floor(max));
	return {
		get(key) {
			if (!map.has(key)) return undefined;
			const value = map.get(key);
			map.delete(key);
			map.set(key, value);
			return value;
		},
		set(key, value) {
			if (map.has(key)) map.delete(key);
			map.set(key, value);
			while (map.size > limit) map.delete(map.keys().next().value);
		},
		has(key) {
			return map.has(key);
		},
		clear() {
			map.clear();
		},
		get size() {
			return map.size;
		},
	};
}

/**
 * Incrementally wrapped text.
 *
 * Long streaming responses were the worst case for the TUI: every frame re-wrapped
 * the entire accumulated text, making a long answer O(n^2) over its lifetime. This
 * cache keeps already-wrapped complete lines (text that ended in a newline can never
 * be reflowed by later text) and only rewraps the trailing partial line. Appending a
 * token is therefore O(token) plus the current tail, not O(whole response).
 *
 * `wrapFn(value, width)` must return the wrapped rows for one logical segment and is
 * expected to be the same word-wrapping routine the renderer uses, so incremental and
 * full wrapping stay identical.
 */
export class IncrementalText {
	constructor(wrapFn) {
		this.wrapFn = wrapFn;
		this.width = 0;
		this.segments = [];
		this.pending = "";
		this.completedRows = [];
		this.allRows = undefined;
		this.committedCount = 0;
		this.tailLength = 0;
	}

	append(delta) {
		if (!delta) return;
		this.pending += delta;
		let newline = this.pending.indexOf("\n");
		while (newline !== -1) {
			const segment = this.pending.slice(0, newline);
			this.pending = this.pending.slice(newline + 1);
			this.segments.push(segment);
			if (this.width > 0) {
				for (const line of this.wrapFn(segment, this.width)) this.completedRows.push(line);
			}
			newline = this.pending.indexOf("\n");
		}
		if (this.width > 0) {
			this.flushPending();
			this.refreshTail();
		}
	}

	/**
	 * Bound the trailing partial line.
	 *
	 * Word wrapping only ever revises its final row: once a row closed because the
	 * next word did not fit, later text cannot change it. So for a very long line
	 * with few breaks we commit every row but the last. Only the final (still-open)
	 * row is rewrapped on subsequent appends, which keeps a single giant paragraph
	 * linear instead of quadratic.
	 */
	flushPending() {
		const limit = this.flushLimit || 0;
		if (!limit || this.pending.length <= limit) return;
		const rows = this.wrapFn(this.pending, this.width);
		if (rows.length <= 1) return;
		for (let index = 0; index < rows.length - 1; index++) this.completedRows.push(rows[index]);
		const last = rows[rows.length - 1].replace(/\x1b\[[0-9;]*m/g, "");
		if ([...last].length <= this.width) this.pending = last;
	}

	// Fold newly completed rows into the materialized array and replace the tail
	// portion, so reading rows() is O(1) and appends stay O(delta + tail).
	refreshTail() {
		if (!this.allRows) {
			this.allRows = [...this.completedRows];
			this.committedCount = this.completedRows.length;
			this.tailLength = 0;
		} else if (this.completedRows.length > this.committedCount) {
			const missing = this.completedRows.length - this.committedCount;
			this.allRows.splice(
				Math.max(0, this.allRows.length - this.tailLength),
				0,
				...this.completedRows.slice(-missing),
			);
			this.committedCount = this.completedRows.length;
		}
		const tail = this.wrapFn(this.pending, this.width);
		if (this.tailLength) this.allRows.splice(this.allRows.length - this.tailLength, this.tailLength, ...tail);
		else this.allRows.push(...tail);
		this.tailLength = tail.length;
	}

	rows(width) {
		if (width !== this.width) {
			this.width = width;
			this.flushLimit = Math.max(512, width * 4);
			this.completedRows = [];
			for (const segment of this.segments) {
				for (const line of this.wrapFn(segment, width)) this.completedRows.push(line);
			}
			this.allRows = undefined;
			this.committedCount = 0;
			this.tailLength = 0;
			this.refreshTail();
		} else if (!this.allRows) {
			this.allRows = [...this.completedRows];
			this.committedCount = this.completedRows.length;
			this.tailLength = 0;
			this.refreshTail();
		}
		// Same array every call at a given width; callers must not mutate it.
		return this.allRows;
	}

	reset() {
		this.segments = [];
		this.pending = "";
		this.completedRows = [];
		this.allRows = undefined;
		this.committedCount = 0;
		this.tailLength = 0;
	}

	/** Read-only count of materialized rows, without forcing a width. */
	get rowCount() {
		return this.allRows?.length ?? 0;
	}
}

/** Remove only the bundled Editor's fake cursor styling, preserving its grapheme. */
export function stripEditorCursorHighlight(lines) {
	return lines.map((line) => line.replace(CURSOR_HIGHLIGHT_RE, "$1"));
}

/** Keep the newest rows of a viewport while retaining a predictable row budget. */
export function limitRows(rows, maxRows) {
	const limit = Math.max(0, Math.floor(maxRows));
	return rows.length > limit ? rows.slice(-limit) : [...rows];
}

/**
 * Calculate a terminal scrollbar. Transcript offsets count from the bottom,
 * while the scrollbar thumb moves from top (oldest) to bottom (newest).
 */
export function scrollbarMetrics({ contentLength, viewportLength, offset = 0, trackLength, minThumbLength = 3 }) {
	const content = Math.max(0, Math.floor(contentLength));
	const viewport = Math.max(0, Math.floor(viewportLength));
	const track = Math.max(0, Math.floor(trackLength));
	const maxOffset = Math.max(0, content - viewport);
	const overflow = maxOffset > 0 && track > 0;
	if (!overflow) {
		return {
			contentLength: content,
			viewportLength: viewport,
			trackLength: track,
			maxOffset,
			offset: 0,
			thumbLength: track,
			maxThumbStart: 0,
			thumbStart: 0,
			overflow: false,
		};
	}
	const thumbLength = Math.min(track, Math.max(1, Math.min(Math.floor(minThumbLength), track), Math.round(track * viewport / content)));
	const maxThumbStart = Math.max(0, track - thumbLength);
	const safeOffset = Math.max(0, Math.min(maxOffset, Math.floor(offset)));
	const thumbStart = Math.round(maxThumbStart * (1 - safeOffset / maxOffset));
	return {
		contentLength: content,
		viewportLength: viewport,
		trackLength: track,
		maxOffset,
		offset: safeOffset,
		thumbLength,
		maxThumbStart,
		thumbStart,
		overflow: true,
	};
}

/**
 * Preserve a bottom-based viewport when transcript content or viewport height
 * changes. When following the tail, the newest row is intentionally kept in
 * view; otherwise the old top row remains anchored by compensating for both
 * content growth and a resize.
 */
export function preserveScrollOffset({
	offset = 0,
	contentLength = 0,
	nextContentLength = 0,
	viewportLength = 0,
	nextViewportLength = 0,
	followTail = false,
}) {
	if (followTail) return 0;
	return Math.max(0, Math.floor(offset) +
		(Math.floor(nextContentLength) - Math.floor(contentLength)) -
		(Math.floor(nextViewportLength) - Math.floor(viewportLength)));
}

/** Convert a thumb start position into the transcript's bottom-based offset. */
export function scrollbarOffsetFromThumbStart(metrics, thumbStart) {
	if (!metrics?.overflow || metrics.maxThumbStart <= 0) return 0;
	const start = Math.max(0, Math.min(metrics.maxThumbStart, Number(thumbStart) || 0));
	return Math.round(metrics.maxOffset * (1 - start / metrics.maxThumbStart));
}

/** Convert a pointer row into an offset, preserving the pointer's grab point. */
export function scrollbarOffsetFromPointer(metrics, pointerRow, grabOffset = 0) {
	if (!metrics?.overflow) return 0;
	const pointer = Number(pointerRow) || 0;
	const grab = Math.max(0, Math.min(metrics.thumbLength, Number(grabOffset) || 0));
	return scrollbarOffsetFromThumbStart(metrics, pointer - grab);
}
