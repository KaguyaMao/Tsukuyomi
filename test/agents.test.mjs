import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentId, deleteAgent, exportAgents, getAgent, listAgents, normalizeAgent, saveAgent } from "../app/agents.mjs";

test("agent ids are stable and filesystem-safe", () => {
	assert.equal(agentId("  Code Reviewer / 中文  "), "code-reviewer");
	assert.equal(agentId("..."), "agent");
});

test("saved agents keep independent model, account, prompt, and thinking settings", () => {
	const dir = mkdtempSync(join(tmpdir(), "tsukuyomi-agents-test-"));
	const saved = saveAgent(dir, {
		name: "Reviewer", provider: "anthropic", model: "claude-sonnet",
		accountRef: { providerId: "anthropic", id: "work" }, thinking: "high",
		systemPrompt: "Review only. Do not edit.", mode: "plan", tools: ["read", "grep", "read"],
	});
	assert.equal(saved.id, "reviewer");
	assert.deepEqual(getAgent(dir, "Reviewer").tools, ["read", "grep"]);
	assert.equal(listAgents(dir)[0].accountRef.id, "work");
	assert.equal(exportAgents(dir)[0].systemPrompt, undefined);
	assert.equal(deleteAgent(dir, saved.id), true);
	assert.deepEqual(listAgents(dir), []);
});

test("invalid thinking levels are rejected", () => {
	assert.throws(() => normalizeAgent({ name: "Bad", thinking: "infinite" }), /Unsupported thinking/);
});
