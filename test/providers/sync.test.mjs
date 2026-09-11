import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeProvider, saveProviderConfig } from "../../app/providers/config/opencode.mjs";
import { loadModelsJson, upsertModelsProvider } from "../../app/providers/config/pi-models.mjs";
import {
	escapePiValue,
	importFromModelsJson,
	syncProviderToModelsJson,
	toOpencodeConfigValue,
	toOpencodeProvider,
	toPiConfigValue,
	toPiModelsProvider,
	toProviderConfigInput,
	unescapePiValue,
} from "../../app/providers/config/sync.mjs";

const agentDir = () => mkdtempSync(join(tmpdir(), "tsukuyomi-sync-"));

test("config value conversion maps env/file/literal both ways", () => {
	assert.equal(toPiConfigValue("{env:MY_KEY}"), "$MY_KEY");
	assert.equal(toPiConfigValue("{file:~/.secrets/key}"), "!cat '~/.secrets/key'");
	assert.equal(toPiConfigValue("sk-$literal"), "sk-$$literal");

	assert.equal(toOpencodeConfigValue("$MY_KEY"), "{env:MY_KEY}");
	assert.equal(toOpencodeConfigValue("${MY_KEY}"), "{env:MY_KEY}");
	assert.equal(toOpencodeConfigValue("!cat '/home/u/key'"), "{file:/home/u/key}");
	assert.equal(toOpencodeConfigValue("sk-$$literal"), "sk-$literal");
});

test("escapePiValue / unescapePiValue are inverse for $ and !", () => {
	assert.equal(unescapePiValue(escapePiValue("a$b!c")), "a$b!c");
});

test("toPiModelsProvider lowers limits and applies model visibility", () => {
	const cfg = normalizeProvider("p", {
		api: "anthropic-messages",
		baseURL: "https://p.dev",
		apiKey: "{env:P_KEY}",
		headers: { "X-Foo": "bar" },
		models: [
			{ id: "keep", name: "Keep", limit: { context: 200000, output: 65536 } },
			{ id: "drop", name: "Drop" },
		],
		blacklist: ["drop"],
	});
	const pi = toPiModelsProvider(cfg);
	assert.equal(pi.api, "anthropic-messages");
	assert.equal(pi.baseUrl, "https://p.dev");
	assert.equal(pi.apiKey, "$P_KEY");
	assert.deepEqual(pi.headers, { "X-Foo": "bar" });
	assert.deepEqual(pi.models.map((m) => m.id), ["keep"]);
	assert.equal(pi.models[0].contextWindow, 200000);
	assert.equal(pi.models[0].maxTokens, 65536);
});

test("toProviderConfigInput produces PI runtime model defaults", () => {
	const cfg = normalizeProvider("p", { api: "openai-completions", baseURL: "https://p.dev", models: [{ id: "m" }] });
	const input = toProviderConfigInput(cfg);
	assert.equal(input.api, "openai-completions");
	assert.equal(input.models[0].id, "m");
	assert.equal(input.models[0].reasoning, false);
	assert.deepEqual(input.models[0].input, ["text"]);
	assert.deepEqual(input.models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(input.models[0].contextWindow, 128000);
	assert.equal(input.models[0].maxTokens, 16384);
});

test("provider round-trip opencode -> PI -> opencode preserves key fields", () => {
	const cfg = normalizeProvider("roundtrip", {
		name: "Round Trip",
		api: "openai-completions",
		baseURL: "https://rt.dev/v1",
		apiKey: "{env:RT_KEY}",
		models: [{ id: "m1", name: "M1", contextWindow: 1000, maxTokens: 100 }],
	});
	const pi = toPiModelsProvider(cfg);
	const back = toOpencodeProvider("roundtrip", pi);
	assert.equal(back.name, "Round Trip");
	assert.equal(back.api, "openai-completions");
	assert.equal(back.baseURL, "https://rt.dev/v1");
	assert.equal(back.apiKey, "{env:RT_KEY}");
	assert.equal(back.models[0].id, "m1");
	assert.equal(back.models[0].contextWindow, 1000);
});

test("syncProviderToModelsJson writes PI models.json", () => {
	const dir = agentDir();
	const cfg = normalizeProvider("synced", { api: "openai-completions", baseURL: "https://s.dev", models: [{ id: "m" }] });
	syncProviderToModelsJson(dir, "synced", cfg);
	const { config } = loadModelsJson(dir);
	assert.ok(config.providers.synced);
	assert.equal(config.providers.synced.baseUrl, "https://s.dev");
});

test("importFromModelsJson pulls models.json-only providers into providers.json", () => {
	const dir = agentDir();
	upsertModelsProvider(dir, "handwritten", {
		name: "Hand Written",
		api: "openai-completions",
		baseUrl: "https://hand.dev",
		models: [{ id: "hm", name: "HM" }],
	});
	// Also add a provider that already exists in providers.json; it must be skipped.
	saveProviderConfig(dir, "known", { api: "openai-completions", baseURL: "https://known.dev", models: [{ id: "km" }] });
	syncProviderToModelsJson(dir, "known", normalizeProvider("known", { api: "openai-completions", baseURL: "https://known.dev", models: [{ id: "km" }] }));

	const result = importFromModelsJson(dir);
	assert.deepEqual(result.imported, ["handwritten"]);
	assert.ok(result.providers.includes("known"));
});
