import { test } from "node:test";
import assert from "node:assert/strict";
import {
	renderMarkdown,
	renderOutputBlock,
	renderStreamingCodeBlock,
	highlight,
	inlineAnsi,
	langFromPath,
	visibleLength,
} from "../app/markdown.mjs";
import { TSUKUYOMI_PALETTE } from "../app/design-system.mjs";

const ESC = "\x1b[";
const BOLD = `${ESC}1m`;
const ITALIC = `${ESC}3m`;
const STRIKE = `${ESC}9m`;
const RESET = `${ESC}0m`;
const UNDERLINE = `${ESC}4m`;

/** Strip all SGR / OSC escape sequences to inspect the visible text only. */
function stripAnsi(value) {
	return String(value)
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
		.replace(/\x1b\][^\x1b]*\x1b\\/g, "");
}

test("visibleLength counts East-Asian wide characters as width 2", () => {
	assert.equal(visibleLength("abc"), 3);
	assert.equal(visibleLength("你好"), 4);
	assert.equal(visibleLength("a你b"), 4);
	assert.equal(visibleLength(""), 0);
});

test("renderMarkdown returns [] for empty / null input", () => {
	assert.deepEqual(renderMarkdown(""), []);
	assert.deepEqual(renderMarkdown(null), []);
	assert.deepEqual(renderMarkdown(undefined), []);
});

test("renderMarkdown keeps bare text visible after stripping SGR", () => {
	const rows = renderMarkdown("just some plain prose with no markup", { width: 80 });
	assert.ok(rows.length >= 1);
	assert.equal(stripAnsi(rows.join("\n")), "just some plain prose with no markup");
});

test("headings render level markers and bold SGR", () => {
	for (let level = 1; level <= 6; level++) {
		const rows = renderMarkdown(`${"#".repeat(level)} Title ${level}`, { width: 80 });
		const text = stripAnsi(rows.join("\n"));
		assert.ok(text.includes(`${"#".repeat(level)} Title ${level}`), `h${level}`);
		assert.ok(rows.join("").includes(BOLD), `h${level} bold`);
	}
});

test("paragraphs wrap at the configured width", () => {
	const sentence = "the quick brown fox jumps over the lazy dog and then keeps going";
	const rows = renderMarkdown(sentence, { width: 20 });
	assert.ok(rows.length >= 2, "should wrap to multiple rows");
	for (const row of rows) {
		assert.ok(visibleLength(row) <= 20, `row within width: ${visibleLength(row)}`);
	}
	// Wrapped rows end with the inter-word space that preceded the break, so
	// normalize whitespace when reconstructing the original sentence.
	assert.equal(stripAnsi(rows.join("\n")).replace(/\s+/g, " ").trim(), sentence);
});

test("inline bold, italic and strikethrough emit SGR", () => {
	const rows = renderMarkdown("a **bold** and *italic* and ~~gone~~ word", { width: 80 });
	const joined = rows.join("");
	assert.ok(joined.includes(BOLD), "bold");
	assert.ok(joined.includes(ITALIC), "italic");
	assert.ok(joined.includes(STRIKE), "strike");
	assert.equal(stripAnsi(joined), "a bold and italic and gone word");
});

test("inline code is rendered without interpreting its contents", () => {
	const rows = renderMarkdown("use `a * b` here", { width: 80 });
	assert.equal(stripAnsi(rows.join("")), "use a * b here");
});

test("links emit OSC 8 hyperlinks with the url and accessible text", () => {
	const rows = renderMarkdown("see [docs](https://example.com) now", { width: 80 });
	const joined = rows.join("");
	assert.ok(joined.includes("\x1b]8;;https://example.com\x1b\\"), "osc8 open");
	assert.ok(joined.includes("\x1b]8;;\x1b\\"), "osc8 close");
	assert.ok(joined.includes(UNDERLINE), "underline");
	assert.equal(stripAnsi(joined), "see docs now");
});

