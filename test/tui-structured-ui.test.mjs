import test from "node:test";
import assert from "node:assert/strict";
import { decodeStructuredTitle, readStructuredWidget, structuredPreview, structuredTitle } from "../app/tui/structured-ui.mjs";

const nonce = "11111111-2222-4333-8444-555555555555";
test("structured metadata binds to exactly one select title and cannot leak", () => {
	const payload = readStructuredWidget([JSON.stringify({ version: 1, nonce, kind: "plan-review", payload: { body: "Do not write" } })]);
	assert.ok(payload);
	const map = new Map([[nonce, payload]]);
	const match = decodeStructuredTitle(structuredTitle(nonce, "Review plan"), map);
	assert.equal(match.title, "Review plan");
	assert.equal(match.structured, payload);
	assert.equal(decodeStructuredTitle(structuredTitle(nonce, "Review plan"), map).structured, undefined);
	assert.equal(decodeStructuredTitle("Ordinary prompt", map).title, "Ordinary prompt");
});

test("malformed, unsupported, and oversized widget payloads are rejected", () => {
	assert.equal(readStructuredWidget(["{bad"]), undefined);
	assert.equal(readStructuredWidget([JSON.stringify({ version: 1, nonce, kind: "system", payload: {} })]), undefined);
	assert.equal(readStructuredWidget(["x".repeat(64_001)]), undefined);
	assert.equal(readStructuredWidget(["{}", "{}"]), undefined);
});

test("structured preview strips ANSI and limits long external text", () => {
	const preview = structuredPreview({ kind: "questionnaire", payload: { index: 0, total: 2, question: { header: "Task", question: "Choose\x1b[31m" }, answers: [] } });
	assert.ok(preview.some((line) => line.includes("QUESTION 1/2")));
	assert.ok(preview.every((line) => !line.includes("\x1b")));
	const plan = structuredPreview({ kind: "plan-review", payload: { body: "alpha\nbeta" } });
	assert.ok(plan.includes("alpha"));
});
