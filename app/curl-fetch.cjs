"use strict";
/**
 * curl-fetch shim for OpenAI OAuth.
 *
 * OpenAI rejects the Node/OpenSSL TLS fingerprint from some datacenter IPs with
 * HTTP 403 `unsupported_country_region_territory`, while the curl TLS
 * fingerprint is accepted. This module replaces `globalThis.fetch` for matching
 * hosts and routes those requests through the `curl` binary instead.
 *
 * Installed by Tsukuyomi at startup: in the frontend process (where OAuth login
 * runs) via `require()`, and in the PI RPC kernel via `NODE_OPTIONS=--require`.
 * Without it, signing in to an OpenAI/ChatGPT account behind such a link fails
 * with a region error even though the browser step succeeds.
 *
 * Configuration:
 *   TSUKUYOMI_CURL_FETCH_MATCH  JS regex source for the intercepted URLs
 *                               (default: ^https://auth\.openai\.com($|/))
 *   TSUKUYOMI_CURL_FETCH_DEBUG  set to 1 to log intercepted/passed-through URLs
 *   HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy / TSUKUYOMI_CURL_PROXY
 *                               proxy passed to curl with -x (optional)
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const matchSource = process.env.TSUKUYOMI_CURL_FETCH_MATCH || process.env.KAGUYAPI_CURL_FETCH_MATCH || "^https://auth\\.openai\\.com($|/)";
let MATCH;
try {
	MATCH = new RegExp(matchSource);
} catch {
	MATCH = /^https:\/\/auth\.openai\.com($|\/)/;
}
const DEBUG = process.env.TSUKUYOMI_CURL_FETCH_DEBUG === "1" || process.env.KAGUYAPI_DEBUG_FETCH === "1";
const log = (...args) => {
	if (DEBUG) console.error("[curl-fetch]", ...args);
};

const origFetch = globalThis.fetch;
if (typeof origFetch === "function" && !globalThis.__tsukuyomiCurlFetchInstalled) {
	globalThis.__tsukuyomiCurlFetchInstalled = true;

	globalThis.fetch = async function (input, init = {}) {
		let url;
		if (typeof input === "string") url = input;
		else if (input instanceof URL) url = input.href;
		else url = input && typeof input.url === "string" ? input.url : undefined;

		if (!url || !MATCH.test(url)) {
			log("passthrough:", url);
			return origFetch.call(this, input, init);
		}
		log("routing via curl:", url);

		if (init.signal?.aborted) {
			const error = new Error("Login cancelled");
			error.name = "AbortError";
			throw error;
		}

		const method = (init.method || "GET").toUpperCase();
		const headers = init.headers || {};
		const headArgs = [];
		const proxy = process.env.TSUKUYOMI_CURL_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
		if (typeof Headers !== "undefined" && headers instanceof Headers && typeof headers.forEach === "function") {
			headers.forEach((value, key) => headArgs.push("-H", `${key}: ${value}`));
		} else if (Array.isArray(headers)) {
			for (const [key, value] of headers) headArgs.push("-H", `${key}: ${value}`);
		} else if (headers && typeof headers === "object") {
			for (const [key, value] of Object.entries(headers)) if (value != null) headArgs.push("-H", `${key}: ${value}`);
		}

		const body =
			init.body != null
				? typeof init.body === "string"
					? init.body
					: typeof init.body === "object" && typeof init.body.toString === "function" && init.body.constructor.name !== "Object"
						? init.body.toString()
						: String(init.body)
				: undefined;

		const tmp = path.join(os.tmpdir(), `tsukuyomi-curl-${process.pid}-${crypto.randomBytes(6).toString("hex")}.body`);
		const args = ["-sS", "--http1.1", "--compressed", "--max-time", "90", "-o", tmp, "-w", "%{http_code}", "-X", method, ...headArgs];
		if (proxy) args.push("-x", proxy);
		if (body !== undefined) args.push("--data-binary", "@-");
		args.push(url);

		const result = spawnSync("curl", args, {
			input: body !== undefined ? body : undefined,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		if (result.error) {
			try { fs.unlinkSync(tmp); } catch {}
			throw new Error(`curl-fetch: curl failed for ${url}: ${result.error.message}`);
		}
		const status = Number((result.stdout || "").trim() || 0);
		let text = "";
		try {
			text = fs.readFileSync(tmp, "utf8");
			fs.unlinkSync(tmp);
		} catch {}
		return new Response(text, { status: status || 500, headers: { "content-type": "application/json" } });
	};
}