test("autolinks and bare urls become clickable", () => {
	const rows = renderMarkdown("visit https://example.com today", { width: 80 });
	assert.ok(rows.join("").includes("\x1b]8;;https://example.com\x1b\\"));
});

test("unordered lists with markers render nested hanging indentation", () => {
	const md = "- one\n- two\n  - nested a\n  - nested b\n- three";
	const rows = renderMarkdown(md, { width: 40 });
	const text = stripAnsi(rows.join("\n"));
	assert.ok(text.includes("one"));
	assert.ok(text.includes("two"));
	assert.ok(text.includes("nested a"));
	assert.ok(text.includes("nested b"));
	assert.ok(text.includes("three"));
});

test("ordered lists auto-number", () => {
	const md = "1. first\n2. second\n3. third";
	const rows = renderMarkdown(md, { width: 40 });
	const text = stripAnsi(rows.join("\n"));
	assert.ok(text.includes("1."), "first number");
	assert.ok(text.includes("2."), "second number");
	assert.ok(text.includes("3."), "third number");
});

test("task lists render check / cross marks", () => {
	const md = "- [ ] todo item\n- [x] done item";
	const rows = renderMarkdown(md, { width: 40 });
	const text = stripAnsi(rows.join("\n"));
	assert.ok(text.includes("todo item"));
	assert.ok(text.includes("done item"));
});

test("blockquotes render a border and nested content", () => {
	const md = "> quoted line\n> another";
	const rows = renderMarkdown(md, { width: 40 });
	const text = stripAnsi(rows.join("\n"));
	assert.ok(text.includes("quoted line"));
	assert.ok(text.includes("another"));
	// At least one row should carry the vertical border character.
	assert.ok(rows.join("").includes("│"));
});

test("GFM tables render with column borders and alignment", () => {
	const md = [
		"| Name | Score |",
		"|------|------:|",
		"| Ada  | 95    |",
		"| Bob  | 80    |",
	].join("\n");
	const rows = renderMarkdown(md, { width: 40 });
	const joined = rows.join("");
	assert.ok(joined.includes("│"), "column border");
	assert.ok(joined.includes("Name"));
	assert.ok(joined.includes("Score"));
	assert.ok(joined.includes("Ada"));
	assert.ok(joined.includes("95"));
});

test("horizontal rule renders a bordered line", () => {
	const rows = renderMarkdown("text\n\n---\n\nmore", { width: 20 });
	assert.ok(rows.some((row) => row.includes("─")));
});

test("fenced code blocks render a border, language label and highlight", () => {
	const md = "```js\nconst x = 42;\n```";
	const rows = renderMarkdown(md, { width: 40 });
	const joined = rows.join("\n");
	// Border line + label line + code line + closing border.
	assert.ok(joined.includes("│"), "left border present");
	assert.ok(joined.includes("js"), "language label present");
	assert.ok(joined.includes("const"), "code content present");
	// The keyword `const` should be highlighted.
	assert.ok(joined.includes(BOLD) || joined.includes(ESC), "some SGR present");
	assert.ok(stripAnsi(rows[0]).startsWith("╭"), "standalone rounded frame starts the block");
	assert.ok(stripAnsi(rows.at(-1)).startsWith("╰"), "standalone rounded frame closes the block");
});

test("unfinished streaming fence still renders as a code block", () => {
	const rows = renderMarkdown("```ts\nconst answer = 42", { width: 40 });
	assert.equal(stripAnsi(rows[0]).includes("ts"), true);
	assert.ok(stripAnsi(rows.join("\n")).includes("const answer = 42"));
});

test("output blocks use semantic state surfaces", () => {
	const rows = renderOutputBlock({ header: "Bash", state: "running", sections: [{ lines: ["echo ok"] }], width: 30 });
	assert.ok(rows.join("\n").includes(`48;2;${TSUKUYOMI_PALETTE.toolPending}m`));
	assert.equal(stripAnsi(rows[0]).startsWith("╭"), true);
	assert.equal(stripAnsi(rows.at(-1)).startsWith("╰"), true);
});

