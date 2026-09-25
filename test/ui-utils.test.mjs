import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolvePiTui } from "../app/pi-runtime.mjs";
import { createTsukuyomiDesignSystem } from "../app/design-system.mjs";
import { assistantErrorMessage, compositeTuiOverlayLine, paintBackground } from "../app/ui-utils.mjs";

const assistant = (overrides = {}) => ({ role: "assistant", content: [], stopReason: "stop", ...overrides });

test("assistantErrorMessage ignores a healthy turn", () => {
	assert.equal(assistantErrorMessage(assistant()), undefined);
	assert.equal(assistantErrorMessage(assistant({ content: [{ type: "text", text: "done" }] })), undefined);
});

test("assistantErrorMessage ignores an aborted turn even with an error message", () => {
	assert.equal(assistantErrorMessage(assistant({ stopReason: "aborted", errorMessage: "cancelled" })), undefined);
});

test("assistantErrorMessage surfaces a provider failure and collapses whitespace", () => {
	assert.equal(
		assistantErrorMessage(assistant({ stopReason: "error", errorMessage: "Codex error:\n  servers   overloaded" })),
		"Codex error: servers overloaded",
	);
});

test("assistantErrorMessage falls back to the text content when errorMessage is absent", () => {
	assert.equal(
		assistantErrorMessage(assistant({ stopReason: "error", content: [{ type: "text", text: "HTTP 503" }] })),
		"HTTP 503",
	);
});

test("assistantErrorMessage redacts credentials and strips terminal control", () => {
	const message = assistant({ stopReason: "error", errorMessage: "failed Authorization: Bearer sk-secret\u0007" });
	const text = assistantErrorMessage(message);
	assert.ok(text.includes("Bearer [REDACTED]"));
	assert.ok(!text.includes("sk-secret"));
	assert.ok(!text.includes("\u0007"));
});

test("assistantErrorMessage requires an assistant role", () => {
	assert.equal(assistantErrorMessage({ role: "user", errorMessage: "boom" }), undefined);
	assert.equal(assistantErrorMessage(undefined), undefined);
});

test("compositeTuiOverlayLine restores the canvas after a clipped modal background", async () => {
	const tuiPath = resolvePiTui({ appRoot: process.cwd() });
	const { compositeTuiLine } = await import(pathToFileURL(tuiPath).href);
	const design = createTsukuyomiDesignSystem();
	const overlayWidth = 60;
	const totalWidth = 100;
	const overlay = `${paintBackground("picker".padEnd(overlayWidth), design.backgrounds.menu)}${design.backgrounds.canvas}`;
	const menuIndex = (value) => value.lastIndexOf(design.backgrounds.menu);
	const raw = compositeTuiLine(" ".repeat(totalWidth), overlay, 0, overlayWidth, totalWidth);
	assert.equal(raw.indexOf(design.backgrounds.canvas, menuIndex(raw) + design.backgrounds.menu.length), -1);

	const fixed = compositeTuiOverlayLine(" ".repeat(totalWidth), overlay, {
		startCol: 0,
		overlayWidth,
		totalWidth,
		background: design.backgrounds.canvas,
		composite: compositeTuiLine,
	});
	assert.ok(fixed.indexOf(design.backgrounds.canvas, menuIndex(fixed) + design.backgrounds.menu.length) >= 0);
});
