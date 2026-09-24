export const FULL_RAIL_MIN_COLUMNS = 120;
export const TIMELINE_MIN_COLUMNS = 60;
export const SHORT_TERMINAL_ROWS = 16;
export const AUTO_COMPACT_MAX_ROWS = 20;
export const SCROLLBACK_MIN_ROWS = 5;

function integer(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function clamp(value, minimum, maximum) {
	return Math.max(minimum, Math.min(maximum, value));
}

function rect(x, y, width, height) {
	return { x: integer(x), y: integer(y), width: integer(width), height: integer(height) };
}

/**
 * Split the terminal into optional OpenCode-style rails and a Grok-style
 * center view. Persistent rails deliberately follow OpenCode's wide-terminal
 * behavior; on narrower terminals callers present them as overlays.
 */
export function computeWorkspaceLayout({ width, height, showFiles = false, showRight = false }) {
	const columns = Math.max(1, integer(width, 1));
	const rows = Math.max(1, integer(height, 1));
	const persistentPanels = columns >= FULL_RAIL_MIN_COLUMNS;
	const leftWidth = persistentPanels && showFiles
		? clamp(Math.floor(columns * 0.18), 24, 30)
		: 0;
	const rightWidth = persistentPanels && showRight
		? clamp(Math.floor(columns * 0.25), 36, 42)
		: 0;
	const leftSeparator = leftWidth > 0 ? 1 : 0;
	const rightSeparator = rightWidth > 0 ? 1 : 0;
	const centerWidth = Math.max(1, columns - leftWidth - rightWidth - leftSeparator - rightSeparator);
	const centerX = leftWidth + leftSeparator;
	const rightX = centerX + centerWidth + rightSeparator;
	return {
		width: columns,
		height: rows,
		persistentPanels,
		left: rect(0, 0, leftWidth, rows),
		center: rect(centerX, 0, centerWidth, rows),
		right: rect(rightX, 0, rightWidth, rows),
		leftSeparator,
		rightSeparator,
	};
}

/**
 * Grok Build-style vertical layout. Optional rows are shed before the prompt
 * or the scrollback floor, and compact mode is derived from terminal height.
 */
export function computeAgentLayout({
	width,
	height,
	promptHeight,
	statusHeight = 1,
	dockHeight = 0,
	turnStatusHeight = 0,
	shortcutsHeight = 1,
}) {
	const columns = Math.max(1, integer(width, 1));
	const rows = Math.max(1, integer(height, 1));
	const compact = rows <= AUTO_COMPACT_MAX_ROWS;
	const short = rows <= SHORT_TERMINAL_ROWS;
	const horizontalPadding = columns >= 8 ? (compact ? 1 : 2) : 0;
	const topPadding = short ? 0 : (compact ? 0 : 1);
	const bottomPadding = short ? 0 : (compact ? 0 : 1);
	const inner = rect(
		horizontalPadding,
		topPadding,
		Math.max(1, columns - horizontalPadding * 2),
		Math.max(1, rows - topPadding - bottomPadding),
	);

	let status = inner.height > 0 && integer(statusHeight, 1) > 0 ? 1 : 0;
	let statusGap = status && !compact ? 1 : 0;
	let prompt = clamp(integer(promptHeight, 3), 1, 13);
	let turnStatus = integer(turnStatusHeight) > 0 ? 1 : 0;
	let turnGap = turnStatus && !compact ? 1 : 0;
	let dock = short ? 0 : Math.min(6, integer(dockHeight));
	let dockGap = dock && !compact ? 1 : 0;
	let promptGap = compact ? 0 : 1;
	let shortcuts = inner.height >= 8 ? Math.min(1, integer(shortcutsHeight, 1)) : 0;
	let shortcutsGap = shortcuts && !compact ? 1 : 0;

	const fixed = () => status + statusGap + turnGap + turnStatus + dockGap + dock + promptGap + prompt + shortcutsGap + shortcuts;
	let scrollbackFloor = Math.min(SCROLLBACK_MIN_ROWS, Math.max(0, inner.height));
	const over = () => fixed() + scrollbackFloor - inner.height;

	// Preserve the Grok hierarchy: optional dock, decorative gaps, excess
	// prompt rows, shortcuts, and only then the scrollback floor.
	while (over() > 0 && dock > 0) dock -= 1;
	if (dock === 0) dockGap = 0;
	for (const removeGap of [
		() => { if (statusGap) { statusGap = 0; return true; } return false; },
		() => { if (turnGap) { turnGap = 0; return true; } return false; },
		() => { if (dockGap) { dockGap = 0; return true; } return false; },
		() => { if (promptGap) { promptGap = 0; return true; } return false; },
		() => { if (shortcutsGap) { shortcutsGap = 0; return true; } return false; },
	]) {
		if (over() > 0) removeGap();
	}
	while (over() > 0 && prompt > 3) prompt -= 1;
	if (over() > 0 && shortcuts) shortcuts = 0;
	if (over() > 0 && turnStatus) turnStatus = 0;
	if (over() > 0 && status) status = 0;
	// Keep a closed three-row prompt whenever the terminal can physically hold
	// one. Only ultra-short terminals sacrifice scrollback, then prompt rows.
	while (over() > 0 && scrollbackFloor > 0) scrollbackFloor -= 1;
	while (over() > 0 && prompt > 1) prompt -= 1;

	const scrollbackHeight = Math.max(0, inner.height - fixed());
	let y = inner.y;
	const statusBar = rect(inner.x, y, inner.width, status);
	y += status + statusGap;
	const scrollback = rect(inner.x, y, inner.width, scrollbackHeight);
	y += scrollbackHeight;
	y += turnGap;
	const turnStatusRect = rect(inner.x, y, inner.width, turnStatus);
	y += turnStatus;
	y += dockGap;
	const dockRect = rect(inner.x, y, inner.width, dock);
	y += dock;
	y += promptGap;
	const promptRect = rect(inner.x, y, inner.width, prompt);
	y += prompt;
	y += shortcutsGap;
	const shortcutsRect = rect(inner.x, y, inner.width, shortcuts);

	return {
		compact,
		short,
		inner,
		statusBar,
		scrollback,
		turnStatus: turnStatusRect,
		dock: dockRect,
		prompt: promptRect,
		shortcuts: shortcutsRect,
	};
}

/** Return a clamped top-based viewport into a list of visual rows. */
export function panelWindow(totalRows, viewportRows, scroll = 0) {
	const total = integer(totalRows);
	const viewport = integer(viewportRows);
	const maxScroll = Math.max(0, total - viewport);
	const start = clamp(integer(scroll), 0, maxScroll);
	return { start, end: Math.min(total, start + viewport), maxScroll };
}

/** Compute the two-column Grok timeline rail that replaces the scrollbar. */
export function computeTimelineRail({ area, terminalWidth, turnCount, activeTurn = 0 }) {
	const count = integer(turnCount);
	if (!area || integer(terminalWidth) < TIMELINE_MIN_COLUMNS || count < 2 || integer(area.height) < 4) return undefined;
	const capacity = Math.max(1, integer(area.height) - 2);
	const shown = Math.min(count, capacity);
	const active = clamp(integer(activeTurn), 0, count - 1);
	const maxStart = Math.max(0, count - shown);
	const start = clamp(active - Math.floor(shown / 2), 0, maxStart);
	return {
		x: integer(area.x) + Math.max(0, integer(area.width) - 2),
		width: 2,
		upY: integer(area.y),
		ticksY: integer(area.y) + 1,
		downY: integer(area.y) + integer(area.height) - 1,
		start,
		end: start + shown,
		active,
	};
}