test("streaming code blocks preserve native highlighting state", () => {
	const streamState = {};
	const first = renderStreamingCodeBlock("```ts\nconst answer =", { width: 40, streamState });
	const second = renderStreamingCodeBlock("```ts\nconst answer = 42\nreturn answer", { width: 40, streamState });
	assert.ok(first && second);
	assert.match(stripAnsi(second.join("\n")), /const answer = 42/);
	assert.ok(second.every((row) => visibleLength(row) <= 40));
});

test("mixed content after a closed streaming fence uses full Markdown rendering", () => {
	const rows = renderStreamingCodeBlock("```js\nconst answer = 42\n```\nAfter", { width: 40, streamState: {} });
	assert.equal(rows, undefined);
});

test("code blocks do not wrap long lines", () => {
	const longLine = "x".repeat(120);
	const md = "```\n" + longLine + "\n```";
	const rows = renderMarkdown(md, { width: 40 });
	const codeRow = rows.find((row) => stripAnsi(row).includes("x"));
	assert.ok(codeRow && visibleLength(codeRow) <= 40, "code line stays within the output frame");
});

test("highlight decorates JavaScript keywords and strings", () => {
	const out = highlight('const x = "hi";', "js");
	// Keyword `const` and string "hi" are each wrapped in their own SGR span.
	assert.ok(out.includes(RESET) || out.includes(`${ESC}39m`), "each span resets its foreground");
	assert.ok(out.includes(ESC), "emits SGR sequences");
	const stripped = stripAnsi(out);
	assert.ok(stripped.includes("const"));
	assert.ok(stripped.includes('"hi"'));
	assert.ok(out.includes(`38;2;${TSUKUYOMI_PALETTE.syntaxKeyword}m`), "theme keyword color");
	assert.ok(out.includes(`38;2;${TSUKUYOMI_PALETTE.syntaxString}m`), "theme string color");
});

test("highlight handles JSON keys versus strings", () => {
	const out = highlight('{"key": "value"}', "json");
	const stripped = stripAnsi(out);
	assert.ok(stripped.includes('"key"'));
	assert.ok(stripped.includes('"value"'));
});

test("highlight falls back to plain text for unknown languages", () => {
	const out = highlight("anything at all", "unknowndialect");
	assert.equal(out, `${ESC}38;2;${TSUKUYOMI_PALETTE.text}manything at all`);
});

test("highlight covers python, bash and sql without throwing", () => {
	assert.doesNotThrow(() => highlight("def f(x): return x", "python"));
	assert.doesNotThrow(() => highlight("echo hello # comment", "bash"));
	assert.doesNotThrow(() => highlight("SELECT * FROM t;", "sql"));
	assert.ok(stripAnsi(highlight("echo hi", "bash")).includes("echo hi"));
});

test("langFromPath maps common extensions", () => {
	assert.equal(langFromPath("a.js"), "js");
	assert.equal(langFromPath("a.mjs"), "js");
	assert.equal(langFromPath("a.ts"), "ts");
	assert.equal(langFromPath("a.py"), "python");
	assert.equal(langFromPath("a.json"), "json");
	assert.equal(langFromPath("a.yaml"), "yaml");
	assert.equal(langFromPath("a.sh"), "bash");
	assert.equal(langFromPath("a.sql"), "sql");
	assert.equal(langFromPath("a.md"), "markdown");
	assert.equal(langFromPath("noext"), undefined);
});

test("inlineAnsi renders bold and inline code without block parsing", () => {
	const out = inlineAnsi("a **b** and `c`");
	assert.ok(out.includes(BOLD));
	assert.equal(stripAnsi(out), "a b and c");
});

test("escaped markdown punctuation renders literally", () => {
	const rows = renderMarkdown("a \\*literal\\* star", { width: 80 });
	assert.equal(stripAnsi(rows.join("")), "a *literal* star");
});
