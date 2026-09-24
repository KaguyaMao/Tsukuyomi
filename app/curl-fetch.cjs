"use strict";
/**
 * curl-fetch shim.
 *
 * Some hosts are unreachable directly but fine through the configured HTTP
 * proxy, and OpenAI additionally rejects the Node/OpenSSL TLS fingerprint from
 * datacenter IPs with HTTP 403 `unsupported_country_region_territory`. Routing
 * those specific requests through the `curl` binary fixes both.
 *
 * Two use sites:
 *   - installed at startup by app/net-env.mjs: in the frontend process (where
 *     OAuth login runs) via `require()`, and in the PI RPC kernel through
 *     `NODE_OPTIONS=--require` so token refresh works there too;
 *   - exposed as `module.exports.curlFetch`, which app/http.mjs uses to retry a
 *     failed native fetch through the proxy.
 *
 * IMPORTANT: the default match list is deliberately limited to non-streaming
 * endpoints. It must never match `chatgpt.com/backend-api/codex/*` (or any other
 * streaming model path), because curl returns a whole body at once and would
 * break incremental streaming.
 *
 * Configuration:
 *   TSUKUYOMI_CURL_FETCH_MATCH  replace the default match list with this regex
 *   TSUKUYOMI_CURL_FETCH_EXTRA  add one more regex to the default list
 *   TSUKUYOMI_CURL_FETCH_DEBUG  set to 1 to log intercepted/passed-through URLs
 *   TSUKUYOMI_CURL_PROXY        proxy for curl -x
 *                               (falls back to HTTPS_PROXY/https_proxy/HTTP_PROXY/http_proxy)
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

/**
 * Non-streaming endpoints that need curl (OAuth device-code/token endpoints and
 * the account-quota endpoint). These hosts are often unreachable directly but
 * work through the proxy, and OpenAI additionally rejects Node's TLS
 * fingerprint. Streaming endpoints (api.x.ai, .../backend-api/codex/*, ...) must
 * never be listed here.
 */
const DEFAULT_MATCHES = [
	"^https://auth\\.openai\\.com($|/)",
	"^https://auth\\.x\\.ai($|/)",
	"^https://chatgpt\\.com/backend-api/wham/",
	// Grok Build `/usage` talks to the CLI chat proxy (billing + /user).
	// Native fetch through a local HTTP proxy often hangs here; curl does not.
	"^https://cli-chat-proxy\\.grok\\.com($|/)",
];

function buildMatchers(env) {
	const sources = env.TSUKUYOMI_CURL_FETCH_MATCH || env.KAGUYAPI_CURL_FETCH_MATCH
		? [env.TSUKUYOMI_CURL_FETCH_MATCH || env.KAGUYAPI_CURL_FETCH_MATCH]
		: [...DEFAULT_MATCHES];
	const extra = env.TSUKUYOMI_CURL_FETCH_EXTRA || env.KAGUYAPI_CURL_FETCH_EXTRA;
	if (extra) sources.push(extra);
	const matchers = [];
	for (const source of sources) {
		try {
			matchers.push(new RegExp(source));
		} catch {
			// Ignore an invalid user pattern rather than disabling the shim.
		}
	}
	return matchers.length > 0 ? matchers : [new RegExp(DEFAULT_MATCHES[0])];
}

const MATCHERS = buildMatchers(process.env);
const DEBUG = process.env.TSUKUYOMI_CURL_FETCH_DEBUG === "1" || process.env.KAGUYAPI_DEBUG_FETCH === "1";
const log = (...args) => {
	if (DEBUG) console.error("[curl-fetch]", ...args);
};

function urlOf(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	if (input && typeof input.url === "string") return input.url;
	return undefined;
}

function shouldIntercept(url) {
	return typeof url === "string" && MATCHERS.some((matcher) => matcher.test(url));
}

function resolveProxy(explicit) {
	return explicit || process.env.TSUKUYOMI_CURL_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
}

