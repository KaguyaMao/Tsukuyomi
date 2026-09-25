import test from "node:test";
import assert from "node:assert/strict";
import { wideComposerGeometry } from "../app/tui/composer-layout.mjs";
import { renderUserMessageBand } from "../app/tui/message-band.mjs";

const stripAnsi = (value) => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

for (const columns of [40, 60, 80, 120, 160]) {
	test(`wide composer geometry expands to ${columns} terminal columns`, () => {
		const geometry = wideComposerGeometry(columns, 5);
		assert.equal(geometry.minimal, columns < 8);
		assert.equal(geometry.columns, columns);
		assert.equal(geometry.contentWidth, Math.max(1, columns - 4));
		assert.equal(geometry.statusAvailable, Math.max(0, columns - 6));
	});
}

test("tiny composer geometry keeps the existing one-row fallback", () => {
	assert.equal(wideComposerGeometry(7, 5).minimal, true);
	assert.equal(wideComposerGeometry(80, 1).minimal, true);
	assert.equal(wideComposerGeometry(80, 2).minimal, false);
});

test("user prompt band retains breathing rows above and below the message", () => {
	const painted = [];
	const color = { text: (value) => value };
	const rows = renderUserMessageBand({
		width: 120,
		prompt: "short",
		timestamp: undefined,
		locale: "en",
		visibleWidth: (value) => stripAnsi(value).length,
		pad: (value, width) => `${value}${" ".repeat(Math.max(0, width - stripAnsi(value).length))}`,
		promptPrefix: () => "❯",
		textRows: (_owner, _field, value) => ({ rows: [value], sgr: false }),
		formatTime: () => "",
		bandBackground: (value) => { painted.push(stripAnsi(value).length); return value; },
		color,
	});
	assert.deepEqual(rows.map((row) => stripAnsi(row).length), [118, 118, 118]);
	assert.ok(painted.length >= 2);
	assert.ok(painted.every((rowWidth) => rowWidth === 118));
	assert.match(rows[1], /❯ short/);
	assert.equal(stripAnsi(rows[0]).trim(), "");
	assert.equal(stripAnsi(rows[2]).trim(), "");
});

test("user prompt band remains full-width with timestamps and empty text", () => {
	const painted = [];
	const rows = renderUserMessageBand({
		width: 80,
		prompt: "",
		timestamp: 0,
		locale: "en",
		visibleWidth: (value) => stripAnsi(value).length,
		pad: (value, width) => `${value}${" ".repeat(Math.max(0, width - stripAnsi(value).length))}`,
		promptPrefix: () => "❯",
		textRows: () => ({ rows: [], sgr: false }),
		formatTime: () => "12:00 AM",
		bandBackground: (value) => { painted.push(stripAnsi(value).length); return value; },
		color: { text: (value) => value },
	});
	assert.deepEqual(rows.map((row) => stripAnsi(row).length), [78, 78, 78]);
	assert.ok(painted.length >= 2);
	assert.ok(painted.every((rowWidth) => rowWidth === 78));
});
