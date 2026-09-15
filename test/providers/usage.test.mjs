import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderUsageClient, quotaAdapters, parseXaiBilling, parseXaiSubscriptions } from "../../app/providers/usage.mjs";
import { writeStoredCredential } from "../../app/providers/store.mjs";

function agentDirWith(providerId, credential) {
	const dir = mkdtempSync(join(tmpdir(), "tsukuyomi-usage-"));
	writeStoredCredential(dir, providerId, credential);
	return dir;
}

function client(dir, fetchImpl, overrides = {}) {
	return new ProviderUsageClient({ agentDir: dir, env: {}, fetchImpl, now: () => 1_700_000_000_000, ...overrides });
}

function jsonResponse(payload, status = 200) {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("anthropic builds the documented usage request and parses windows", async () => {
	const dir = agentDirWith("anthropic", { type: "oauth", access: "sk-ant-oat01", refresh: "r", expires: 9e12 });
	const calls = [];
	const usage = await client(dir, async (url, init) => {
		calls.push({ url, init });
		return jsonResponse({
			five_hour: { utilization: 40, resets_at: "2026-09-12T10:00:00Z" },
			seven_day: { utilization: 60, resets_at: "2026-09-18T10:00:00Z" },
			seven_day_sonnet: { utilization: 25 },
			extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25 },
		});
	}).get({ provider: "anthropic", id: "claude-sonnet-4", baseUrl: "https://api.anthropic.com" });

	assert.equal(calls[0].url, "https://api.anthropic.com/api/oauth/usage");
	assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ant-oat01");
	assert.equal(calls[0].init.headers["anthropic-beta"], "oauth-2025-04-20");
	// Without this User-Agent the endpoint returns persistent 429s.
	assert.equal(calls[0].init.headers["User-Agent"], "claude-code/");

	assert.equal(usage.kind, "available");
	assert.equal(usage.windows.length, 3);
	const [fiveHour, sevenDay, sonnet] = usage.windows;
	assert.equal(fiveHour.windowSeconds, 5 * 3600);
	assert.equal(fiveHour.usedPercent, 40);
	assert.equal(fiveHour.remainingPercent, 60);
	assert.equal(sevenDay.windowSeconds, 7 * 24 * 3600);
	assert.equal(sonnet.bucketName, "sonnet");
	assert.equal(usage.monthly.used, "1250");
	assert.equal(usage.monthly.limit, "5000");
	assert.equal(usage.pageUrl, "https://claude.ai/settings/usage");
});

test("anthropic accepts utilization as a fraction or as a percentage", async () => {
	const dir = agentDirWith("anthropic", { type: "oauth", access: "a", refresh: "r", expires: 9e12 });
	const fetchImpl = async () => jsonResponse({ five_hour: { utilization: 0.34 }, seven_day: { utilization: 0.5 } });
	const fraction = await client(dir, fetchImpl).get({ provider: "anthropic", baseUrl: "https://api.anthropic.com" });
	assert.equal(fraction.windows[0].usedPercent, 34);
	assert.equal(fraction.windows[1].usedPercent, 50);

	const percentPayload = async () => jsonResponse({ five_hour: { utilization: 34 }, seven_day: { utilization: 50 } });
	const asPercent = await client(dir, percentPayload).get({ provider: "anthropic", baseUrl: "https://api.anthropic.com" });
	assert.equal(asPercent.windows[0].usedPercent, 34);
	assert.equal(asPercent.windows[1].usedPercent, 50);
});

test("anthropic refuses an API-key account instead of guessing", async () => {
	const dir = agentDirWith("anthropic", { type: "api_key", key: "sk-ant-api" });
	const result = await client(dir, async () => { throw new Error("must not fetch"); })
		.get({ provider: "anthropic", baseUrl: "https://api.anthropic.com" });
	assert.equal(result.kind, "unsupported");
	assert.equal(result.code, "api-key");
});

test("anthropic never sends the OAuth token to a different host", async () => {
	const dir = agentDirWith("anthropic", { type: "oauth", access: "secret", refresh: "r", expires: 9e12 });
	const result = await client(dir, async () => { throw new Error("must not fetch"); })
		.get({ provider: "anthropic", baseUrl: "https://my-proxy.example.com/v1" });
	assert.equal(result.kind, "unsupported");
	assert.equal(result.code, "endpoint");
});

