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
 *   TSUKUYOMI_CURL_FETCH_MATCH / _DEBUG    see app/curl-fetch.cjs
 *
 * Explicit process environment always wins; dotenv values only fill gaps.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

/** Variables a dotenv file may contribute. Anything else in the file is ignored. */
export const ENV_FILE_KEYS = Object.freeze([
	"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
	"http_proxy", "https_proxy", "all_proxy",
	"NO_PROXY", "no_proxy",
	"NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "CURL_CA_BUNDLE",
	"TSUKUYOMI_CURL_FETCH", "TSUKUYOMI_CURL_FETCH_MATCH", "TSUKUYOMI_CURL_FETCH_DEBUG", "TSUKUYOMI_CURL_PROXY",
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
		join(home, ".kaguyapi", "agent", ".env"),
		join(home, ".pi", ".env"),
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

/**
 * Load proxy configuration and install the curl-fetch hook.
 *
 * @returns {{envFile: string|undefined, applied: string[], hookPath: string|undefined,
 *            hookInstalled: boolean, nodeOptions: string|undefined, proxy: string|undefined}}
 */
export function applyNetworkEnv({ agentDir, appRoot, home = homedir(), env = process.env } = {}) {
	const { file, values } = loadEnvFile({ agentDir, home, env });
	const applied = [];
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
		hookPath,
		hookInstalled,
		nodeOptions,
		proxy: env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.TSUKUYOMI_CURL_PROXY,
	};
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