function headerArgs(headers) {
	const args = [];
	if (typeof Headers !== "undefined" && headers instanceof Headers && typeof headers.forEach === "function") {
		headers.forEach((value, key) => args.push("-H", `${key}: ${value}`));
	} else if (Array.isArray(headers)) {
		for (const [key, value] of headers) args.push("-H", `${key}: ${value}`);
	} else if (headers && typeof headers === "object") {
		for (const [key, value] of Object.entries(headers)) if (value != null) args.push("-H", `${key}: ${value}`);
	}
	return args;
}

function bodyOf(body) {
	if (body == null) return undefined;
	if (typeof body === "string") return body;
	if (typeof body === "object" && typeof body.toString === "function" && body.constructor.name !== "Object") return body.toString();
	return String(body);
}

/**
 * Perform a request with the `curl` binary and return a `Response`.
 *
 * This MUST stay asynchronous. `curl` can take seconds to tens of seconds (the
 * proxy can hang until `--max-time`), and the quota/OAuth endpoints that reach
 * this path are invoked from the TUI's main event loop. A synchronous
 * `spawnSync` here freezes the entire interface — including keyboard input —
 * while `/status`, sign-in, or a token refresh is in flight.
 */
function abortError() {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

function curlFetch(input, init = {}, { proxy: explicitProxy } = {}) {
	const url = urlOf(input);
	if (!url) return Promise.reject(new TypeError("curl-fetch: a URL is required"));
	if (init.signal?.aborted) return Promise.reject(abortError());
	const method = (init.method || "GET").toUpperCase();
	const proxy = resolveProxy(explicitProxy);
	const body = bodyOf(init.body);
	const tmp = path.join(os.tmpdir(), `tsukuyomi-curl-${process.pid}-${crypto.randomBytes(6).toString("hex")}.body`);
	const args = ["-sS", "--http1.1", "--compressed", "--max-time", "90", "-o", tmp, "-w", "%{http_code}", "-X", method, ...headerArgs(init.headers)];
	if (proxy) args.push("-x", proxy);
	if (body !== undefined) args.push("--data-binary", "@-");
	args.push(url);

	return new Promise((resolve, reject) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		const cleanup = () => { try { fs.unlinkSync(tmp); } catch {} };
		const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			init.signal?.removeEventListener?.("abort", onAbort);
			cleanup();
			fn(value);
		};
		const onAbort = () => {
			try { child.kill("SIGTERM"); } catch {}
			finish(reject, abortError());
		};
		if (init.signal) init.signal.addEventListener?.("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
		child.on("error", (error) => {
			const wrapped = new TypeError(`curl-fetch: curl failed for ${url}: ${error.message}`);
			wrapped.cause = error;
			finish(reject, wrapped);
		});
		child.on("close", (code) => {
			if (settled) return;
			const status = Number((stdout || "").trim() || 0);
			let text = "";
			try { text = fs.readFileSync(tmp, "utf8"); } catch {}
			// curl exits non-zero (or reports 000) when it cannot connect at all.
			// Surface that as a network error instead of a bogus HTTP 500 so retry
			// logic works.
			if (!status && code !== 0) {
				const error = new TypeError(`curl-fetch: could not reach ${url}${proxy ? ` via ${proxy}` : ""}`);
				error.cause = { code: "ECONNREFUSED", stderr };
				finish(reject, error);
				return;
			}
			finish(resolve, new Response(text, {
				status: status || 500,
				headers: { "content-type": "application/json" },
			}));
		});
		if (body !== undefined) {
			child.stdin.on("error", () => {});
			child.stdin.end(body);
		} else {
			child.stdin.end();
		}
	});
}

const origFetch = globalThis.fetch;
if (typeof origFetch === "function" && !globalThis.__tsukuyomiCurlFetchInstalled) {
	globalThis.__tsukuyomiCurlFetchInstalled = true;
	globalThis.fetch = async function (input, init = {}) {
		const url = urlOf(input);
		if (!shouldIntercept(url)) {
			log("passthrough:", url);
			return origFetch.call(this, input, init);
		}
		log("routing via curl:", url);
		return curlFetch(input, init);
	};
}

// Always expose the raw helper, even when the global patch was already applied.
globalThis.__tsukuyomiCurlFetch = curlFetch;

module.exports = { curlFetch, shouldIntercept, match: MATCHERS };
