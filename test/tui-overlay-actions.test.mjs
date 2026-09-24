import test from "node:test";
import assert from "node:assert/strict";
import { createPlanSession, planCommand, planFeedback, planResult, joinPlan } from "../app/tui/plan-session.mjs";
import { askAnswers, askCommand, createAskSession } from "../app/tui/ask-session.mjs";
import { decodeOverlayResult } from "../app/tui/overlay-result.mjs";

test("plan review can delete a section, annotate, undo, and return the edited plan", () => {
	const session = createPlanSession({ body: "# Keep\nA\n## Drop\nB\n# Stay\nC", options: ["Execute the plan (track progress)", "Stay in plan mode", "Refine the plan"], slider: ["low", "high"] });
	planCommand(session, "tab");
	planCommand(session, "down");
	assert.equal(planCommand(session, "delete"), "edited");
	assert.equal(joinPlan(session).includes("Drop"), false);
	assert.equal(planCommand(session, "undo"), "edited");
	assert.equal(joinPlan(session).includes("Drop"), true);
	planCommand(session, "annotate");
	planCommand(session, "type", "check this");
	planCommand(session, "submit", "check this");
	assert.match(planFeedback(session), /check this/);
	planCommand(session, "tab");
	planCommand(session, "tab");
	planCommand(session, "right");
	const decoded = decodeOverlayResult(planResult(session), session.options);
	assert.equal(decoded.choice, "Execute the plan (track progress)");
	assert.equal(decoded.extra.slider, "high");
	assert.match(decoded.extra.planText, /Keep/);
});

test("ask session switches tabs and submits every answer, including a custom one", () => {
	const session = createAskSession([{ id: "scope", header: "Scope", question: "Which?", options: [{ label: "Small", value: "small", recommended: true }] }, { id: "risk", question: "Risk?", options: [{ label: "Low", value: "low" }], allowOther: true }]);
	assert.equal(askCommand(session, "enter"), "advance");
	assert.equal(session.tab, 1);
	askCommand(session, "down");
	assert.equal(askCommand(session, "enter"), "prompt");
	askCommand(session, "submit", "custom risk");
	askCommand(session, "tab");
	assert.equal(askCommand(session, "enter"), "submit");
	assert.deepEqual(askAnswers(session).map((answer) => answer.value), ["small", "custom risk"]);
});
