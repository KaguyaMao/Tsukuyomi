import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateOpenCodeAuth, normalizeOpenCodeCredential, targetProviderId } from "../../app/providers/opencode-auth.mjs";

test("OpenCode credentials convert to PI auth types and map OpenAI OAuth", () => {
	assert.deepEqual(normalizeOpenCodeCredential({ type: "api", key: "secret" }), { type: "api_key", key: "secret" });
	assert.equal(targetProviderId("openai", { type: "oauth" }), "openai-codex");
	assert.equal(targetProviderId("openai", { type: "api_key" }), "openai");
});

test("OpenCode migration imports credentials, accounts, and custom provider config", () => {
	const source = mkdtempSync(join(tmpdir(), "tsukuyomi-opencode-source-"));
	const target = mkdtempSync(join(tmpdir(), "tsukuyomi-opencode-target-"));
	const sourceAuth = join(source, "auth.json");
	const sourceConfig = join(source, "opencode.jsonc");
	writeFileSync(sourceAuth, JSON.stringify({
		deepseek: { type: "api", key: "deepseek-secret" },
		openai: { type: "oauth", access: "access-secret", refresh: "refresh-secret", expires: 123, accountId: "acct-1" },
		rosita: { type: "api", key: "rosita-secret" },
		invalid: { type: "unknown", value: "nope" },
	}));
	writeFileSync(sourceConfig, JSON.stringify({ provider: { rosita: { npm: "@ai-sdk/openai-compatible", baseURL: "https://api.example.test/v1", models: { opus: { name: "Opus" } } } } }));
	const report = migrateOpenCodeAuth({ sourcePath: sourceAuth, configPath: sourceConfig, targetDir: target });
	assert.deepEqual(report.imported.sort(), ["deepseek", "openai-codex", "rosita"]);
	assert.deepEqual(report.invalid, ["invalid"]);
	const auth = JSON.parse(readFileSync(join(target, "auth.json"), "utf8"));
	assert.equal(auth.deepseek.type, "api_key");
	assert.equal(auth["openai-codex"].accountId, "acct-1");
	assert.equal(statSync(join(target, "auth.json")).mode & 0o777, 0o600);
	const providers = JSON.parse(readFileSync(join(target, "providers.json"), "utf8"));
	assert.equal(providers.provider.rosita.baseURL, "https://api.example.test/v1");
	const models = JSON.parse(readFileSync(join(target, "models.json"), "utf8"));
	assert.equal(models.providers.rosita.models[0].id, "opus");
});
