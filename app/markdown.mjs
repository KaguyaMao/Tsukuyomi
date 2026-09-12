/**
 * Self-contained Markdown renderer for the Tsukuyomi terminal UI.
 *
 * Zero runtime dependencies. Parses a CommonMark-flavoured subset (headings,
 * paragraphs, fenced/indented code blocks, ordered/unordered/task lists,
 * block quotes, GFM tables, horizontal rules) plus inline styling (bold,
 * italic, strikethrough, inline code, links with OSC 8 hyperlinks, images,
 * autolinks) and turns it into an array of terminal-ready rows carrying SGR
 * sequences. Each row is independent: it re-opens the styles it needs and ends
 * with a reset, so callers can prefix indentation without breaking styles.
 *
 * `renderMarkdown(text, { width })` returns `string[]`. `highlight(code, lang)`
 * returns a single SGR-decorated string (no trailing reset is required by the
 * caller; the code block renderer adds one).
 *
 * The palette mirrors `app/tui.mjs`'s `color` object so output is visually
 * consistent with the rest of the interface.
 */

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const ITALIC = `${ESC}3m`;
const STRIKE = `${ESC}9m`;
const UNDERLINE = `${ESC}4m`;

// RGB foreground palette (r;g;b), matching tui.mjs `color`.
const PAL = {
	text: "235;235;235",
	muted: "117;117;117",
	dim: "82;82;82",
	accent: "137;200;255",
	secondary: "177;142;221",
	title: "232;174;82",
	success: "148;210;102",
	warning: "232;174;82",
	error: "255;116;139",
	border: "68;68;72",
};

const fg = (rgb) => `${ESC}38;2;${rgb}m`;
const bg = (rgb) => `${ESC}48;2;${rgb}m`;

const BASE = fg(PAL.text);

/** Visible width of a single code point (East-Asian wide chars count as 2). */
function charWidth(codePoint) {
	if (codePoint >= 0x1100 && codePoint <= 0x115f) return 2;
	if (codePoint >= 0x2e80 && codePoint <= 0xa4cf) return 2;
	if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return 2;
	if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 2;
	if (codePoint >= 0xfe30 && codePoint <= 0xfe4f) return 2;
	if (codePoint >= 0xff00 && codePoint <= 0xff60) return 2;
	if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return 2;
	if (codePoint >= 0x1f300 && codePoint <= 0x1faff) return 2;
	if (codePoint >= 0x20000 && codePoint <= 0x3fffd) return 2;
	return 1;
}

/** Visible (display) length of a string, ignoring ANSI escape sequences. */
export function visibleLength(value) {
	const str = String(value);
	let length = 0;
	let i = 0;
	while (i < str.length) {
		const ch = str[i];
		if (ch === "\x1b") {
			if (str[i + 1] === "]") {
				const end = str.indexOf("\x1b\\", i + 2);
				i = end === -1 ? str.length : end + 2;
				continue;
			}
			let k = i + 1;
			while (k < str.length && !/[A-Za-z]/.test(str[k])) k++;
			i = k + 1;
			continue;
		}
		length += charWidth(ch.codePointAt(0));
		i++;
	}
	return length;
}

/** SGR-aware word wrapping. `text` may contain embedded styling; each emitted
 *  line re-opens the styles active at its start and resets at its end. */
export function wrapAnsi(text, width, indent = "") {
	if (!Number.isFinite(width) || width <= 0) width = 80;
	const indentWidth = visibleLength(indent);
	const tokens = tokenize(text);
	const lines = [];
	let cur = indent;
	let curWidth = indentWidth;
	let active = [];
	let hasContent = false;

	const flush = () => {
		lines.push((active.length ? active.join("") : "") + cur + RESET);
		cur = indent;
		curWidth = indentWidth;
		active = [];
		hasContent = false;
	};

	for (const token of tokens) {
		if (token.isSpace) {
			if (!hasContent) continue;
			cur += token.raw;
			curWidth += token.width;
			continue;
		}
		if (hasContent && curWidth + token.width > width) flush();
		updateActive(token.raw, active);
		cur += token.raw;
		curWidth += token.width;
		hasContent = true;
	}
	if (hasContent) flush();
	return lines;
}

