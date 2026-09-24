import { test } from "node:test";
import assert from "node:assert/strict";
import { createTsukuyomiDesignSystem, TSUKUYOMI_PALETTE, renderListRow, statusToken } from "../app/design-system.mjs";

test("shared design system preserves Tsukuyomi brand tokens", () => {
	assert.equal(TSUKUYOMI_PALETTE.canvas, "18;18;18");
	assert.equal(TSUKUYOMI_PALETTE.brand, "212;192;144");
	const design = createTsukuyomiDesignSystem();
	assert.match(design.fg.brand("Tsukuyomi"), /38;2;212;192;144m/);
	assert.match(design.backgrounds.canvas, /48;2;18;18;18m/);
	assert.equal(TSUKUYOMI_PALETTE.panelHover, "0;130;179");
	assert.equal(TSUKUYOMI_PALETTE.band, "24;28;36");
	assert.equal(TSUKUYOMI_PALETTE.borderMuted, "78;88;104");
	assert.equal(TSUKUYOMI_PALETTE.border, "112;122;138");
	assert.equal(TSUKUYOMI_PALETTE.tool, "25;30;39");
	assert.equal(TSUKUYOMI_PALETTE.toolPending, "24;38;55");
	assert.notEqual(TSUKUYOMI_PALETTE.thinkingLow, TSUKUYOMI_PALETTE.thinkingMedium);
	assert.equal(TSUKUYOMI_PALETTE.syntaxKeyword, "0;180;255");
});

test("shared rows expose consistent selected and status states", () => {
	const design = createTsukuyomiDesignSystem();
	assert.match(renderListRow({ label: "Reviewer", selected: true }, design), /❯/);
	assert.match(statusToken("running", design), /●/);
	assert.match(statusToken("failed", design), /×/);
});
