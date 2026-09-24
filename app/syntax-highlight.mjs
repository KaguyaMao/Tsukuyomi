import { createRequire } from "node:module";
import { TSUKUYOMI_PALETTE } from "./design-system.mjs";

const ESC = "\x1b[";
const fg = (value) => `${ESC}38;2;${value}m`;

const colors = Object.freeze({
	comment: fg(TSUKUYOMI_PALETTE.syntaxComment),
	keyword: fg(TSUKUYOMI_PALETTE.syntaxKeyword),
	function: fg(TSUKUYOMI_PALETTE.syntaxFunction),
	variable: fg(TSUKUYOMI_PALETTE.syntaxVariable),
	string: fg(TSUKUYOMI_PALETTE.syntaxString),
	number: fg(TSUKUYOMI_PALETTE.syntaxNumber),
	type: fg(TSUKUYOMI_PALETTE.syntaxType),
	operator: fg(TSUKUYOMI_PALETTE.syntaxOperator),
	punctuation: fg(TSUKUYOMI_PALETTE.syntaxPunctuation),
	inserted: fg(TSUKUYOMI_PALETTE.success),
	deleted: fg(TSUKUYOMI_PALETTE.error),
});

let native;
try {
	native = await import("@oh-my-pi/pi-natives");
} catch {
	// OMP's wrapper uses Bun's import.meta.dir. Node can load the platform N-API
	// leaf directly; unsupported platforms still fall back to the JS scanner.
	try {
		const require = createRequire(import.meta.url);
		native = require(`@oh-my-pi/pi-natives-${process.platform}-${process.arch}`);
	} catch { /* optional native binary unavailable */ }
}

// Grammar construction is expensive on first use. Match OMP by warming it on
// the native worker pool while the rest of the TUI starts.
if (typeof native?.warmHighlighter === "function") {
	native.warmHighlighter().catch(() => undefined);
}

export function supportsNativeHighlight(lang) {
	if (!native || !lang) return false;
	try { return native.supportsLanguage(lang) === true; } catch { return false; }
}

export function nativeHighlight(code, lang) {
	if (!supportsNativeHighlight(lang)) return undefined;
	try { return native.highlightCode(String(code), lang, colors); } catch { return undefined; }
}

export function createNativeHighlightStream(lang) {
	if (!supportsNativeHighlight(lang) || typeof native.HighlightStream !== "function") return undefined;
	try { return new native.HighlightStream(lang, colors); } catch { return undefined; }
}
