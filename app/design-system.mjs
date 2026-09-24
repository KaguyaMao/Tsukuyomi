/**
 * Tsukuyomi's shared visual contract.
 *
 * Keep brand tokens here so the standalone TUI, Markdown renderer, dialogs and
 * future Agent/Team surfaces cannot slowly drift into different palettes.
 * Values intentionally mirror the established TUI palette; changing the
 * canvas/logo tokens is a breaking visual change.
 */

export const TSUKUYOMI_PALETTE = Object.freeze({
	canvas: "18;18;18",
	// Keep the neutral canvas for Tsukuyomi's brand contract. The actual OMP
	// Titanium surfaces and semantic colors below provide the visual language.
	band: "24;28;36",
	panel: "24;28;36",
	panelHover: "0;130;179",
	menu: "15;18;22",
	menuSelection: "0;130;179",
	selection: "0;130;179",
	tool: "25;30;39",
	toolPending: "24;38;55",
	toolSuccess: "22;47;35",
	toolError: "50;23;29",
	text: "232;236;244",
	muted: "174;182;196",
	dim: "134;144;160",
	accent: "0;180;255",
	secondary: "0;180;255",
	brand: "212;192;144",
	success: "0;255;136",
	warning: "255;179;71",
	error: "255;71;87",
	border: "112;122;138",
	borderMuted: "78;88;104",
	thinkingMinimal: "134;144;160",
	thinkingLow: "0;130;179",
	thinkingMedium: "0;180;255",
	thinkingHigh: "212;192;144",
	thinkingXhigh: "255;179;71",
	thinkingMax: "255;71;87",
	syntaxComment: "107;114;128",
	syntaxKeyword: "0;180;255",
	syntaxFunction: "0;255;136",
	syntaxVariable: "232;236;244",
	syntaxString: "212;192;144",
	syntaxNumber: "255;179;71",
	syntaxType: "0;180;255",
	syntaxOperator: "0;180;255",
	syntaxPunctuation: "156;163;176",
});

const ESC = "\x1b[";
const RESET_FG = `${ESC}39m`;
const RESET_BG = `${ESC}49m`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const BOLD_OFF = `${ESC}22m`;
const DIM = `${ESC}2m`;
const DIM_OFF = `${ESC}22m`;

export const ansiFg = (value) => `${ESC}38;2;${value}m`;
export const ansiBg = (value) => `${ESC}48;2;${value}m`;

const paint = (value, prefix, suffix) => `${prefix}${value}${suffix}`;

export function createTsukuyomiDesignSystem() {
	const fg = Object.fromEntries(Object.entries(TSUKUYOMI_PALETTE).map(([name, value]) => [
		name,
		(text) => paint(text, ansiFg(value), RESET_FG),
	]));
	const bg = Object.fromEntries(Object.entries(TSUKUYOMI_PALETTE).map(([name, value]) => [
		name,
		(text) => paint(text, ansiBg(value), RESET_BG),
	]));
	return Object.freeze({
		palette: TSUKUYOMI_PALETTE,
		fg,
		bg,
		bold: (text) => `${BOLD}${text}${BOLD_OFF}`,
		dim: (text) => `${DIM}${text}${DIM_OFF}`,
		reset: RESET,
		backgrounds: Object.freeze({
			canvas: ansiBg(TSUKUYOMI_PALETTE.canvas),
			band: ansiBg(TSUKUYOMI_PALETTE.band),
			panel: ansiBg(TSUKUYOMI_PALETTE.panel),
			panelHover: ansiBg(TSUKUYOMI_PALETTE.panelHover),
			menu: ansiBg(TSUKUYOMI_PALETTE.menu),
			menuSelection: ansiBg(TSUKUYOMI_PALETTE.menuSelection),
			selection: ansiBg(TSUKUYOMI_PALETTE.selection),
			tool: ansiBg(TSUKUYOMI_PALETTE.tool),
			toolPending: ansiBg(TSUKUYOMI_PALETTE.toolPending),
			toolSuccess: ansiBg(TSUKUYOMI_PALETTE.toolSuccess),
			toolError: ansiBg(TSUKUYOMI_PALETTE.toolError),
		}),
		status: Object.freeze({
			running: "●",
			idle: "○",
			done: "✓",
			failed: "×",
			queued: "·",
		}),
	});
}

/** A compact semantic status label shared by Agent/Team rows and panels. */
export function statusToken(status, design = createTsukuyomiDesignSystem()) {
	const key = String(status || "idle").toLowerCase();
	if (["running", "working", "active"].includes(key)) return design.fg.success(`${design.status.running} ${key}`);
	if (["error", "failed", "aborted", "cancelled"].includes(key)) return design.fg.error(`${design.status.failed} ${key}`);
	if (["done", "completed", "complete"].includes(key)) return design.fg.success(`${design.status.done} ${key}`);
	if (["queued", "pending"].includes(key)) return design.fg.warning(`${design.status.queued} ${key}`);
	return design.fg.muted(`${design.status.idle} ${key}`);
}

/** Keep a row's visual hierarchy consistent across modal and panel surfaces. */
export function renderListRow({ label = "", description = "", selected = false, marker = "" } = {}, design = createTsukuyomiDesignSystem()) {
	const lead = marker ? `${marker} ` : "";
	const main = selected ? design.bold(design.fg.text(`${lead}${label}`)) : design.fg.text(`${lead}${label}`);
	return description ? `${selected ? design.fg.accent("❯") : " "} ${main} ${design.fg.dim(description)}` : `${selected ? design.fg.accent("❯") : " "} ${main}`;
}

/** A stable two-column metadata row for composer/panel footers. */
export function renderMetaRow(left, right, width, design = createTsukuyomiDesignSystem()) {
	const visible = (value) => String(value ?? "").replace(/\x1b\[[0-9;]*m/g, "").length;
	const gap = Math.max(1, width - visible(left) - visible(right));
	return `${left}${" ".repeat(gap)}${right}`;
}
