/**
 * opencode-style custom-provider config (`<agentDir>/providers.json`).
 *
 * This file is the user-facing source of truth for custom providers and is
 * shaped after opencode's `provider` map so the mental model carries over:
 *
 *   { "provider": {
 *       "myprovider": {
 *         "npm": "@ai-sdk/openai-compatible",
 *         "name": "My Provider",
 *         "options": { "baseURL": "https://api.example.com/v1",
 *                      "apiKey": "{env:MY_KEY}",
 *                      "headers": { "X-Foo": "bar" } },
 *         "models": { "my-model": { "name": "My Model",
 *                                   "limit": { "context": 200000, "output": 65536 } } },
 *         "blacklist": [], "whitelist": [] } } }
 *
 * `config/sync.mjs` translates this into PI's `models.json`. Keys and headers
 * support opencode's `{env:VAR}` and `{file:path}` interpolation; the file may
 * use comments and trailing commas (JSONC).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authError, AuthErrorCode } from "../errors.mjs";
import { parseJsonc } from "./jsonc.mjs";

export const PROVIDERS_FILE = "providers.json";
const FILE_MODE = 0o600;
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** opencode AI-SDK package -> PI api implementation id. */
export const NPM_TO_API = Object.freeze({
	"@ai-sdk/openai-compatible": "openai-completions",
	"@ai-sdk/openai": "openai-responses",
	"@ai-sdk/anthropic": "anthropic-messages",
	"@ai-sdk/google": "google-generative-ai",
	"@ai-sdk/mistral": "mistral-conversations",
	"@ai-sdk/azure": "azure-openai-responses",
});

/** PI api implementation id -> the opencode package we document for it. */
export const API_TO_NPM = Object.freeze(
	Object.fromEntries(Object.entries(NPM_TO_API).map(([npm, api]) => [api, npm])),
);

/** PI apis we accept for custom providers. */
export const SUPPORTED_APIS = Object.freeze(new Set(Object.values(NPM_TO_API)));

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Path of the providers file inside an agent directory. */
export function providersConfigPath(agentDir) {
	if (!agentDir) throw new TypeError("providersConfigPath requires an agent directory");
	return join(agentDir, PROVIDERS_FILE);
}

/** Resolve the PI api id for a provider config (explicit `api` wins). */
export function resolveApi(cfg) {
	if (cfg?.api) return String(cfg.api);
	const npm = cfg?.npm ? String(cfg.npm) : undefined;
	if (npm && NPM_TO_API[npm]) return NPM_TO_API[npm];
	if (npm) throw authError(AuthErrorCode.CONFIG, `Unsupported provider package "${npm}". Add an explicit "api" field.`);
	return "openai-completions";
}

/**
 * Parse opencode interpolation syntax.
 * @returns {{kind:"env", name:string}|{kind:"file", path:string}|{kind:"literal", value:string}}
 */
export function parseInterpolation(value) {
	const text = String(value ?? "");
	const env = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text);
	if (env) return { kind: "env", name: env[1] };
	const file = /^\{file:([^}]+)\}$/.exec(text);
	if (file) return { kind: "file", path: file[1].trim() };
	return { kind: "literal", value: text };
}

/** True when a config value is not a plain literal (env/file indirection). */
export function isInterpolated(value) {
	return parseInterpolation(value).kind !== "literal";
}

/**
 * Resolve `{env:VAR}` / `{file:path}` to a literal for one-off use (model
 * discovery, validation). Never write the resolved secret back to disk.
 */