/** Split text into visible tokens (words) that carry any embedded SGR. */
function tokenize(text) {
	const tokens = [];
	let i = 0;
	let raw = "";
	let width = 0;
	const pushWord = () => {
		if (raw) {
			tokens.push({ raw, width, isSpace: false });
			raw = "";
			width = 0;
		}
	};
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\x1b") {
			if (text[i + 1] === "]") {
				const end = text.indexOf("\x1b\\", i + 2);
				const k = end === -1 ? text.length : end + 2;
				raw += text.slice(i, k);
				i = k;
				continue;
			}
			let k = i + 1;
			while (k < text.length && !/[A-Za-z]/.test(text[k])) k++;
			k++;
			raw += text.slice(i, k);
			i = k;
			continue;
		}
		if (ch === " " || ch === "\t") {
			pushWord();
			tokens.push({ raw: ch, width: 1, isSpace: true });
			i++;
			continue;
		}
		raw += ch;
		width += charWidth(ch.codePointAt(0));
		i++;
	}
	pushWord();
	return tokens;
}

/** Track currently-open SGR codes so wrapped continuation lines can reopen. */
function updateActive(raw, active) {
	const re = /\x1b\[([0-9;]*)m/g;
	let match;
	while ((match = re.exec(raw))) {
		const body = match[1];
		if (body === "" || body === "0") {
			active.length = 0;
			continue;
		}
		for (const part of body.split(";")) {
			const code = Number(part);
			if (code === 22) removeStyle(active, "1");
			else if (code === 23) removeStyle(active, "3");
			else if (code === 24) removeStyle(active, "4");
			else if (code === 29) removeStyle(active, "9");
			else if (code === 38 || code === 48) {
				active.length = 0;
				active.push(match[0]);
			} else if ((code >= 30 && code <= 49) || code === 0) {
				active.length = 0;
			} else {
				active.push(`${ESC}${code}m`);
			}
		}
	}
}

function removeStyle(active, baseCode) {
	const prefix = `${ESC}${baseCode}`;
	for (let index = active.length - 1; index >= 0; index--) {
		if (active[index].startsWith(prefix)) active.splice(index, 1);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline parsing
// ─────────────────────────────────────────────────────────────────────────────

const INLINE_CLOSERS = `${RESET}${BASE}`;

function inlineToAnsi(input, base = BASE) {
	let out = "";
	let i = 0;
	const n = input.length;
	const rest = () => input.slice(i);

	const close = () => `${RESET}${base}`;

	while (i < n) {
		const ch = input[i];

		// Escaped character.
		if (ch === "\\" && i + 1 < n && "`*_~[]()!".includes(input[i + 1])) {
			out += input[i + 1];
			i += 2;
			continue;
		}

		// Inline code span (`...` or ``...``), content is literal.
		if (ch === "`") {
			let closeIndex = input.indexOf("`", i + 1);
			let depth = 1;
			while (closeIndex !== -1 && input[closeIndex - 1] === "`") {
				depth++;
				closeIndex = input.indexOf("`".repeat(depth), i + depth);
				if (closeIndex === -1) break;
			}
			if (closeIndex !== -1) {
				const marker = "`".repeat(depth);
				const content = input.slice(i + depth, closeIndex);
				out += `${fg(PAL.secondary)}${content}${close()}`;
				i = closeIndex + depth;
				continue;
			}
		}

		// Image (render alt text, drop the binary reference).
		if (ch === "!" && input[i + 1] === "[") {
			const end = input.indexOf("]", i + 1);
			const after = end !== -1 ? input.indexOf(")", end + 1) : -1;
			if (end !== -1 && after !== -1) {
				const alt = input.slice(i + 2, end);
				out += `${fg(PAL.muted)}[${alt}]${close()}`;
				i = after + 1;
				continue;
			}
		}

		// Link [text](url) or autolink <url>.
		if (ch === "[") {
			const end = input.indexOf("]", i + 1);
			const after = end !== -1 ? input.indexOf(")", end + 1) : -1;
			if (end !== -1 && after !== -1) {
				const text = input.slice(i + 1, end);
				const url = input.slice(end + 2, after);
				out += emitLink(url, text, base);
				i = after + 1;
				continue;
			}
		}
		if (ch === "<" && /https?:\/\//.test(rest().slice(1, 9))) {
			const m = /^<(https?:\/\/[^\s>]+)>/.exec(rest());
			if (m) {
				out += emitLink(m[1], m[1], base);
				i += m[0].length;
				continue;
			}
		}

		// Bold **x** or __x__ (handle before single delimiter).
		if (ch === "*" && input[i + 1] === "*") {
			const end = input.indexOf("**", i + 2);
			if (end !== -1) {
				const inner = input.slice(i + 2, end);
				out += `${BOLD}${inlineToAnsi(inner, `${BOLD}${base}`)}${close()}`;
				i = end + 2;
				continue;
			}
		}
		if (ch === "_" && input[i + 1] === "_") {
			const end = input.indexOf("__", i + 2);
			if (end !== -1) {
				const inner = input.slice(i + 2, end);
				out += `${BOLD}${inlineToAnsi(inner, `${BOLD}${base}`)}${close()}`;
				i = end + 2;
				continue;
			}
		}

		// Strikethrough ~~x~~.
		if (ch === "~" && input[i + 1] === "~") {
			const end = input.indexOf("~~", i + 2);
			if (end !== -1) {
				const inner = input.slice(i + 2, end);
				out += `${STRIKE}${inlineToAnsi(inner, `${STRIKE}${base}`)}${close()}`;
				i = end + 2;
				continue;
			}
		}

		// Italic *x* (not intra-word; not adjacent to a word char on the open side).
		if (ch === "*" && (i === 0 || !/\w/.test(input[i - 1])) && input[i + 1] !== " " && input[i + 1] !== "*") {
			const end = input.indexOf("*", i + 1);
			if (end > i + 1 && input[end - 1] !== " ") {
				const inner = input.slice(i + 1, end);
				out += `${ITALIC}${inlineToAnsi(inner, `${ITALIC}${base}`)}${close()}`;
				i = end + 1;
				continue;
			}
		}
		// Italic _x_ (requires no word char on either side).
		if (ch === "_" && (i === 0 || !/\w/.test(input[i -1])) && (i + 1 >= n || !/\w/.test(input[i + 1]))) {
			const end = input.indexOf("_", i + 1);
			if (end > i + 1) {
				const inner = input.slice(i + 1, end);
				out += `${ITALIC}${inlineToAnsi(inner, `${ITALIC}${base}`)}${close()}`;
				i = end + 1;
				continue;
			}
		}

		// Bare URL.
		const bare = /^(https?:\/\/[^\s<]+)/.exec(rest());
		if (bare) {
			out += emitLink(bare[1], bare[1], base);
			i += bare[0].length;
			continue;
		}

		out += ch;
		i++;
	}
	return out;
}

function emitLink(url, text, base) {
	const safeUrl = url.replace(/[\x00-\x1f]/g, "");
	const open = `\x1b]8;;${safeUrl}\x1b\\`;
	const close = `\x1b]8;;\x1b\\`;
	return `${open}${UNDERLINE}${fg(PAL.accent)}${text}${RESET}${close}${base}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block parsing
// ─────────────────────────────────────────────────────────────────────────────

export function renderMarkdown(input, { width = 80 } = {}) {
	if (!input) return [];
	const text = String(input).replace(/\r\n?/g, "\n");
	const lines = text.split("\n");
	const rows = [];
	let i = 0;

	const pushBlock = (blockRows) => {
		if (blockRows.length === 0) return;
		if (rows.length > 0 && rows[rows.length - 1] !== "") rows.push("");
		rows.push(...blockRows);
	};

	while (i < lines.length) {
		const line = lines[i];

		if (!line.trim()) {
			i++;
			continue;
		}

		// Fenced code block.
		const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			const fenceChar = fence[1][0];
			const lang = fence[2].trim().split(/\s+/)[0] || "";
			const body = [];
			i++;
			while (i < lines.length && !lines[i].trim().startsWith(fenceChar.repeat(3))) {
				body.push(lines[i]);
				i++;
			}
			i++; // skip closing fence
			pushBlock(renderCodeBlock(body, lang, width));
			continue;
		}

		// ATX heading.
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			const headingColor = level <= 2 ? fg(PAL.accent) : fg(PAL.text);
			const prefix = "#".repeat(level) + " ";
			const content = `${BOLD}${headingColor}${prefix}${inlineToAnsi(heading[2], headingColor)}`;
			pushBlock(wrapAnsi(content, width));
			i++;
			continue;
		}

		// Horizontal rule.
		if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
			pushBlock([`${fg(PAL.border)}${"─".repeat(Math.max(1, width))}${RESET}`]);
			i++;
			continue;
		}

		// Block quote.
		if (/^\s*>/.test(line)) {
			const quoteLines = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) {
				quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
				i++;
			}
			const inner = renderMarkdown(quoteLines.join("\n"), { width: Math.max(20, width - 2) });
			pushBlock(inner.map((row) => `${fg(PAL.border)}│${RESET} ${row}`));
			continue;
		}

		// Table (GFM): header / separator / rows.
		if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
			const table = parseTable(lines, i);
			i = table.nextIndex;
			pushBlock(renderTable(table, width));
			continue;
		}

		// List (unordered / ordered / task).
		if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
			const list = parseList(lines, i);
			i = list.nextIndex;
			pushBlock(renderList(list.items, width));
			continue;
		}

		// Paragraph: gather consecutive non-blank, non-block lines.
		const para = [];
		while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
			para.push(lines[i]);
			i++;
		}
		if (para.length === 0) {
			i++;
			continue;
		}
		const content = `${BASE}${inlineToAnsi(para.join(" "))}`;
		pushBlock(wrapAnsi(content, width));
	}

	return rows;
}

/** Detect the start of a non-paragraph block (so paragraph collection stops). */
function startsBlock(line, next) {
	if (!line) return false;
	if (/^\s*(`{3,}|~{3,})/.test(line)) return true;
	if (/^#{1,6}\s+/.test(line)) return true;
	if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) return true;
	if (/^\s*>/.test(line)) return true;
	if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) return true;
	if (line.includes("|") && next && /^\s*\|?[\s:|-]+\|?\s*$/.test(next) && next.includes("-")) return true;
	return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lists
// ─────────────────────────────────────────────────────────────────────────────

function parseList(lines, startIndex) {
	const items = [];
	let i = startIndex;
	while (i < lines.length) {
		const line = lines[i];
		const m = /^( *)([-*+]|\d+[.)])[ \t]+(.*)$/.exec(line);
		if (!m) break;
		const indent = m[1].length;
		const markerToken = m[2];
		const body = m[3];
		const task = /^\s*\[( |x|X)\]\s+(.*)$/.exec(body);
		items.push({
			indent,
			ordered: /\d/.test(markerToken[0]),
			markerToken,
			text: task ? task[2] : body,
			checked: task ? task[1].toLowerCase() === "x" : undefined,
		});
		i++;
	}
	return { items, nextIndex: i };
}

