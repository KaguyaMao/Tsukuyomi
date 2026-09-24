/**
 * Network environment bootstrap (proxy + curl-fetch) for Tsukuyomi.
 *
 * Tsukuyomi both talks to providers itself (OAuth login and token refresh run
 * in the frontend process) and spawns the PI RPC kernel. Both need the same
 * network configuration, and neither loads a `.env` file on its own:
 *
 *   - proxy variables must be present in the frontend process *and* the kernel;
 *   - the curl-fetch hook must be required in the frontend process and injected
 *     into the kernel through `NODE_OPTIONS`.
 *
 * Without this, signing in to an OpenAI/ChatGPT account from a datacenter IP
 * fails after the browser step with `unsupported_country_region_territory`
 * ("this region is not supported"), because Node's TLS fingerprint is rejected
 * where curl's is accepted.
 *
 * Configuration, all optional:
 *   TSUKUYOMI_ENV_FILE / KAGUYAPI_ENV_FILE  explicit dotenv file to read
 *   TSUKUYOMI_CURL_FETCH                   explicit curl-fetch hook path
 *   TSUKUYOMI_NO_PROXY_FILE=1              skip reading any dotenv file
 *   TSUKUYOMI_PROXY_PROBE=0                keep the proxy even when unreachable
 *   TSUKUYOMI_PROXY_PROBE_TIMEOUT_MS       TCP probe timeout (default 600)
 *   TSUKUYOMI_CURL_FETCH_MATCH / _DEBUG    see app/curl-fetch.cjs
 *
 * Explicit process environment always wins; dotenv values only fill gaps.
 *
 * A configured proxy that is not actually reachable must not black-hole every
 * request: a direct-only provider (DeepSeek and other China-accessible APIs)
 * would fail with a connection error even though it is fine without a proxy.
 * `applyNetworkEnv` therefore probes the proxy once and drops it from this
 * process and every child when the port refuses the connection.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveProxy } from "./http.mjs";

export { resolveProxy };

/** Variables a dotenv file may contribute. Anything else in the file is ignored. */
export const ENV_FILE_KEYS = Object.freeze([
	"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
	"http_proxy", "https_proxy", "all_proxy",
	"NO_PROXY", "no_proxy",
	"NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "CURL_CA_BUNDLE",
	"TSUKUYOMI_CURL_FETCH", "TSUKUYOMI_CURL_FETCH_MATCH", "TSUKUYOMI_CURL_FETCH_DEBUG", "TSUKUYOMI_CURL_PROXY",
	"TSUKUYOMI_PROXY_PROBE", "TSUKUYOMI_PROXY_PROBE_TIMEOUT_MS",
]);

/** Variables that make a request use a proxy; dropped together when it is dead. */
export const PROXY_ENV_KEYS = Object.freeze([
	"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
	"http_proxy", "https_proxy", "all_proxy",
	"TSUKUYOMI_CURL_PROXY",
]);