export function interpolate(value, { env = process.env, readFile = defaultReadFile } = {}) {
	const parsed = parseInterpolation(value);
	if (parsed.kind === "env") {
		const resolved = env?.[parsed.name];
		if (resolved === undefined) {
			throw authError(AuthErrorCode.CONFIG, `Environment variable ${parsed.name} is not set.`);
		}
		return resolved;
	}
	if (parsed.kind === "file") {
		const path = parsed.path.startsWith("~")
			? join(process.env.HOME || "", parsed.path.slice(1).replace(/^\//, ""))
			: parsed.path;
		try {
			return String(readFile(path)).trim();
		} catch (error) {
			throw authError(AuthErrorCode.CONFIG, `Could not read key file ${path}: ${error.message}`, { cause: error });
		}
	}
	return parsed.value;
}

function defaultReadFile(path) {
	return readFileSync(path, "utf8");
}

function validateUrl(raw) {
	let url;
	try {
		url = new URL(String(raw));
	} catch {
		throw authError(AuthErrorCode.CONFIG, "Provider baseURL must be a valid URL.");
	}
	if (url.username || url.password) {
		throw authError(AuthErrorCode.CONFIG, "Provider baseURL must not contain credentials.");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
		throw authError(AuthErrorCode.CONFIG, "Provider baseURL must use HTTPS (HTTP is allowed only for loopback).");
	}
	return url.toString().replace(/\/$/, "");
}

function normalizeModel(modelId, model) {
	const id = String(model?.id || modelId || "").trim();
	if (!id) throw authError(AuthErrorCode.CONFIG, "Each model needs an id.");
	const limit = model?.limit && typeof model.limit === "object" ? model.limit : undefined;
	const context = model?.contextWindow ?? limit?.context;
	const output = model?.maxTokens ?? limit?.output;
	for (const [key, value] of [["contextWindow", context], ["maxTokens", output]]) {
		if (value !== undefined && !(Number.isFinite(Number(value)) && Number(value) > 0)) {
			throw authError(AuthErrorCode.CONFIG, `Model ${id} requires a positive ${key}.`);
		}
	}
	const normalized = { id, name: model?.name ? String(model.name) : id };
	if (model?.reasoning !== undefined) normalized.reasoning = model.reasoning === true;
	if (model?.input) normalized.input = model.input;
	if (model?.cost) normalized.cost = model.cost;
	if (context !== undefined) normalized.contextWindow = Number(context);
	if (output !== undefined) normalized.maxTokens = Number(output);
	if (model?.headers) normalized.headers = model.headers;
	if (model?.compat) normalized.compat = model.compat;
	if (model?.thinkingLevelMap) normalized.thinkingLevelMap = model.thinkingLevelMap;
	if (model?.samplingParams) normalized.samplingParams = model.samplingParams;
	if (model?.remoteId) normalized.remoteId = String(model.remoteId);
	return normalized;
}

/** Accept opencode's `models` map or our normalized array. */
function normalizeModels(models) {
	if (Array.isArray(models)) return models.map((model) => normalizeModel(model?.id, model));
	if (models && typeof models === "object") {
		return Object.entries(models).map(([modelId, model]) => normalizeModel(modelId, model));
	}
	return [];
}

/**
 * Validate and normalize one provider entry.
 * @throws {import("../errors.mjs").TsukuyomiAuthError} with code "config"
 */
export function normalizeProvider(id, cfg) {
	const providerId = String(id ?? cfg?.id ?? "").trim();
	if (!ID_RE.test(providerId)) {
		throw authError(AuthErrorCode.CONFIG, "Provider id must contain only lowercase letters, numbers, _ or -.");
	}
	const value = cfg && typeof cfg === "object" ? cfg : {};
	const options = value.options && typeof value.options === "object" ? value.options : {};
	const baseURLRaw = options.baseURL ?? value.baseURL ?? value.baseUrl ?? value.url;
	const api = resolveApi(value);
	const models = normalizeModels(value.models);
	const headers = options.headers ?? value.headers;
	const apiKey = options.apiKey ?? value.apiKey;
	const hasSomething =
		baseURLRaw !== undefined || models.length > 0 || headers !== undefined ||
		value.compat !== undefined || value.modelOverrides !== undefined ||
		apiKey !== undefined || value.authHeader !== undefined;
	if (!hasSomething) {
		throw authError(AuthErrorCode.CONFIG, `Provider ${providerId} must specify baseURL, headers, apiKey, compat, modelOverrides, or models.`);
	}
	const normalized = { id: providerId, api };
	if (value.name !== undefined) normalized.name = String(value.name);
	if (baseURLRaw !== undefined) normalized.baseURL = validateUrl(baseURLRaw);
	if (apiKey !== undefined) normalized.apiKey = String(apiKey);
	if (headers !== undefined) normalized.headers = { ...headers };
	if (value.compat !== undefined) normalized.compat = value.compat;
	if (value.authHeader !== undefined) normalized.authHeader = value.authHeader === true;
	if (value.oauth !== undefined) normalized.oauth = value.oauth;
	if (models.length > 0) normalized.models = models;
	if (Array.isArray(value.blacklist)) normalized.blacklist = value.blacklist.map(String);
	if (Array.isArray(value.whitelist)) normalized.whitelist = value.whitelist.map(String);
	if (value.origin !== undefined) normalized.origin = String(value.origin);
	return normalized;
}

/** Load and normalize providers.json. Comments/trailing commas allowed. */
export function loadProvidersConfig(agentDir) {
	const path = providersConfigPath(agentDir);
	if (!existsSync(path)) return { config: { provider: {} }, path, error: undefined };
	let parsed;
	try {
		parsed = parseJsonc(readFileSync(path, "utf8"));
	} catch (error) {
		return { config: { provider: {} }, path, error: `Failed to parse providers.json: ${error.message}` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { config: { provider: {} }, path, error: "Invalid providers.json: expected an object" };
	}
	return { config: { ...parsed, provider: parsed.provider && typeof parsed.provider === "object" ? parsed.provider : {} }, path, error: undefined };
}

/** Normalized provider entries from providers.json. Invalid entries are reported, not thrown. */
export function listProviderConfigs(agentDir) {
	const { config, path, error } = loadProvidersConfig(agentDir);
	if (error) return { providers: [], path, error };
	const providers = [];
	const errors = [];
	for (const [id, cfg] of Object.entries(config.provider || {})) {
		try {
			providers.push(normalizeProvider(id, cfg));
		} catch (cause) {
			errors.push({ id, error: cause.message });
		}
	}
	return { providers, path, error: errors.length ? errors.map((item) => `${item.id}: ${item.error}`).join("; ") : undefined };
}

function writeProvidersConfig(path, config) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	// Preserve the normalized entry shape; keys are stable so diffs stay small.
	writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: FILE_MODE });
	try {
		chmodSync(temp, FILE_MODE);
	} catch {
		// best effort
	}
	renameSync(temp, path);
	return config;
}

