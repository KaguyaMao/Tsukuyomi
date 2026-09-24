import test from "node:test";
import assert from "node:assert/strict";
import { registerQuestionnaire } from "../src/questionnaire.ts";
import { encodeOverlayResult } from "../app/tui/overlay-result.mjs";

const questions = [{ id: "scope", header: "Scope", question: "Which scope?", options: [{ label: "Small", value: "small", recommended: true }, { label: "Large" }] }, { id: "risk", question: "Which risk?", options: [{ label: "Low", value: "low" }] }];

test("rpc questionnaire asks once and accepts the full tabbed answer set", async () => {
	let tool;
	registerQuestionnaire({ registerTool: (value) => { tool = value; } });
	let payload;
	const ctx = { hasUI: true, mode: "rpc", ui: { setWidget: () => {}, select: async (_title, _options) => encodeOverlayResult("Submit", { answers: [{ id: "scope", value: "small", label: "Small" }, { id: "risk", value: "low", label: "Low" }] }) } };
	const original = ctx.ui.select;
	ctx.ui.select = async (title, options) => { payload = { title, options }; return original(title, options); };
	const result = await tool.execute("id", { questions }, undefined, undefined, ctx);
	assert.equal(payload.options[0], "Submit");
	assert.equal(result.details.cancelled, false);
	assert.deepEqual(result.details.answers.map((answer) => answer.value), ["small", "low"]);
});

test("rpc questionnaire cancel does not submit partial answers", async () => {
	let tool;
	registerQuestionnaire({ registerTool: (value) => { tool = value; } });
	const ctx = { hasUI: true, mode: "rpc", ui: { setWidget: () => {}, select: async () => undefined } };
	const result = await tool.execute("id", { questions }, undefined, undefined, ctx);
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.answers.length, 0);
});
