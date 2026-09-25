/**
 * Conversion between the opencode-style `providers.json` entry and PI's
 * `models.json` provider config (and PI's runtime `ProviderConfigInput`).
 *
 * Rules (documented in `docs/PROVIDERS.md`):
 *   - `npm`             <-> PI `api`       (see NPM_TO_API; explicit `api` wins)
 *   - `options.baseURL` <-> PI `baseUrl`
 *   - `options.headers` <-> PI `headers`
 *   - `options.apiKey`  <-> PI `apiKey` with interpolation rewritten:
 *         `{env:VAR}`   -> `${VAR}`       (PI template)
 *         `{file:path}` -> `!cat 'path'`  (PI command value)
 *         literal `$`   -> `$$` (escaped, so a literal key is never expanded)
 *   - `models.<id>.limit.context` <-> `contextWindow`
 *   - `models.<id>.limit.output`  <-> `maxTokens`
 *   - `blacklist`/`whitelist` are applied when writing `models.json` because
 *     PI's schema has no per-provider model filter.
 *
 * The opencode-style file stays the source of truth; `models.json` is a
 * derived artifact the PI kernel consumes.
 */

import { authError, AuthErrorCode } from "../errors.mjs";
import { API_TO_NPM, applyModelVisibility, loadProvidersConfig, normalizeProvider, parseInterpolation, replaceProviderConfigs, listProviderConfigs } from "./opencode.mjs";
import { listModelsProviders, loadModelsJson, replaceModelsProviders, upsertModelsProvider } from "./pi-models.mjs";

const DEFAULT_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** Escape PI's `$` template sigil so a literal value is never expanded. */
export function escapePiValue(value) {
	// Function replacement: a literal "$$" in a replacement string means "$".
	return String(value).replace(/\$/g, () => "$$");
}

