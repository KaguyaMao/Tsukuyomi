import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeImport, parseCodexImport } from "../../app/providers/config/native-import.mjs";

test("Codex native config preserves provider protocol, model, reasoning and keeps the key separate", () => {
	const result = parseCodexImport(`model = "gpt-6-sol"
model_provider = "rinko"
model_reasoning_effort = "high"
[model_providers.rinko]
name = "Rinko"
base_url = "https://rinko.example/v1"
wire_api = "responses"
env_key = "RINKO_API_KEY"
`, JSON.stringify({ RINKO_API_KEY: "fixture-secret" }), { env: {} });
	assert.equal(result.config.id, "rinko");
	assert.equal(result.config.api, "openai-responses");
	assert.equal(result.config.models[0].reasoning, true);
	assert.equal(result.config.models[0].id, "gpt-6-sol");
	assert.equal(result.credential.key, "fixture-secret");
	assert.ok(!JSON.stringify(result.config).includes("fixture-secret"));
});

test("Claude Code settings and credentials preserve the selected model and bearer mode", () => {
	const result = parseClaudeImport(JSON.stringify({ model: "claude-sonnet-4-5", env: { ANTHROPIC_BASE_URL: "https://relay.example", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5" } }), JSON.stringify({ ANTHROPIC_AUTH_TOKEN: "fixture-token" }));
	assert.equal(result.config.api, "anthropic-messages");
	assert.equal(result.config.authHeader, true);
	assert.deepEqual(result.config.models.map((model) => model.id), ["claude-sonnet-4-5", "claude-haiku-4-5"]);
	assert.equal(result.credential.key, "fixture-token");
	assert.ok(!JSON.stringify(result.config).includes("fixture-token"));
});

test("native imports reject missing models rather than probing a relay", () => {
	assert.throws(() => parseCodexImport("model_provider = 'rinko'", "{}"), /model value/);
	assert.throws(() => parseClaudeImport("{}", '{"ANTHROPIC_API_KEY":"fixture"}'), /needs model/);
	assert.throws(() => parseCodexImport("model = 'gpt-6-sol'", "[]"), /expected a JSON object/);
});

test("Codex active profile overrides the root model and reasoning effort", () => {
	const result = parseCodexImport(`model = "fallback"
profile = "work"
[profiles.work]
model = "gpt-6-sol"
model_provider = "Rinko.Production"
model_reasoning_effort = "high"
[model_providers."Rinko.Production"]
base_url = "https://relay.example/v1"
wire_api = "responses"
`, '{"OPENAI_API_KEY":"fixture-secret"}');
	assert.equal(result.config.id, "rinko-production");
	assert.equal(result.config.models[0].id, "gpt-6-sol");
	assert.equal(result.thinking, "high");
});