/** Parse a small dotenv file: `KEY=VALUE`, optional `export`, quotes, `#` comments. */
export function parseEnvFile(text) {
	const values = {};
	for (const rawLine of String(text).split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
		const equals = normalized.indexOf("=");
		if (equals <= 0) continue;
		const key = normalized.slice(0, equals).trim();
		let value = normalized.slice(equals + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		values[key] = value;
	}
	return values;
}

/** Candidate dotenv files, most specific first. */
export function envFileCandidates({ agentDir, home = homedir() } = {}) {
	return [
		process.env.TSUKUYOMI_ENV_FILE,
		process.env.KAGUYAPI_ENV_FILE,
		agentDir && join(agentDir, ".env"),
		join(home, ".tsukuyomi", "agent", ".env"),
		join(home, ".codex", ".env"),
	].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
}

/** First readable dotenv file, plus its parsed values. */
export function loadEnvFile({ agentDir, home, env = process.env } = {}) {
	if (env.TSUKUYOMI_NO_PROXY_FILE === "1") return { file: undefined, values: {} };
	for (const candidate of envFileCandidates({ agentDir, home })) {
		try {
			if (existsSync(candidate)) return { file: candidate, values: parseEnvFile(readFileSync(candidate, "utf8")) };
		} catch {
			// Ignore unreadable candidates and keep looking.
		}
	}
	return { file: undefined, values: {} };
}

/**
 * Candidate curl-fetch hooks, most specific first: an explicit override, the
 * vendored hook, then the legacy user-level hooks from the KaguyaPi era.
 */
export function curlFetchCandidates({ appRoot, home = homedir(), env = process.env } = {}) {
	return [
		env.TSUKUYOMI_CURL_FETCH,
		env.KAGUYAPI_CURL_FETCH,
		appRoot && join(appRoot, "app", "curl-fetch.cjs"),
		join(home, ".local", "share", "tsukuyomi", "pi-curl-fetch.cjs"),
		join(home, ".local", "share", "kaguyapi", "pi-curl-fetch.cjs"),
	].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
}

export function findCurlFetchHook({ appRoot, home, env = process.env } = {}) {
	return curlFetchCandidates({ appRoot, home, env }).find((candidate) => existsSync(candidate));
}

/** Require the CJS hook in this process so its `globalThis.fetch` patch applies. */
export function installFetchHook(hookPath, { require: requireImpl } = {}) {
	if (!hookPath) return false;
	if (globalThis.__tsukuyomiCurlFetchInstalled) return true;
	try {
		const load = requireImpl ?? createRequire(import.meta.url);
		load(hookPath);
		return globalThis.__tsukuyomiCurlFetchInstalled === true;
	} catch (error) {
		console.error(`Tsukuyomi: could not install the curl-fetch hook (${hookPath}): ${error.message}`);
		return false;
	}
}

/** Prepend `--require <hook>` to NODE_OPTIONS without duplicating it. */
export function withRequireOption(nodeOptions, hookPath) {
	if (!hookPath) return nodeOptions;
	const flag = `--require=${hookPath}`;
	if ((nodeOptions || "").includes(flag)) return nodeOptions;
	return nodeOptions ? `${flag} ${nodeOptions}` : flag;
}

/** Parse a proxy URL into the host/port a TCP probe should connect to. */
export function parseProxyTarget(proxy) {
	if (!proxy || typeof proxy !== "string") return undefined;
	const text = proxy.includes("://") ? proxy : `http://${proxy}`;
	let url;
	try {
		url = new URL(text);
	} catch {
		return undefined;
	}
	if (!url.hostname) return undefined;
	const scheme = url.protocol.replace(":", "").toLowerCase();
	const port = url.port ? Number(url.port) : scheme === "https" ? 443 : scheme === "socks" || scheme === "socks5" ? 1080 : 80;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
	return { host: url.hostname, port };
}

/** TCP-connect probe: true only when the proxy host accepts the connection. */
export function probeProxy(proxy, { timeoutMs = 600, connectImpl = connect } = {}) {
	const target = parseProxyTarget(proxy);
	if (!target) return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		const socket = connectImpl({ host: target.host, port: target.port });
		const finish = (value) => {
			if (settled) return;
			settled = true;
			socket.destroy?.();
			resolve(value);
		};
		socket.setTimeout?.(timeoutMs, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

/**
 * Load proxy configuration and install the curl-fetch hook.
 *
 * The configured proxy is probed before it is applied. When the port does not
 * answer (the local client is closed), every proxy variable is dropped so the
 * frontend and the PI kernel connect directly instead of failing against a dead
 * proxy. `TSUKUYOMI_PROXY_PROBE=0` keeps the old unconditional behaviour.
 *
 * @returns {{envFile: string|undefined, applied: string[], skipped: string[],
 *            hookPath: string|undefined, hookInstalled: boolean,
 *            nodeOptions: string|undefined, proxy: string|undefined, proxyUsable: boolean}}
 */
export async function applyNetworkEnv({ agentDir, appRoot, home = homedir(), env = process.env, probe = probeProxy } = {}) {
	const { file, values } = loadEnvFile({ agentDir, home, env });
	const applied = [];
	const skipped = [];
	// Resolve the proxy that would be effective after the dotenv gaps are filled,
	// so a shell-exported proxy and a proxy from the file are treated the same.
	const preview = { ...env };
	for (const [key, value] of Object.entries(values)) {
		if (ENV_FILE_KEYS.includes(key) && (preview[key] === undefined || preview[key] === "")) preview[key] = value;
	}
	const configuredProxy = resolveProxy(preview);
	const probeEnabled = (env.TSUKUYOMI_PROXY_PROBE ?? values.TSUKUYOMI_PROXY_PROBE ?? "1") !== "0";
	let proxyUsable = true;
	if (configuredProxy && probeEnabled) {
		const timeoutMs = Number(env.TSUKUYOMI_PROXY_PROBE_TIMEOUT_MS ?? values.TSUKUYOMI_PROXY_PROBE_TIMEOUT_MS) || 600;
		try {
			proxyUsable = await probe(configuredProxy, { timeoutMs });
		} catch {
			proxyUsable = false;
		}
	}
	if (!proxyUsable) {
		for (const key of PROXY_ENV_KEYS) {
			if (env[key] !== undefined) {
				delete env[key];
				skipped.push(key);
			}
			if (values[key] !== undefined) {
				delete values[key];
				skipped.push(key);
			}
		}
	}
	for (const [key, value] of Object.entries(values)) {
		if (!ENV_FILE_KEYS.includes(key)) continue;
		if (env[key] === undefined || env[key] === "") {
			env[key] = value;
			applied.push(key);
		}
	}

	const hookPath = findCurlFetchHook({ appRoot, home, env });
	const hookInstalled = installFetchHook(hookPath);
	const nodeOptions = withRequireOption(env.NODE_OPTIONS, hookPath);
	// Persist so every child process (RPC kernel, task-service subagents) inherits
	// the same hook without each spawn site having to remember it.
	if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
	return {
		envFile: file,
		applied,
		skipped,
		hookPath,
		hookInstalled,
		nodeOptions,
		proxy: configuredProxy,
		proxyUsable,
	};
}

/**
 * True when the process should be started again with proxy support enabled.
 *
 * `NODE_USE_ENV_PROXY` is the only way to make Node's built-in fetch honour
 * `HTTP(S)_PROXY`, but Node reads it at startup, so it has to be set before the
 * process begins. Rather than making users export it, Tsukuyomi restarts itself
 * once with it when a proxy is configured. Older runtimes ignore the variable
 * and keep working through the curl fallbacks.
 */
export function needsProxyRestart(env = process.env) {
	return Boolean(resolveProxy(env)) && env.NODE_USE_ENV_PROXY !== "1" && env.TSUKUYOMI_NET_PROXY_EXEC !== "1";
}

/**
 * Re-execute the current script with proxy support enabled and return its exit
 * status, or undefined when the restart could not be performed (the caller
 * should then continue without it).
 */
export function restartWithProxy({ env = process.env, spawn = spawnSync } = {}) {
	const script = process.argv[1];
	if (!script) return undefined;
	const result = spawn(process.execPath, [script, ...process.argv.slice(2)], {
		stdio: "inherit",
		env: { ...env, NODE_USE_ENV_PROXY: "1", TSUKUYOMI_NET_PROXY_EXEC: "1" },
	});
	if (result.error) return undefined;
	return result.status === null ? 1 : result.status;
}

/** Child-process environment additions (proxy + NODE_OPTIONS) for the PI kernel. */
export function networkEnvForChild({ nodeOptions, env = process.env } = {}) {
	const additions = {};
	for (const key of ENV_FILE_KEYS) {
		if (key.startsWith("TSUKUYOMI_")) continue;
		if (env[key] !== undefined) additions[key] = env[key];
	}
	if (nodeOptions) additions.NODE_OPTIONS = nodeOptions;
	return additions;
}