test("xAI API-key accounts report no quota endpoint", async () => {
	// API-key accounts have no consumer subscription quota endpoint.
	const keyDir = agentDirWith("xai", { type: "api_key", key: "xai-key" });
	const apiKey = await client(keyDir, async () => { throw new Error("must not fetch"); })
		.get({ provider: "xai", baseUrl: "https://api.x.ai/v1" });
	assert.equal(apiKey.code, "no-endpoint");
	assert.equal(apiKey.pageUrl, "https://console.x.ai/usage");

});

test("parseXaiBilling normalizes Grok Build's weekly allowance", () => {
	const billing = parseXaiBilling({ config: {
		currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-09T11:40:58.608353Z", end: "2026-09-16T11:40:58.608353Z" },
		creditUsagePercent: 99,
		productUsage: [{ product: "GrokBuild", usagePercent: 99 }],
	} });
	assert.equal(billing.usedPercent, 99);
	assert.equal(billing.remainingPercent, 1);
	assert.equal(billing.windowSeconds, 7 * 24 * 3600);
	assert.equal(billing.products[0].product, "GrokBuild");
});

test("openrouter and deepseek parse their payloads", async () => {
	const routerDir = agentDirWith("openrouter", { type: "api_key", key: "sk-or" });
	const router = await client(routerDir, async () => jsonResponse({ data: { usage: 2.5, limit: 10, limit_remaining: 7.5 } }))
		.get({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
	assert.equal(router.kind, "available");
	assert.equal(router.monthly.remainingPercent, 75);
	assert.equal(router.credits.balance, "7.5");

	const deepseekDir = agentDirWith("deepseek", { type: "api_key", key: "sk-ds" });
	const deepseek = await client(deepseekDir, async () => jsonResponse({
		is_available: true,
		balance_infos: [{ total_balance: "9.50", currency: "USD" }],
	})).get({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
	assert.equal(deepseek.credits.balance, "9.50 USD");
});

test("unknown providers and missing credentials are reported clearly", async () => {
	const dir = agentDirWith("openrouter", { type: "api_key", key: "k" });
	const unknown = await client(dir, async () => { throw new Error("must not fetch"); }).get({ provider: "nope" });
	assert.equal(unknown.code, "endpoint");

	const missing = await client(dir, async () => { throw new Error("must not fetch"); }).get({ provider: "anthropic" });
	assert.equal(missing.code, "no-auth");

	const noModel = await client(dir, async () => { throw new Error("must not fetch"); }).get(undefined);
	assert.equal(noModel.code, "model");
});

test("HTTP, rate-limit, malformed, network, and timeout failures map to codes", async () => {
	const dir = agentDirWith("openrouter", { type: "api_key", key: "k" });
	const model = { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" };
	const cases = [
		[{ status: 401 }, "expired-auth"],
		[{ status: 403 }, "expired-auth"],
		[{ status: 429 }, "rate-limited"],
		[{ status: 500 }, "http"],
		[{ payload: { unexpected: true } }, "malformed"],
	];
	for (const [spec, expected] of cases) {
		const result = await client(dir, async () =>
			spec.status ? jsonResponse({}, spec.status) : jsonResponse(spec.payload)).get(model, { force: true });
		assert.equal(result.code, expected, `status ${spec.status ?? "payload"}`);
	}

	const networkError = new TypeError("fetch failed");
	networkError.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
	const network = await client(dir, async () => { throw networkError; }).get(model, { force: true });
	assert.equal(network.code, "network");

	const aborted = new Error("aborted");
	aborted.name = "AbortError";
	const timeout = await client(dir, async () => { throw aborted; }).get(model, { force: true });
	assert.equal(timeout.code, "timeout");
});

test("results are cached until force is requested", async () => {
	const dir = agentDirWith("openrouter", { type: "api_key", key: "k" });
	let calls = 0;
	const usage = client(dir, async () => {
		calls += 1;
		return jsonResponse({ data: { usage: 1, limit: 10 } });
	});
	const model = { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" };
	await usage.get(model);
	await usage.get(model);
	assert.equal(calls, 1);
	await usage.get(model, { force: true });
	assert.equal(calls, 2);
});

test("adapters declare their supported credential types", () => {
	assert.deepEqual(quotaAdapters.anthropic.credentialTypes, ["oauth"]);
	assert.deepEqual(quotaAdapters.openrouter.credentialTypes, ["api_key"]);
	assert.equal(ProviderUsageClient.supports("anthropic", "oauth"), true);
	assert.equal(ProviderUsageClient.supports("anthropic", "api_key"), false);
	assert.equal(ProviderUsageClient.supports("xai", "oauth"), true);
	assert.equal(ProviderUsageClient.supports("xai", "api_key"), false);
});

test("parseXaiSubscriptions prefers an active subscription", () => {
	const payload = {
		subscriptions: [
			{ tier: "SUBSCRIPTION_TIER_GROK_PRO", status: "SUBSCRIPTION_STATUS_INACTIVE", billingPeriodEnd: "2026-07-22T11:40:57Z" },
			{ tier: "SUBSCRIPTION_TIER_GROK_PRO", status: "SUBSCRIPTION_STATUS_ACTIVE", billingPeriodEnd: "2026-10-22T11:40:57Z" },
		],
	};
	const plan = parseXaiSubscriptions(payload);
	assert.equal(plan.tier, "grok pro");
	assert.equal(plan.status, "active");
	assert.equal(plan.periodEnd, Date.parse("2026-10-22T11:40:57Z"));
});

test("parseXaiSubscriptions falls back to the first entry and handles empty payloads", () => {
	assert.equal(parseXaiSubscriptions({ subscriptions: [{ tier: "SUBSCRIPTION_TIER_GROK_PRO", status: "SUBSCRIPTION_STATUS_INACTIVE" }] }).status, "inactive");
	assert.equal(parseXaiSubscriptions({}), undefined);
	assert.equal(parseXaiSubscriptions(null), undefined);
	assert.equal(parseXaiSubscriptions({ subscriptions: [] }), undefined);
});

test("xAI OAuth reads Grok Build billing and subscription endpoints", async () => {
	const dir = agentDirWith("xai", { type: "oauth", access: "xai-oauth-token", refresh: "r", expires: 9e12 });
	const calls = [];
	const usage = await client(dir, async (url, init) => {
		calls.push({ url, init });
		if (url.endsWith("/billing?format=credits")) return jsonResponse({ config: {
			currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-09T00:00:00Z", end: "2026-09-16T00:00:00Z" },
			creditUsagePercent: 42, productUsage: [{ product: "GrokBuild", usagePercent: 42 }],
		} });
		return jsonResponse({ subscriptionTier: "GrokPro", hasGrokCodeAccess: true });
	}).get({ provider: "xai", id: "grok-4", baseUrl: "https://api.x.ai/v1" });

	assert.deepEqual(calls.map((call) => call.url).sort(), [
		"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
		"https://cli-chat-proxy.grok.com/v1/user?include=subscription",
	].sort());
	assert.equal(calls[0].init.headers.Authorization, "Bearer xai-oauth-token");
	assert.equal(usage.kind, "available");
	assert.equal(usage.plan.tier, "GrokPro");
	assert.equal(usage.plan.status, "active");
	assert.equal(usage.windows[0].usedPercent, 42);
	assert.equal(usage.pageUrl, "https://grok.com/?_s=usage");
});

test("xAI OAuth treats a 403 as expired login", async () => {
	const dir = agentDirWith("xai", { type: "oauth", access: "xai-oauth-token", refresh: "r", expires: 9e12 });
	const result = await client(dir, async () => new Response("{}", { status: 403 })).get({ provider: "xai", baseUrl: "https://api.x.ai/v1" });
	assert.equal(result.kind, "unsupported");
	assert.equal(result.code, "expired-auth");
	assert.equal(result.pageUrl, "https://grok.com/?_s=usage");
});

test("xAI API-key accounts have no quota endpoint", async () => {
	const dir = agentDirWith("xai", { type: "api_key", key: "xai-api-key" });
	const result = await client(dir, async () => { throw new Error("must not fetch"); })
		.get({ provider: "xai", baseUrl: "https://api.x.ai/v1" });
	assert.equal(result.kind, "unsupported");
	assert.equal(result.code, "no-endpoint");
	assert.equal(result.pageUrl, "https://console.x.ai/usage");
});