function renderList(items, width) {
	const rows = [];
	const counters = {};
	for (const item of items) {
		const depth = Math.floor(item.indent / 2);
		let marker;
		if (item.ordered) {
			counters[depth] = (counters[depth] || 0) + 1;
			marker = `${counters[depth]}.`;
		} else if (item.checked === true) {
			marker = `${fg(PAL.success)}✔${RESET}`;
		} else if (item.checked === false) {
			marker = `${fg(PAL.muted)}☐${RESET}`;
		} else {
			marker = `${fg(PAL.accent)}•${RESET}`;
		}
		const markerStr = `${"  ".repeat(depth)}${marker} `;
		const content = `${BASE}${inlineToAnsi(item.text)}`;
		const contentWidth = Math.max(10, width - visibleLength(markerStr));
		const wrapped = wrapAnsi(content, contentWidth, "");
		const continuation = `${"  ".repeat(depth)}  `;
		wrapped.forEach((row, index) => {
			rows.push(index === 0 ? `${markerStr}${row}` : `${continuation}${row}`);
		});
	}
	return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tables (GFM)
// ─────────────────────────────────────────────────────────────────────────────

function parseTable(lines, startIndex) {
	const splitRow = (raw) => raw.replace(/^\s*\|?/, "").replace(/\|?\s*$/, "").split("|").map((cell) => cell.trim());
	const header = splitRow(lines[startIndex]);
	const aligns = splitRow(lines[startIndex + 1]).map((cell) => {
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		if (left && right) return "center";
		if (right) return "right";
		if (left) return "left";
		return "left";
	});
	const body = [];
	let i = startIndex + 2;
	while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
		body.push(splitRow(lines[i]));
		i++;
	}
	return { header, aligns, body, nextIndex: i };
}

