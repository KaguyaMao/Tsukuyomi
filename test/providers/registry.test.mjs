import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AUTH_ALIASES,
	listAuthMethods,
	loadProviderCatalog,
	oauthLabel,
	POPULAR_PROVIDER_IDS,
	providerGroup,
	providerLabel,
	providerStatusMark,
	rankProvider,
	sortProviders,
} from "../../app/providers/registry.mjs";

const anthropic = {
	id: "anthropic",
	name: "Anthropic",
	auth: { oauth: { name: "Anthropic (Claude Pro/Max)", isSubscription: true }, apiKey: { name: "Anthropic API key", login: () => {} } },
	status: { configured: false },
};
const openai = { id: "openai", name: "OpenAI", auth: { apiKey: { name: "OpenAI API key", login: () => {} } }, status: { configured: false } };
const openaiCodex = { id: "openai-codex", name: "OpenAI Codex", auth: { oauth: { loginLabel: "OpenAI (ChatGPT Plus/Pro)", isSubscription: true } }, status: { configured: false } };
const bedrock = { id: "amazon-bedrock", name: "Amazon Bedrock", auth: { apiKey: { name: "Bedrock", resolve: () => {} } }, status: { configured: false } };
const all = [anthropic, openai, openaiCodex, bedrock];

test("listAuthMethods returns oauth and api_key for a provider that has both", () => {
	const methods = listAuthMethods(anthropic, all);
	assert.deepEqual(methods.map((m) => m.type).sort(), ["api_key", "oauth"]);
	const oauth = methods.find((m) => m.type === "oauth");
	assert.equal(oauth.isSubscription, true);
	assert.equal(oauth.providerId, "anthropic");
});

test("listAuthMethods resolves the openai -> openai-codex oauth alias", () => {
	const methods = listAuthMethods(openai, all, AUTH_ALIASES);
	const oauth = methods.find((m) => m.type === "oauth");
	assert.equal(oauth.providerId, "openai-codex");
	assert.equal(oauth.name, "OpenAI (ChatGPT Plus/Pro)");
	assert.equal(oauth.alias, true);
	assert.equal(methods.find((m) => m.type === "api_key").providerId, "openai");
});

test("listAuthMethods ignores aliases whose target is absent", () => {
	const methods = listAuthMethods(openai, [openai], AUTH_ALIASES);
	assert.deepEqual(methods.map((m) => m.type), ["api_key"]);
});

test("listAuthMethods is empty for ambient-only providers", () => {
	assert.deepEqual(listAuthMethods(bedrock, all), []);
});

test("listAuthMethods de-duplicates identical provider/type pairs", () => {
	const methods = listAuthMethods(anthropic, all, { anthropic: [{ id: "anthropic", type: "oauth" }] });
	assert.equal(methods.filter((m) => m.type === "oauth").length, 1);
});

test("oauthLabel prefers the selector label", () => {
	assert.equal(oauthLabel({ loginLabel: "Label", name: "Name" }), "Label");
	assert.equal(oauthLabel({ name: "Name" }), "Name");
	assert.equal(oauthLabel(undefined, "fallback"), "fallback");
});

test("providerGroup buckets current, connected, popular, custom, other", () => {
	assert.equal(providerGroup({ id: "anthropic" }, { currentProviderId: "anthropic" }), "current");
	assert.equal(providerGroup({ id: "x", status: { configured: true } }), "connected");
	assert.equal(providerGroup({ id: "openai" }), "popular");
	assert.equal(providerGroup({ id: "mine", custom: true }), "custom");
	assert.equal(providerGroup({ id: "unknown-provider" }), "other");
});

test("sortProviders orders by group, popularity, then name", () => {
	const providers = [
		{ id: "other-b", name: "B", status: {} },
		{ id: "anthropic", name: "Anthropic" },
		{ id: "connected", name: "Connected", status: { configured: true } },
		{ id: "openai", name: "OpenAI" },
		{ id: "xai", name: "xAI" },
	];
	const sorted = sortProviders(providers, { currentProviderId: "anthropic" });
	assert.deepEqual(sorted.map((p) => p.id), ["anthropic", "connected", "xai", "openai", "other-b"]);
});

test("rankProvider puts current first and unknown last", () => {
	const current = rankProvider({ id: "anthropic" }, { currentProviderId: "anthropic" });
	const other = rankProvider({ id: "zzz" }, { currentProviderId: "anthropic" });
	assert.ok(current.group < other.group);
});

test("loadProviderCatalog decorates a runtime provider list", async () => {
	const fakeRuntime = {
		providers: async () => [
			{ ...anthropic },
			{ ...openai },
			{ ...openaiCodex },
		],
	};
	const catalog = await loadProviderCatalog(fakeRuntime, { currentProviderId: "openai" });
	assert.equal(catalog[0].id, "openai");
	assert.equal(catalog[0].group, "current");
	const openaiEntry = catalog.find((p) => p.id === "openai");
	assert.ok(openaiEntry.authMethods.some((m) => m.type === "oauth" && m.providerId === "openai-codex"));
	assert.ok(openaiEntry.authMethods.some((m) => m.type === "api_key"));
});

test("providerLabel and providerStatusMark render browser rows", () => {
	assert.equal(providerLabel({ id: "a", name: "A" }), "A · a");
	assert.equal(providerLabel({ id: "a", name: "a" }), "a");
	assert.equal(providerStatusMark({ configured: true }), "✓");
	assert.equal(providerStatusMark({}), "✗");
	assert.ok(POPULAR_PROVIDER_IDS.includes("anthropic"));
});
