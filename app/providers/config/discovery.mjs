/**
 * Model discovery for custom providers.
 *
 * The four-field wizard (id, name, URL, API key) discovers models so the user
 * never types a model id by hand. Two dialects are supported:
 *   - OpenAI-compatible `GET {baseURL}/models`  -> `{ data: [{ id, name? }] }`
 *   - Anthropic `/v1/models`                    -> `{ data: [{ id, display_name? }] }`
 *
 * Discovery resolves `{env:}`/`{file:}` key references in memory only; the
 * resolved secret is never written to `providers.json` or `models.json`.
 */

import { authError, AuthErrorCode } from "../errors.mjs";
import { createProxyAwareFetch } from "../../http.mjs";
import { interpolate, normalizeProvider } from "./opencode.mjs";

/** Discovery talks to arbitrary self-hosted endpoints; proxy-aware by default. */
const proxyAwareFetch = createProxyAwareFetch();

/** Strip a trailing `/models` so `.../v1` and `.../v1/models` both work. */
function modelsEndpoint(baseURL) {
	const trimmed = String(baseURL).replace(/\/$/, "");
	return trimmed.endsWith("/models") ? trimmed : `${trimmed}/models`;
}

function pickName(item) {
	return String(item?.name || item?.display_name || item?.id || "");
}

/**
 * Discover models from an OpenAI-compatible endpoint.
 * @returns {Promise<{id: string, name: string}[]>}
 */
export async function discoverOpenAICompatible(baseURL, apiKey, { fetchImpl = proxyAwareFetch, signal, timeoutMs = 15_000 } = {}) {
	return requestModels(modelsEndpoint(baseURL), { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, { fetchImpl, signal, timeoutMs });
}

/** Discover models from an Anthropic-compatible endpoint. */
export async function discoverAnthropicCompatible(baseURL, apiKey, { fetchImpl = proxyAwareFetch, signal, timeoutMs = 15_000 } = {}) {
	return requestModels(
		modelsEndpoint(baseURL.replace(/\/v1\/?$/, "")),
		{ "x-api-key": apiKey, "anthropic-version": "2023-06-01", Accept: "application/json" },
		{ fetchImpl, signal, timeoutMs },
	);
}

async function requestModels(url, headers, { fetchImpl, signal, timeoutMs }) {
	let response;
	try {
		response = await fetchImpl(url, {
			headers,
			signal: signal ?? AbortSignal.timeout(timeoutMs),
			redirect: "error",
		});
	} catch (error) {
		throw authError(AuthErrorCode.DISCOVERY, `Model discovery failed: ${error.message}`, { cause: error });
	}
	if (!response.ok) {
		throw authError(AuthErrorCode.DISCOVERY, `Model discovery failed (HTTP ${response.status}). Check the URL and API key.`);
	}
	let payload;
	try {
		payload = await response.json();
	} catch {
		throw authError(AuthErrorCode.DISCOVERY, "Model discovery returned invalid JSON. No configuration was saved.");
	}
	const models = [];
	const seen = new Set();
	for (const item of Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []) {
		const id = String(item?.id ?? "").trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		models.push({ id, name: pickName(item) || id });
	}
	if (models.length === 0) {
		throw authError(AuthErrorCode.DISCOVERY, "The endpoint returned no models. No configuration was saved.");
	}
	return models;
}

/**
 * Turn intake from the wizard into a validated, normalized provider config,
 * discovering models when the caller did not supply them.
 *
 * @param {{id: string, name?: string, baseUrl: string, apiKey?: string, api?: string,
 *          models?: object[], env?: object, readFile?: Function, fetchImpl?: Function,
 *          signal?: AbortSignal, skipDiscovery?: boolean}} input
 */
export async function buildCustomProvider(input, deps = {}) {
	const env = deps.env ?? process.env;
	const readFile = deps.readFile;
	const api = input.api ?? "openai-completions";
	const provided = Array.isArray(input.models) && input.models.length > 0 ? input.models : undefined;
	let models = provided;
	if (!models) {
		if (input.skipDiscovery) {
			throw authError(AuthErrorCode.CONFIG, "At least one model is required when discovery is skipped.");
		}
		const rawKey = input.apiKey ?? "";
		if (!rawKey) throw authError(AuthErrorCode.CONFIG, "API key is required to discover models.");
		const key = interpolate(rawKey, { env, readFile });
		models = api === "anthropic-messages"
			? await discoverAnthropicCompatible(input.baseUrl, key, deps)
			: await discoverOpenAICompatible(input.baseUrl, key, deps);
	}
	return normalizeProvider(input.id, {
		name: input.name,
		api,
		baseURL: input.baseUrl,
		apiKey: input.apiKey,
		models,
	});
}

export { normalizeProvider };