function maxColumns(rows) {
	let max = 0;
	for (const row of rows) max = Math.max(max, row.length);
	return max;
}

function renderTable(table, width) {
	const columns = maxColumns([table.header, ...table.body]);
	const aligns = table.aligns.slice(0, columns);
	while (aligns.length < columns) aligns.push("left");

	const allRows = [table.header, ...table.body];
	const colWidths = [];
	for (let c = 0; c < columns; c++) {
		let max = 1;
		for (const row of allRows) max = Math.max(max, visibleLength(row[c] || ""));
		colWidths.push(max);
	}
	// Shrink columns if the whole table does not fit.
	const gutter = columns + 1;
	let total = colWidths.reduce((sum, w) => sum + w, 0) + gutter * 2 + (columns - 1);
	const budget = Math.max(columns * 6, width - gutter * 2);
	if (total > width) {
		const scale = budget / (total - gutter * 2 - (columns - 1));
		for (let c = 0; c < columns; c++) colWidths[c] = Math.max(4, Math.floor(colWidths[c] * scale));
	}

	const padCell = (cell, index) => {
		const align = aligns[index] || "left";
		const content = `${BASE}${inlineToAnsi(cell || "")}`;
		const wrapped = wrapAnsi(content, colWidths[index]);
		return wrapped.map((line) => alignCell(line, colWidths[index], align));
	};

	const renderRow = (cells) => {
		const colLines = cells.map((cell, index) => padCell(cell, index));
		const rowHeight = Math.max(1, ...colLines.map((lines) => lines.length));
		const out = [];
		for (let r = 0; r < rowHeight; r++) {
			const parts = colLines.map((lines, c) => (lines[r] ?? alignCell("", colWidths[c], aligns[c] || "left")));
			out.push(`${fg(PAL.border)}│${RESET} ${parts.join(` ${fg(PAL.border)}│${RESET} `)} ${fg(PAL.border)}│${RESET}`);
		}
		return out;
	};

	const rows = [];
	rows.push(renderRow(table.header));
	rows.push([renderSeparator(colWidths, "├", "┼", "┤")]);
	for (const row of table.body) rows.push(renderRow(row));
	// Collapse the array-of-arrays into a flat row list.
	return rows.flat();
}

