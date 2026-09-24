import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantErrorMessage } from "../app/ui-utils.mjs";

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
