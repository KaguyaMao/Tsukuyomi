import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyModelVisibility,
	interpolate,
	listProviderConfigs,
	loadProvidersConfig,
	normalizeProvider,
	parseInterpolation,
	removeProviderConfig,
	resolveApi,
	saveProviderConfig,
} from "../../app/providers/config/opencode.mjs";
import { AuthErrorCode } from "../../app/providers/errors.mjs";

const agentDir = () => mkdtempSync(join(tmpdir(), "tsukuyomi-providers-"));

test("resolveApi maps opencode npm packages and honours an explicit api", () => {
	assert.equal(resolveApi({ npm: "@ai-sdk/openai-compatible" }), "openai-completions");
	assert.equal(resolveApi({ npm: "@ai-sdk/anthropic" }), "anthropic-messages");
	assert.equal(resolveApi({ npm: "@ai-sdk/openai", api: "anthropic-messages" }), "anthropic-messages");
	assert.equal(resolveApi({ api: "openai-responses" }), "openai-responses");
	assert.throws(() => resolveApi({ npm: "@ai-sdk/nope" }), (error) => error.code === AuthErrorCode.CONFIG);
});

test("parseInterpolation understands env and file forms", () => {
	assert.deepEqual(parseInterpolation("{env:MY_KEY}"), { kind: "env", name: "MY_KEY" });
	assert.deepEqual(parseInterpolation("{file:~/.secrets/key}"), { kind: "file", path: "~/.secrets/key" });
	assert.deepEqual(parseInterpolation("sk-literal"), { kind: "literal", value: "sk-literal" });
});

test("interpolate resolves env without touching the literal", () => {
	assert.equal(interpolate("{env:TOKEN}", { env: { TOKEN: "abc" } }), "abc");
	assert.equal(interpolate("plain", {}), "plain");
	assert.throws(() => interpolate("{env:MISSING}", { env: {} }), (error) => error.code === AuthErrorCode.CONFIG);
});

test("normalizeProvider rejects bad ids, urls, and empty entries", () => {
	assert.throws(() => normalizeProvider("Bad Id", { baseURL: "https://x.dev" }), (error) => error.code === AuthErrorCode.CONFIG);
	assert.throws(() => normalizeProvider("ok", { baseURL: "ftp://x.dev" }), (error) => error.code === AuthErrorCode.CONFIG);
	assert.throws(() => normalizeProvider("ok", { baseURL: "http://example.com" }), (error) => error.code === AuthErrorCode.CONFIG);
	assert.throws(() => normalizeProvider("ok", {}), (error) => error.code === AuthErrorCode.CONFIG);
});

test("normalizeProvider accepts loopback http and normalizes models", () => {
	const cfg = normalizeProvider("local", {
		api: "openai-completions",
		baseURL: "http://127.0.0.1:11434/v1/",
		models: { "llama-3": { name: "Llama 3", limit: { context: 128000, output: 8192 } } },
	});
	assert.equal(cfg.baseURL, "http://127.0.0.1:11434/v1");
	assert.deepEqual(cfg.models[0], { id: "llama-3", name: "Llama 3", contextWindow: 128000, maxTokens: 8192 });
});

test("normalizeProvider rejects non-positive token limits", () => {
	assert.throws(
		() => normalizeProvider("x", { baseURL: "https://x.dev", models: [{ id: "m", contextWindow: 0 }] }),
		(error) => error.code === AuthErrorCode.CONFIG,
	);
});

test("save/load/remove round-trips providers.json with 0600 permissions", () => {
	const dir = agentDir();
	saveProviderConfig(dir, "myprovider", {
		name: "My Provider",
		api: "openai-completions",
		baseURL: "https://api.example.com/v1",
		apiKey: "{env:MY_KEY}",
		models: [{ id: "model-1", name: "Model 1" }],
	});
	const loaded = loadProvidersConfig(dir);
	assert.equal(loaded.error, undefined);
	assert.ok(loaded.config.provider.myprovider);
	const listed = listProviderConfigs(dir);
	assert.equal(listed.error, undefined);
	assert.equal(listed.providers.length, 1);
	assert.equal(listed.providers[0].id, "myprovider");
	assert.equal(listed.providers[0].apiKey, "{env:MY_KEY}");
	assert.equal(statSync(loaded.path).mode & 0o777, 0o600);

	removeProviderConfig(dir, "myprovider");
	assert.deepEqual(listProviderConfigs(dir).providers, []);
});

test("saveProviderConfig refuses to clobber an invalid file", () => {
	const dir = agentDir();
	saveProviderConfig(dir, "a", { baseURL: "https://a.dev", models: [{ id: "m" }] });
	const path = join(dir, "providers.json");
	writeFileSync(path, "{ not json");
	const loaded = loadProvidersConfig(dir);
	assert.match(loaded.error, /Failed to parse/);
	assert.throws(() => saveProviderConfig(dir, "b", { baseURL: "https://b.dev", models: [{ id: "m" }] }));
});

test("applyModelVisibility honours whitelist then blacklist", () => {
	const models = [{ id: "a" }, { id: "b" }, { id: "c" }];
	assert.deepEqual(applyModelVisibility(models, { whitelist: ["a", "b"] }).map((m) => m.id), ["a", "b"]);
	assert.deepEqual(applyModelVisibility(models, { blacklist: ["b"] }).map((m) => m.id), ["a", "c"]);
	assert.deepEqual(applyModelVisibility(models, { whitelist: ["a", "b", "c"], blacklist: ["a"] }).map((m) => m.id), ["b", "c"]);
});

test("providers.json supports comments and trailing commas", () => {
	const dir = agentDir();
	writeFileSync(join(dir, "providers.json"), `{
		// inline docs
		"provider": {
			"commented": { "api": "openai-completions", "baseURL": "https://c.dev", "models": [{ "id": "m" },], },
		},
	}`);
	const listed = listProviderConfigs(dir);
	assert.equal(listed.error, undefined);
	assert.equal(listed.providers[0].id, "commented");
});