/** Insert or replace one provider. Throws instead of clobbering a broken file. */
export function saveProviderConfig(agentDir, id, cfg) {
	const loaded = loadProvidersConfig(agentDir);
	if (loaded.error) throw authError(AuthErrorCode.CONFIG, `${loaded.error}; refusing to overwrite.`);
	const normalized = normalizeProvider(id, cfg);
	const { id: _id, ...entry } = normalized;
	const provider = { ...(loaded.config.provider || {}), [normalized.id]: entry };
	return writeProvidersConfig(loaded.path, { ...loaded.config, provider });
}

/** Remove one provider; returns the remaining config. */
export function removeProviderConfig(agentDir, id) {
	const loaded = loadProvidersConfig(agentDir);
	if (loaded.error) throw authError(AuthErrorCode.CONFIG, `${loaded.error}; refusing to overwrite.`);
	const provider = { ...(loaded.config.provider || {}) };
	delete provider[id];
	return writeProvidersConfig(loaded.path, { ...loaded.config, provider });
}

/** Replace the whole `provider` map (used by models.json import). */
export function replaceProviderConfigs(agentDir, entries) {
	const loaded = loadProvidersConfig(agentDir);
	if (loaded.error) throw authError(AuthErrorCode.CONFIG, `${loaded.error}; refusing to overwrite.`);
	const provider = {};
	for (const [id, cfg] of Object.entries(entries || {})) {
		const { id: _id, ...entry } = normalizeProvider(id, cfg);
		provider[id] = entry;
	}
	return writeProvidersConfig(loaded.path, { ...loaded.config, provider });
}

/** Apply list filters to a provider's models (used at registration time). */
export function applyModelVisibility(models, cfg) {
	const whitelist = Array.isArray(cfg?.whitelist) ? new Set(cfg.whitelist) : undefined;
	const blacklist = new Set(Array.isArray(cfg?.blacklist) ? cfg.blacklist : []);
	return models.filter((model) => {
		if (whitelist && !whitelist.has(model.id)) return false;
		return !blacklist.has(model.id);
	});
}