function alignCell(line, width, align) {
	const len = visibleLength(stripLeadingSgr(line));
	const pad = Math.max(0, width - len);
	if (align === "right") return `${" ".repeat(pad)}${line}`;
	if (align === "center") {
		const left = Math.floor(pad / 2);
		return `${" ".repeat(left)}${line}${" ".repeat(pad - left)}`;
	}
	return `${line}${" ".repeat(pad)}`;
}

function stripLeadingSgr(line) {
	// Only used for measuring; the leading base color SGR is not visible.
	return line.replace(/^\x1b\[[0-9;]*m/, "");
}

function renderSeparator(widths, left, mid, right) {
	const segs = widths.map((w) => "─".repeat(w + 2));
	return `${fg(PAL.border)}${left}${segs.join(mid)}${right}${RESET}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Code blocks + syntax highlighting
// ─────────────────────────────────────────────────────────────────────────────

function renderCodeBlock(lines, lang, width) {
	const rows = [];
	const label = lang ? `${fg(PAL.secondary)}${lang}${RESET}` : "";
	rows.push(`${fg(PAL.border)}──${label ? ` ${label}` : ""}${"─".repeat(Math.max(0, width - 4 - visibleLength(label)))}${RESET}`);
	for (const line of lines) {
		const hl = highlight(line, lang);
		rows.push(`${fg(PAL.border)}│${RESET} ${hl}${RESET}`);
	}
	rows.push(`${fg(PAL.border)}└${"─".repeat(Math.max(1, width - 1))}${RESET}`);
	return rows;
}

const HL = {
	keyword: fg(PAL.accent),
	string: fg(PAL.success),
	number: fg(PAL.title),
	comment: fg(PAL.muted),
	func: fg(PAL.secondary),
	property: fg(PAL.accent),
};

const LANGS = {
	js: "javascript", ts: "typescript", javascript: "javascript", typescript: "typescript",
	json: "json", py: "python", python: "python", bash: "bash", sh: "bash", shell: "bash",
	zsh: "bash", yaml: "yaml", yml: "yaml", xml: "xml", html: "xml",
	css: "css", sql: "sql", md: "markdown", markdown: "markdown",
};

const JS_KEYWORDS = new Set(["const","let","var","function","return","if","else","for","while","do","switch","case","break","continue","new","class","extends","super","this","import","export","from","default","async","await","yield","try","catch","finally","throw","typeof","instanceof","in","of","delete","void","null","undefined","true","false","static","get","set","public","private","protected","interface","type","enum","implements"]);
const PY_KEYWORDS = new Set(["def","return","if","elif","else","for","while","break","continue","import","from","as","class","try","except","finally","with","lambda","yield","global","nonlocal","pass","raise","assert","async","await","in","is","not","and","or","None","True","False","self"]);
const SQL_KEYWORDS = new Set(["select","from","where","insert","into","values","update","set","delete","create","table","drop","alter","join","left","right","inner","outer","on","group","by","order","limit","offset","having","as","and","or","not","null","distinct","count","sum","avg","min","max"]);

/** Lightweight, regex-based syntax highlighter. Returns an SGR string; the
 *  caller appends a reset. Unknown languages pass through unhighlighted. */
export function highlight(code, lang) {
	const normalized = lang ? LANGS[lang.toLowerCase()] : undefined;
	if (!normalized) return `${BASE}${code}`;
	if (normalized === "json") return highlightJson(code);
	if (normalized === "yaml") return highlightYaml(code);
	if (normalized === "bash") return highlightBash(code);
	if (normalized === "sql") return highlightSql(code);
	if (normalized === "xml") return highlightXml(code);
	if (normalized === "css") return highlightCss(code);
	if (normalized === "markdown") return `${BASE}${code}`;
	return highlightClike(code, normalized === "python" ? PY_KEYWORDS : JS_KEYWORDS);
}

function highlightClike(code, keywords) {
	let out = "";
	let i = 0;
	const n = code.length;
	while (i < n) {
		const ch = code[i];
		// Line comment.
		if (ch === "/" && code[i + 1] === "/") {
			const end = code.indexOf("\n", i);
			const stop = end === -1 ? n : end;
			out += `${HL.comment}${code.slice(i, stop)}${RESET}`;
			i = stop;
			continue;
		}
		// Block comment.
		if (ch === "/" && code[i + 1] === "*") {
			const end = code.indexOf("*/", i + 2);
			const stop = end === -1 ? n : end + 2;
			out += `${HL.comment}${code.slice(i, stop)}${RESET}`;
			i = stop;
			continue;
		}
		// String.
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			let end = i + 1;
			while (end < n && code[end] !== quote) {
				if (code[end] === "\\") end++;
				end++;
			}
			end = Math.min(end + 1, n);
			out += `${HL.string}${code.slice(i, end)}${RESET}`;
			i = end;
			continue;
		}
		// Number.
		if (/[0-9]/.test(ch) && !/[0-9a-zA-Z_]/.test(code[i - 1] || "")) {
			const m = /^[0-9][0-9a-fxA-FoObB._]*/.exec(code.slice(i));
			const num = m ? m[0] : ch;
			out += `${HL.number}${num}${RESET}`;
			i += num.length;
			continue;
		}
		// Identifier / keyword / function call.
		if (/[A-Za-z_$]/.test(ch)) {
			const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(i));
			const word = m[0];
			const after = code[i + word.length];
			if (keywords.has(word)) out += `${HL.keyword}${word}${RESET}`;
			else if (after === "(") out += `${HL.func}${word}${RESET}`;
			else out += word;
			i += word.length;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

function highlightJson(code) {
	let out = "";
	let i = 0;
	const n = code.length;
	while (i < n) {
		const ch = code[i];
		if (ch === '"') {
			let end = i + 1;
			while (end < n && code[end] !== '"') {
				if (code[end] === "\\") end++;
				end++;
			}
			end = Math.min(end + 1, n);
			const slice = code.slice(i, end);
			// Key if followed by colon.
			let j = end;
			while (j < n && /\s/.test(code[j])) j++;
			if (code[j] === ":") out += `${HL.property}${slice}${RESET}`;
			else out += `${HL.string}${slice}${RESET}`;
			i = end;
			continue;
		}
		if (/[0-9-]/.test(ch) && !/[0-9a-zA-Z_]/.test(code[i - 1] || "")) {
			const m = /^-?[0-9][0-9.eE+-]*/.exec(code.slice(i));
			const num = m ? m[0] : ch;
			out += `${HL.number}${num}${RESET}`;
			i += num.length;
			continue;
		}
		if (ch === "t" || ch === "f" || ch === "n") {
			const m = /^(true|false|null)/.exec(code.slice(i));
			if (m) {
				out += `${HL.keyword}${m[0]}${RESET}`;
				i += m[0].length;
				continue;
			}
		}
		out += ch;
		i++;
	}
	return out;
}

function highlightYaml(code) {
	let out = "";
	for (const line of code.split("\n")) {
		const m = /^(\s*-?\s*)([\w.-]+)(:)(\s*)/.exec(line);
		if (m) {
			out += `${BASE}${m[1]}${HL.property}${m[2]}${RESET}${m[3]}${m[4]}`;
			out += highlightYamlValue(line.slice(m[0].length));
		} else {
			out += highlightYamlValue(line);
		}
		out += "\n";
	}
	return out.replace(/\n$/, "");
}

function highlightYamlValue(value) {
	if (/^["'].*["']$/.test(value.trim())) return `${HL.string}${value}${RESET}`;
	if (/^-?\d+(\.\d+)?$/.test(value.trim())) return `${HL.number}${value}${RESET}`;
	if (/^(true|false|null|~)$/.test(value.trim())) return `${HL.keyword}${value}${RESET}`;
	return `${BASE}${value}${RESET}`;
}

function highlightBash(code) {
	let out = "";
	let i = 0;
	const n = code.length;
	while (i < n) {
		const ch = code[i];
		if (ch === "#") {
			const end = code.indexOf("\n", i);
			const stop = end === -1 ? n : end;
			out += `${HL.comment}${code.slice(i, stop)}${RESET}`;
			i = stop;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			let end = i + 1;
			while (end < n && code[end] !== quote) {
				if (code[end] === "\\") end++;
				end++;
			}
			end = Math.min(end + 1, n);
			out += `${HL.string}${code.slice(i, end)}${RESET}`;
			i = end;
			continue;
		}
		if (ch === "$" && code[i + 1] === "{") {
			const end = code.indexOf("}", i + 2);
			out += `${HL.func}${code.slice(i, end + 1)}${RESET}`;
			i = end + 1;
			continue;
		}
		if (ch === "-" && /[A-Za-z]/.test(code[i + 1] || "")) {
			const m = /^--?[A-Za-z][\w-]*/.exec(code.slice(i));
			out += `${HL.keyword}${m[0]}${RESET}`;
			i += m[0].length;
			continue;
		}
		if (ch === " ") { out += ch; i++; continue; }
		// Bare word: command at start of a word?
		const m = /^[A-Za-z_./][\w./-]*/.exec(code.slice(i));
		if (m) {
			out += `${HL.func}${m[0]}${RESET}`;
			i += m[0].length;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

function highlightSql(code) {
	let out = "";
	let i = 0;
	const n = code.length;
	while (i < n) {
		const ch = code[i];
		if (ch === "-" && code[i + 1] === "-") {
			const end = code.indexOf("\n", i);
			const stop = end === -1 ? n : end;
			out += `${HL.comment}${code.slice(i, stop)}${RESET}`;
			i = stop;
			continue;
		}
		if (ch === "'" || ch === '"') {
			const quote = ch;
			let end = i + 1;
			while (end < n && code[end] !== quote) end++;
			end = Math.min(end + 1, n);
			out += `${HL.string}${code.slice(i, end)}${RESET}`;
			i = end;
			continue;
		}
		if (/[0-9]/.test(ch)) {
			const m = /^[0-9][0-9.]*/.exec(code.slice(i));
			out += `${HL.number}${m[0]}${RESET}`;
			i += m[0].length;
			continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			const m = /^[A-Za-z_][\w]*/.exec(code.slice(i));
			const word = m[0];
			if (SQL_KEYWORDS.has(word.toLowerCase())) out += `${HL.keyword}${word}${RESET}`;
			else out += word;
			i += word.length;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

function highlightXml(code) {
	let out = "";
	const re = /(&lt;\/?)([a-zA-Z0-9-]+)|("(?:[^"]*)")|(<!--[\s\S]*?-->)/g;
	let last = 0;
	let m;
	while ((m = re.exec(code))) {
		out += `${BASE}${code.slice(last, m.index)}${RESET}`;
		if (m[3]) out += `${HL.comment}${m[3]}${RESET}`;
		else if (m[1]) out += `${HL.keyword}${m[1]}${RESET}${HL.func}${m[2]}${RESET}`;
		last = re.lastIndex;
	}
	out += `${BASE}${code.slice(last)}${RESET}`;
	return out;
}

function highlightCss(code) {
	let out = "";
	let i = 0;
	const n = code.length;
	while (i < n) {
		const ch = code[i];
		if (ch === "/" && code[i + 1] === "*") {
			const end = code.indexOf("*/", i + 2);
			const stop = end === -1 ? n : end + 2;
			out += `${HL.comment}${code.slice(i, stop)}${RESET}`;
			i = stop;
			continue;
		}
		if (ch === "." || ch === "#") {
			const m = /^[.#][A-Za-z_][\w-]*/.exec(code.slice(i));
			out += `${HL.func}${m[0]}${RESET}`;
			i += m[0].length;
			continue;
		}
		if (ch === ":") {
			const m = /^:[A-Za-z-]+/.exec(code.slice(i));
			out += `${HL.property}${m[0]}${RESET}`;
			i += m[0].length;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			let end = i + 1;
			while (end < n && code[end] !== quote) end++;
			end = Math.min(end + 1, n);
			out += `${HL.string}${code.slice(i, end)}${RESET}`;
			i = end;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

export { visibleLength as measureVisible };

/** Inline-only Markdown (no block parsing): bold, italic, code, links, strike.
 *  Useful for single-line text such as tool output rows. `base` is the SGR
 *  background color reopened after each styled span closes. */
export const inlineAnsi = (text, base = BASE) => inlineToAnsi(text, base);

/** Map a file path's extension to a highlighter language id. */
export function langFromPath(path) {
	if (!path || typeof path !== "string") return undefined;
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	const map = {
		js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "ts", tsx: "ts", json: "json",
		py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
		c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
		sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "yaml",
		xml: "xml", html: "xml", htm: "xml", svg: "xml", css: "css", sql: "sql",
		md: "markdown", markdown: "markdown",
	};
	return map[ext];
}
