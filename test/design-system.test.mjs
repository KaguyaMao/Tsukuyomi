import { test } from "node:test";
import assert from "node:assert/strict";
import { createTsukuyomiDesignSystem, TSUKUYOMI_PALETTE, renderListRow, statusToken } from "../app/design-system.mjs";

test("shared design system uses the Mocha surfaces and gold Ti brand", () => {
	assert.equal(TSUKUYOMI_PALETTE.canvas, "30;30;46");
	assert.equal(TSUKUYOMI_PALETTE.brand, "249;226;175");
	const design = createTsukuyomiDesignSystem();
	assert.match(design.fg.brand("Ti"), /38;2;249;226;175m/);
	assert.match(design.backgrounds.canvas, /48;2;30;30;46m/);
	assert.equal(TSUKUYOMI_PALETTE.panelHover, "69;71;90");
	assert.equal(TSUKUYOMI_PALETTE.band, "49;50;68");
	assert.equal(TSUKUYOMI_PALETTE.borderMuted, "69;71;90");
	assert.equal(TSUKUYOMI_PALETTE.border, "88;91;112");
	assert.equal(TSUKUYOMI_PALETTE.tool, "36;39;58");
	assert.equal(TSUKUYOMI_PALETTE.toolPending, "45;53;76");
	assert.notEqual(TSUKUYOMI_PALETTE.thinkingLow, TSUKUYOMI_PALETTE.thinkingMedium);
	assert.equal(TSUKUYOMI_PALETTE.syntaxKeyword, "203;166;247");
});

test("shared rows expose consistent selected and status states", () => {
	const design = createTsukuyomiDesignSystem();
	assert.match(renderListRow({ label: "Reviewer", selected: true }, design), /❯/);
	assert.match(statusToken("running", design), /●/);
	assert.match(statusToken("failed", design), /×/);
});
