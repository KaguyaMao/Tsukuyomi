/**
 * Proxy-aware fetch for the frontend's own requests.
 *
 * Native `fetch` (undici) ignores `HTTP(S)_PROXY` unless Node is started with
 * `--use-env-proxy`, which is only available on newer runtimes and cannot be
 * enabled from inside a running process. So a frontend request to a host that is
 * only reachable through the proxy fails with `fetch failed`
 * (`UND_ERR_CONNECT_TIMEOUT`) even though the proxy works.
 *
 * `proxyAwareFetch` keeps native fetch as the fast path and, when it fails with
 * a network error and a proxy is configured, retries the same request through
 * `curl` (app/curl-fetch.cjs). This never affects streaming: it is only used by
 * non-streaming frontend calls (quota lookup, custom-provider model discovery).
 *
 * Configuration: the same proxy variables as the curl-fetch hook
 * (`TSUKUYOMI_CURL_PROXY`, then `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy`).
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Proxy URL from the environment, or undefined when none is configured. */
export function resolveProxy(env = process.env) {
	return env.TSUKUYOMI_CURL_PROXY
		|| env.HTTPS_PROXY || env.https_proxy
		|| env.HTTP_PROXY || env.http_proxy
		|| env.ALL_PROXY || env.all_proxy
		|| undefined;
}

/** True for connection/DNS/TLS failures, false for HTTP errors and aborts. */
export function isNetworkError(error) {
	if (!error) return false;
	if (error.name === "AbortError" || error.name === "TimeoutError") return false;
	if (error.name === "TypeError" && /fetch failed|network|terminated|other side closed/i.test(String(error.message))) return true;
	const code = String(error.cause?.code || error.code || "");
	return /UND_ERR|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EPROTO|CERT|EHOSTUNREACH|ENETUNREACH/.test(code);
}

/** The curl helper installed by app/net-env.mjs, or loaded on demand. */
export function loadCurlFetch() {
	if (typeof globalThis.__tsukuyomiCurlFetch === "function") return globalThis.__tsukuyomiCurlFetch;
	try {
		const require = createRequire(import.meta.url);
		const mod = require(fileURLToPath(new URL("./curl-fetch.cjs", import.meta.url)));
		return typeof mod?.curlFetch === "function" ? mod.curlFetch : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Build a fetch function that falls back to curl through the proxy.
 *
 * @param {{env?: object, fetchImpl?: Function, curlFetch?: Function, onFallback?: Function}} options
 */
export function createProxyAwareFetch({ env = process.env, fetchImpl = globalThis.fetch, curlFetch = loadCurlFetch(), onFallback } = {}) {
	return async function proxyAwareFetch(input, init = {}) {
		try {
			return await fetchImpl(input, init);
		} catch (error) {
			if (init?.signal?.aborted || !isNetworkError(error)) throw error;
			const proxy = resolveProxy(env);
			if (!proxy || typeof curlFetch !== "function") throw error;
			onFallback?.({ input, proxy, error });
			return curlFetch(input, init, { proxy });
		}
	};
}

/** Convenience: a ready-to-use proxy-aware fetch bound to the current env. */
export function proxyAwareFetch(input, init) {
	return createProxyAwareFetch()(input, init);
}
