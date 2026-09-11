/**
 * Provider catalog: auth-method discovery, grouping, and ranking.
 *
 * All provider/model/auth facts come from PI (`ProviderRuntime`). This module
 * only derives presentation metadata, and every derivation is a pure function
 * so it can be unit-tested without PI or a terminal.
 *
 * Auth methods are what `/provider` offers for a provider:
 *   - `oauth`   when the provider (or an alias target) exposes `auth.oauth`
 *   - `api_key` when the provider exposes an interactive `auth.apiKey.login`
 * Ambient-only providers (AWS profiles, gcloud ADC, keyless local servers)
 * expose neither and resolve purely from the environment; `listAuthMethods`
 * returns an empty list for them and the UI explains why.
 */

/** Providers surfaced first when nothing is connected yet. */
export const POPULAR_PROVIDER_IDS = Object.freeze([
	"xai",
	"anthropic",
	"github-copilot",
	"openai-codex",
	"openai",
	"google",
]);

/**
 * Providers whose account login lives on a sibling PI provider id.
 * Declarative on purpose: an alias must name a real provider id, and
 * `listAuthMethods` silently ignores entries whose target is absent.
 */
export const AUTH_ALIASES = Object.freeze({
	openai: Object.freeze([{ id: "openai-codex", type: "oauth" }]),
});

/** Human label for an OAuth method: prefer the selector label PI declares. */
export function oauthLabel(oauth, fallback = "") {
	return oauth?.loginLabel || oauth?.name || fallback;
}

/**
 * Enumerate the sign-in methods for one provider.
 *
 * @param {object} provider provider record from `ProviderRuntime.providers()`
 * @param {object[]} allProviders full list, needed to resolve alias targets
 * @param {Record<string, {id: string, type: string}[]>} [aliases]
 * @returns {{type: "oauth"|"api_key", providerId: string, name: string,
 *            isSubscription?: boolean, alias?: boolean}[]}
 */
export function listAuthMethods(provider, allProviders = [], aliases = AUTH_ALIASES) {
	const methods = [];
	const seen = new Set();
	const push = (method) => {
		if (!method?.type) return;
		const providerId = method.providerId || provider?.id;
		if (!providerId) return;
		const key = `${providerId}:${method.type}`;
		if (seen.has(key)) return;
		seen.add(key);
		methods.push({ ...method, providerId });
	};

	if (provider?.auth?.oauth) {
		push({
			type: "oauth",
			providerId: provider.id,
			name: oauthLabel(provider.auth.oauth, provider.name),
			isSubscription: provider.auth.oauth.isSubscription === true,
		});
	}

	for (const alias of aliases?.[provider?.id] || []) {
		const target = allProviders.find((item) => item.id === alias.id);
		if (!target?.auth?.oauth) continue;
		push({
			type: "oauth",
			providerId: target.id,
			name: oauthLabel(target.auth.oauth, target.name),
			isSubscription: target.auth.oauth.isSubscription === true,
			alias: true,
		});
	}

	if (provider?.auth?.apiKey?.login) {
		push({
			type: "api_key",
			providerId: provider.id,
			name: provider.auth.apiKey.name || "API key",
		});
	}

	return methods;
}

/** True when at least one interactive sign-in method exists. */
export function hasAuthMethods(provider, allProviders = [], aliases = AUTH_ALIASES) {
	return listAuthMethods(provider, allProviders, aliases).length > 0;
}

/**
 * Bucket a provider for the browser's section headers.
 * @returns {"current"|"connected"|"popular"|"custom"|"other"}
 */
export function providerGroup(provider, { currentProviderId, popular = POPULAR_PROVIDER_IDS } = {}) {
	if (provider.id === currentProviderId) return "current";
	const configured = provider.status?.configured === true;
	if (configured) return "connected";
	if (popular.includes(provider.id)) return "popular";
	if (provider.custom) return "custom";
	return "other";
}

const GROUP_ORDER = Object.freeze({ current: 0, connected: 1, popular: 2, custom: 3, other: 4 });

/** Numeric sort key; lower comes first. */
export function rankProvider(provider, { currentProviderId, popular = POPULAR_PROVIDER_IDS } = {}) {
	const group = providerGroup(provider, { currentProviderId, popular });
	const popularity = popular.indexOf(provider.id);
	return {
		group: GROUP_ORDER[group] ?? GROUP_ORDER.other,
		popularity: popularity < 0 ? Number.MAX_SAFE_INTEGER : popularity,
		name: (provider.name || provider.id).toLowerCase(),
	};
}

/** Copy of `providers`, sorted for the browser (stable and locale-free). */
export function sortProviders(providers, options = {}) {
	return [...providers].sort((a, b) => {
		const ra = rankProvider(a, options);
		const rb = rankProvider(b, options);
		return ra.group - rb.group || ra.popularity - rb.popularity || (ra.name < rb.name ? -1 : ra.name > rb.name ? 1 : 0);
	});
}

/**
 * Load providers from the runtime and decorate each with `authMethods`,
 * `group`, and a normalized `authStatus`.
 *
 * @param {{providers: Function, authStatus?: Function}} runtime
 */
export async function loadProviderCatalog(runtime, { currentProviderId, popular = POPULAR_PROVIDER_IDS, aliases = AUTH_ALIASES } = {}) {
	const providers = (await runtime.providers()) || [];
	for (const provider of providers) {
		provider.authMethods = listAuthMethods(provider, providers, aliases);
		provider.group = providerGroup(provider, { currentProviderId, popular });
		provider.configured = provider.status?.configured === true;
	}
	return sortProviders(providers, { currentProviderId, popular });
}

/** `name · id` — the label used in provider pickers. */
export function providerLabel(provider) {
	if (!provider) return "";
	return provider.name && provider.name !== provider.id ? `${provider.name} · ${provider.id}` : provider.id;
}

/** Short status marker for a provider row: ✓ configured, ✗ not. */
export function providerStatusMark(provider) {
	return provider?.configured ? "✓" : "✗";
}
