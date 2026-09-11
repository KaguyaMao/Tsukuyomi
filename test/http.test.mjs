import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createProxyAwareFetch, isNetworkError, loadCurlFetch, resolveProxy } from "../app/http.mjs";

const require = createRequire(import.meta.url);

function networkError(message = "fetch failed") {
	const error = new TypeError(message);
	error.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
	return error;
}

test("resolveProxy prefers TSUKUYOMI_CURL_PROXY then the standard variables", () => {
	assert.equal(resolveProxy({ TSUKUYOMI_CURL_PROXY: "http://a", HTTPS_PROXY: "http://b" }), "http://a");
	assert.equal(resolveProxy({ HTTPS_PROXY: "http://b", HTTP_PROXY: "http://c" }), "http://b");
	assert.equal(resolveProxy({ HTTP_PROXY: "http://c" }), "http://c");
	assert.equal(resolveProxy({}), undefined);
});

test("isNetworkError separates connection failures from aborts and HTTP errors", () => {
	assert.equal(isNetworkError(networkError()), true);
	assert.equal(isNetworkError(networkError("terminated")), true);
	assert.equal(isNetworkError({ name: "AbortError", message: "aborted" }), false);
	assert.equal(isNetworkError({ name: "TimeoutError" }), false);
	assert.equal(isNetworkError(new Error("HTTP 500")), false);
	assert.equal(isNetworkError(undefined), false);
	assert.equal(isNetworkError({ name: "Error", cause: { code: "ENOTFOUND" } }), true);
});

test("proxy-aware fetch uses the native path when it succeeds", async () => {
	const response = new Response("{}", { status: 200 });
	let fallback = 0;
	const fetcher = createProxyAwareFetch({
		env: { HTTPS_PROXY: "http://proxy" },
		fetchImpl: async () => response,
		curlFetch: async () => { throw new Error("curl should not run"); },
		onFallback: () => { fallback += 1; },
	});
	assert.equal(await fetcher("https://example.com"), response);
	assert.equal(fallback, 0);
});

test("proxy-aware fetch retries through curl when the connection fails", async () => {
	const viaCurl = new Response('{"data":{}}', { status: 401 });
	const seen = [];
	const fetcher = createProxyAwareFetch({
		env: { HTTPS_PROXY: "http://proxy" },
		fetchImpl: async () => { throw networkError(); },
		curlFetch: async (input, init, options) => {
			seen.push({ input, init, options });
			return viaCurl;
		},
		onFallback: (info) => seen.push({ fallback: info.proxy }),
	});
	const result = await fetcher("https://chatgpt.com/backend-api/wham/usage", { headers: { Accept: "application/json" } });
	assert.equal(result.status, 401);
	assert.equal(seen[0].fallback, "http://proxy");
	assert.equal(seen[1].options.proxy, "http://proxy");
});

test("proxy-aware fetch rethrows when no proxy is configured", async () => {
	const fetcher = createProxyAwareFetch({ env: {}, fetchImpl: async () => { throw networkError(); } });
	await assert.rejects(() => fetcher("https://example.com"), /fetch failed/);
});

test("proxy-aware fetch never retries an abort", async () => {
	let curlCalls = 0;
	const fetcher = createProxyAwareFetch({
		env: { HTTPS_PROXY: "http://proxy" },
		fetchImpl: async () => {
			const error = new Error("aborted");
			error.name = "AbortError";
			throw error;
		},
		curlFetch: async () => { curlCalls += 1; return new Response("{}"); },
	});
	await assert.rejects(() => fetcher("https://example.com"), (error) => error.name === "AbortError");
	assert.equal(curlCalls, 0);
});

test("loadCurlFetch resolves the vendored helper", () => {
	assert.equal(typeof loadCurlFetch(), "function");
});

test("curl-fetch matches only non-streaming endpoints", () => {
	const hook = require("../app/curl-fetch.cjs");
	assert.equal(typeof hook.curlFetch, "function");
	// OAuth and the account-quota endpoint need curl.
	assert.equal(hook.shouldIntercept("https://auth.openai.com/oauth/token"), true);
	assert.equal(hook.shouldIntercept("https://chatgpt.com/backend-api/wham/usage"), true);
	// Streaming model endpoints must never be routed through curl.
	assert.equal(hook.shouldIntercept("https://chatgpt.com/backend-api/codex/responses"), false);
	assert.equal(hook.shouldIntercept("https://api.anthropic.com/v1/messages"), false);
	assert.equal(hook.shouldIntercept(undefined), false);
});