/** Reverse {@link escapePiValue}. */
export function unescapePiValue(value) {
	return String(value).replace(/\$\$/g, "$").replace(/\$!/g, "!");
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** opencode interpolation -> PI config value (`$VAR`, `!command`, literal). */
export function toPiConfigValue(value) {
	const parsed = parseInterpolation(value);
	if (parsed.kind === "env") return `$${parsed.name}`;
	if (parsed.kind === "file") return `!cat ${shellQuote(parsed.path)}`;
	return escapePiValue(parsed.value);
}

/** PI config value -> opencode interpolation / literal (best effort). */
export function toOpencodeConfigValue(value) {
	const text = String(value);
	if (text.startsWith("!")) {
		const match = /^!cat\s+(.+)$/.exec(text.trim());
		if (match) return `{file:${match[1].replace(/^['"]|['"]$/g, "")}}`;
		return text; // shell commands have no opencode equivalent; keep verbatim
	}
	const env = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(text);
	if (env) return `{env:${env[1]}}`;
	return unescapePiValue(text);
}

/** Normalized opencode model -> PI `models.json` model definition. */
export function toPiModel(model) {
	const definition = { id: model.remoteId ?? model.id, name: model.name ?? model.id };
	if (model.api) definition.api = model.api;
	if (model.baseUrl) definition.baseUrl = model.baseUrl;
	if (model.reasoning !== undefined) definition.reasoning = model.reasoning;
	if (model.thinkingLevelMap) definition.thinkingLevelMap = model.thinkingLevelMap;
	if (model.input) definition.input = model.input;
	if (model.cost) definition.cost = model.cost;
	if (model.contextWindow !== undefined) definition.contextWindow = model.contextWindow;
	if (model.maxTokens !== undefined) definition.maxTokens = model.maxTokens;
	if (model.samplingParams) definition.samplingParams = model.samplingParams;
	if (model.headers) definition.headers = model.headers;
	if (model.compat) definition.compat = model.compat;
	return definition;
}

/** Normalized opencode provider -> PI `models.json` provider config. */
export function toPiModelsProvider(cfg) {
	const out = {};
	if (cfg.name) out.name = cfg.name;
	if (cfg.api) out.api = cfg.api;
	if (cfg.baseURL) out.baseUrl = cfg.baseURL;
	if (cfg.apiKey !== undefined) out.apiKey = toPiConfigValue(cfg.apiKey);
	if (cfg.headers) out.headers = mapValues(cfg.headers, toPiConfigValue);
	if (cfg.compat) out.compat = cfg.compat;
	if (cfg.authHeader) out.authHeader = true;
	if (cfg.oauth) out.oauth = cfg.oauth;
	const visible = applyModelVisibility(cfg.models ?? [], cfg);
	if (visible.length > 0) out.models = visible.map(toPiModel);
	if (cfg.modelOverrides) out.modelOverrides = cfg.modelOverrides;
	return out;
}

function fromPiModel(model) {
	const out = { id: model.id, name: model.name ?? model.id };
	if (model.api) out.api = model.api;
	if (model.reasoning !== undefined) out.reasoning = model.reasoning;
	if (model.input) out.input = model.input;
	if (model.cost) out.cost = model.cost;
	if (model.contextWindow !== undefined) out.contextWindow = model.contextWindow;
	if (model.maxTokens !== undefined) out.maxTokens = model.maxTokens;
	if (model.samplingParams) out.samplingParams = model.samplingParams;
	if (model.headers) out.headers = model.headers;
	if (model.compat) out.compat = model.compat;
	if (model.thinkingLevelMap) out.thinkingLevelMap = model.thinkingLevelMap;
	return out;
}

/** PI `models.json` provider config -> normalized opencode provider entry. */
export function toOpencodeProvider(providerId, piCfg) {
	const cfg = piCfg && typeof piCfg === "object" ? piCfg : {};
	const api = cfg.api ?? "openai-completions";
	const entry = { api };
	if (cfg.name) entry.name = cfg.name;
	if (cfg.baseUrl) entry.baseURL = cfg.baseUrl;
	if (cfg.apiKey !== undefined) entry.apiKey = toOpencodeConfigValue(cfg.apiKey);
	if (cfg.headers) entry.headers = mapValues(cfg.headers, toOpencodeConfigValue);
	if (cfg.compat) entry.compat = cfg.compat;
	if (cfg.authHeader) entry.authHeader = true;
	if (cfg.oauth) entry.oauth = cfg.oauth;
	if (Array.isArray(cfg.models) && cfg.models.length > 0) entry.models = cfg.models.map(fromPiModel);
	if (cfg.modelOverrides) entry.modelOverrides = cfg.modelOverrides;
	if (API_TO_NPM[api]) entry.npm = API_TO_NPM[api];
	entry.origin = "pi-models";
	return entry;
}

function mapValues(object, fn) {
	const out = {};
	for (const [key, value] of Object.entries(object || {})) out[key] = fn(value);
	return out;
}

/**
 * Normalized provider -> PI's runtime `ProviderConfigInput` so a freshly added
 * provider works before the kernel is restarted.
 */
export function toProviderConfigInput(cfg) {
	const input = { api: cfg.api };
	if (cfg.name) input.name = cfg.name;
	if (cfg.baseURL) input.baseUrl = cfg.baseURL;
	if (cfg.apiKey !== undefined) input.apiKey = toPiConfigValue(cfg.apiKey);
	if (cfg.headers) input.headers = mapValues(cfg.headers, toPiConfigValue);
	if (cfg.compat) input.compat = cfg.compat;
	if (cfg.authHeader) input.authHeader = true;
	const visible = applyModelVisibility(cfg.models ?? [], cfg);
	if (visible.length > 0) {
		input.models = visible.map((model) => ({
			id: model.remoteId ?? model.id,
			name: model.name ?? model.id,
			api: model.api ?? cfg.api,
			reasoning: model.reasoning ?? false,
			input: model.input ?? ["text"],
			cost: model.cost ?? DEFAULT_COST,
			contextWindow: model.contextWindow ?? 128000,
			maxTokens: model.maxTokens ?? 16384,
			...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
			...(model.samplingParams ? { samplingParams: model.samplingParams } : {}),
			...(model.headers ? { headers: model.headers } : {}),
			...(model.compat ? { compat: model.compat } : {}),
		}));
	}
	return input;
}

/** Write one provider from providers.json into PI's models.json. */
export function syncProviderToModelsJson(agentDir, providerId, normalizedCfg) {
	const cfg = normalizedCfg ?? normalizeProvider(providerId, {});
	return upsertModelsProvider(agentDir, providerId, toPiModelsProvider(cfg));
}

/** Remove a provider from PI's models.json (providers.json is edited by the caller). */
export function removeProviderFromModelsJson(agentDir, providerId) {
	return replaceModelsProvidersRemoving(agentDir, providerId);
}

function replaceModelsProvidersRemoving(agentDir, providerId) {
	const loaded = loadModelsJson(agentDir);
	if (loaded.error) throw authError(AuthErrorCode.CONFIG, loaded.error);
	const providers = { ...(loaded.config.providers || {}) };
	delete providers[providerId];
	return replaceModelsProviders(agentDir, providers);
}

/**
 * Import providers that exist only in models.json into providers.json so the
 * opencode-style file becomes the complete source of truth. Existing entries
 * win unless `overwrite` is set, so a provider we generated earlier is skipped.
 *
 * @returns {{imported: string[], providers: string[]}}
 */
export function importFromModelsJson(agentDir, { overwrite = false } = {}) {
	const { providers: piProviders, error } = listModelsProviders(agentDir);
	if (error) throw authError(AuthErrorCode.CONFIG, error);
	const existing = loadProvidersConfig(agentDir);
	if (existing.error) throw authError(AuthErrorCode.CONFIG, `${existing.error}; refusing to overwrite.`);
	const provider = { ...(existing.config.provider || {}) };
	const imported = [];
	for (const [id, piCfg] of Object.entries(piProviders)) {
		if (id in provider && !overwrite) continue;
		provider[id] = toOpencodeProvider(id, piCfg);
		imported.push(id);
	}
	if (imported.length > 0) replaceProviderConfigs(agentDir, provider);
	return { imported, providers: Object.keys(provider) };
}

/** Rebuild models.json from providers.json, preserving models.json-only providers. */
export function syncAllToModelsJson(agentDir) {
	const { providers } = listProviderConfigs(agentDir);
	const loaded = loadModelsJson(agentDir);
	if (loaded.error) throw authError(AuthErrorCode.CONFIG, loaded.error);
	const next = { ...(loaded.config.providers || {}) };
	for (const cfg of providers) next[cfg.id] = toPiModelsProvider(cfg);
	if (JSON.stringify(next) === JSON.stringify(loaded.config.providers || {})) return loaded.config;
	return replaceModelsProviders(agentDir, next);
}
