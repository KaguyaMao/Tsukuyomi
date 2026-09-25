/** Parse pasted Codex and Claude Code configuration without reading their files. */
import { parse as parseToml } from "smol-toml";
import { normalizeProvider } from "./opencode.mjs";

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const nonempty = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const json = (text, label) => {
	try {
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
		return parsed;
	}
	catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
};
const stringMap = (value) => Object.fromEntries(Object.entries(object(value)).filter(([, v]) => typeof v === "string"));

/**
 * Codex's provider table is authoritative for wire format and base URL. Its
 * auth.json may hold an API key or a ChatGPT OAuth session. The latter is only
 * meaningful for the built-in OpenAI service, not an arbitrary relay.
 */
export function parseCodexImport(configText, authText, { id, name, env = process.env } = {}) {
	let config;
	try { config = object(parseToml(configText)); }
	catch (error) { throw new Error(`config.toml is not valid TOML: ${error.message}`); }
	const auth = json(authText, "auth.json");
	const profile = object(object(config.profiles)[nonempty(config.profile)]);
	const selected = nonempty(profile.model_provider) || nonempty(config.model_provider) || "openai";
	const provider = object(object(config.model_providers)[selected]);
	const baseURL = nonempty(provider.base_url) || nonempty(config.openai_base_url) || "https://api.openai.com/v1";
	const wire = nonempty(provider.wire_api) || "responses";
	if (!["responses", "chat_completions", "chat-completions"].includes(wire)) throw new Error(`Unsupported Codex wire_api: ${wire}`);
	const modelId = nonempty(profile.model) || nonempty(config.model);
	if (!modelId) throw new Error("config.toml needs a model value so Tsukuyomi can register it without probing the relay.");
	const keyName = nonempty(provider.env_key);
	const headers = { ...stringMap(provider.http_headers) };
	const authorization = nonempty(headers.Authorization) || nonempty(headers.authorization);
	const headerKey = authorization?.replace(/^Bearer\s+/i, "") || nonempty(headers["x-api-key"]);
	delete headers.Authorization;
	delete headers.authorization;
	delete headers["x-api-key"];
	const key = nonempty(auth.OPENAI_API_KEY) || (keyName && nonempty(auth[keyName])) || nonempty(provider.experimental_bearer_token) || (keyName && nonempty(env[keyName])) || headerKey;
	if (!key) throw new Error(`auth.json needs OPENAI_API_KEY${keyName ? ` or ${keyName}` : ""}; an OAuth session cannot authenticate a custom relay.`);
	for (const [header, variable] of Object.entries(stringMap(provider.env_http_headers))) {
		if (nonempty(env[variable])) headers[header] = `{env:${variable}}`;
	}
	const model = {
		id: modelId, name: modelId, reasoning: wire === "responses" || Boolean(nonempty(profile.model_reasoning_effort) || nonempty(config.model_reasoning_effort)),
		contextWindow: Number(config.model_context_window) > 0 ? Number(config.model_context_window) : 128000,
		maxTokens: Number(config.model_max_output_tokens) > 0 ? Number(config.model_max_output_tokens) : 16384,
	};
	const providerId = id || selected.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	const normalized = normalizeProvider(providerId, {
		name: name || nonempty(provider.name) || providerId,
		api: wire === "responses" ? "openai-responses" : "openai-completions",
		baseURL,
		headers,
		models: [model],
		origin: "codex-native",
	});
	return { config: normalized, credential: { type: "api_key", key }, thinking: nonempty(profile.model_reasoning_effort) || nonempty(config.model_reasoning_effort) };
}

/** settings.json + a pasted local credential JSON use Claude Code's env names. */
export function parseClaudeImport(settingsText, credentialText, { id, name } = {}) {
	const settings = json(settingsText, "settings.json");
	const credentials = json(credentialText, "credential JSON");
	const env = object(settings.env);
	const baseURL = nonempty(env.ANTHROPIC_BASE_URL) || "https://api.anthropic.com";
	const bearer = nonempty(credentials.ANTHROPIC_AUTH_TOKEN) || nonempty(credentials.authToken) || nonempty(env.ANTHROPIC_AUTH_TOKEN);
	const key = nonempty(credentials.ANTHROPIC_API_KEY) || nonempty(credentials.apiKey) || nonempty(env.ANTHROPIC_API_KEY) || bearer;
	if (!key) throw new Error("Claude credential JSON needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.");
	const models = [...new Set([
		nonempty(settings.model), nonempty(env.ANTHROPIC_MODEL),
		nonempty(env.ANTHROPIC_DEFAULT_OPUS_MODEL), nonempty(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
		nonempty(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
	].filter(Boolean))].map((modelId) => ({ id: modelId, name: modelId, reasoning: true }));
	if (!models.length) throw new Error("settings.json needs model or ANTHROPIC_MODEL; Tsukuyomi will not probe the relay with a short request.");
	const providerId = id || "claude-compatible";
	const normalized = normalizeProvider(providerId, {
		name: name || providerId,
		api: "anthropic-messages",
		baseURL,
		authHeader: Boolean(bearer),
		models,
		origin: "claude-native",
	});
	return { config: normalized, credential: { type: "api_key", key } };
}
