import test from "node:test";
import assert from "node:assert/strict";
import { layoutPlanReview, parsePlanSections } from "../app/tui/plan-review.mjs";
import { askPanelModel } from "../app/tui/ask-panel.mjs";

test("plan sections keep headings and a preamble", () => {
	const sections = parsePlanSections("Intro\n\n# Plan\n\n## Step\nDo it");
	assert.equal(sections[0].title, "Plan");
	assert.equal(sections.at(-1).title, "Step");
	assert.equal(sections.at(-1).level, 2);
});

test("plan review is one surface with body above actions and a wide contents rail", () => {
	const model = layoutPlanReview({
		width: 100,
		height: 24,
		body: "# One\nAlpha\n## Two\nBeta",
		options: ["Execute the plan (track progress)", "Stay in plan mode", "Refine the plan"],
		focus: "actions",
	});
	assert.equal(model.sidebar, true);
	assert.equal(model.focus, "actions");
	assert.equal(model.regions[0].title, "Plan Review");
	const options = model.regions.filter((row) => row.type === "option").map((row) => row.label);
	assert.deepEqual(options, ["Execute the plan (track progress)", "Stay in plan mode", "Refine the plan"]);
	const firstOption = model.regions.findIndex((row) => row.type === "option");
	const lastBody = model.regions.findLastIndex((row) => row.type === "body");
	assert.ok(lastBody < firstOption, "actions stay beneath the plan body");
	assert.equal(model.regions.filter((row) => row.type === "body").length >= 3, true);
});

test("plan review scroll stays inside the body and does not invent actions", () => {
	const model = layoutPlanReview({ width: 60, height: 12, body: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), options: ["Stay"], scroll: 999 });
	assert.equal(model.sidebar, false);
	assert.equal(model.scroll, model.maxScroll);
	assert.equal(model.regions.some((row) => row.label === "Revive"), false);
});

test("ask panel shows tabs, recommendation, and separate descriptions", () => {
	const panel = askPanelModel({
		width: 90,
		height: 30,
		questions: [{ header: "Scope", question: "Which scope?" }, { header: "Risk", question: "Which risk?" }],
		index: 1,
		options: [{ label: "Small", description: "Less code", recommended: true }, { label: "Large", description: "Broader change" }],
		selected: 0,
		answers: [{ id: "scope" }],
	});
	assert.equal(panel.title, "Ask");
	assert.equal(panel.tabs[0].done, true);
	assert.equal(panel.tabs[1].active, true);
	assert.equal(panel.options[0].recommended, true);
	assert.equal(panel.options[0].description, "Less code");
	assert.ok(panel.boxHeight < 30);
});
