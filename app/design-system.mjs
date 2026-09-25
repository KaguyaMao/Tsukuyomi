/**
 * Tsukuyomi's shared visual contract.
 *
 * Keep brand tokens here so the standalone TUI, Markdown renderer, dialogs and
 * future Agent/Team surfaces cannot slowly drift into different palettes.
 * Catppuccin Mocha surfaces keep the composer, dialogs, tools and agent rail
 * visually consistent; the Ti mark uses a separate yellow gradient.
 */

export const TSUKUYOMI_PALETTE = Object.freeze({
	canvas: "30;30;46",       // Catppuccin Mocha base
	band: "49;50;68",         // surface0
	panel: "36;39;58",        // mantle lifted for panels
	panelHover: "69;71;90",   // surface1
	menu: "24;24;37",         // mantle
	menuSelection: "69;71;90",
	selection: "69;71;90",
	tool: "36;39;58",
	toolPending: "45;53;76",
	toolSuccess: "39;59;53",
	toolError: "74;42;57",
	text: "205;214;244",      // text
	muted: "166;173;200",     // subtext0
	dim: "127;132;156",       // overlay1
	accent: "137;180;250",    // blue
	secondary: "148;226;213", // teal
	brand: "249;226;175",     // yellow
	success: "166;227;161",
	warning: "250;179;135",
	error: "243;139;168",
	border: "88;91;112",
	borderMuted: "69;71;90",
	thinkingMinimal: "127;132;156",
	thinkingLow: "137;180;250",
	thinkingMedium: "148;226;213",
	thinkingHigh: "249;226;175",
	thinkingXhigh: "250;179;135",
	thinkingMax: "243;139;168",
	syntaxComment: "127;132;156",
	syntaxKeyword: "203;166;247",
	syntaxFunction: "137;180;250",
	syntaxVariable: "205;214;244",
	syntaxString: "166;227;161",
	syntaxNumber: "250;179;135",
	syntaxType: "249;226;175",
	syntaxOperator: "137;180;250",
	syntaxPunctuation: "166;173;200",
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
