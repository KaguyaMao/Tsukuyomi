/**
 * Provider account/quota lookups for `/status`.
 *
 * Design rules (these matter more than the individual endpoints):
 *
 *  1. A quota adapter only ever talks to the provider it belongs to. The stored
 *     credential for that exact provider id is used, and a proxy credential is
 *     never sent to a public billing service: if `model.baseUrl` points at a
 *     different host than the adapter declares, the lookup is refused.
 *  2. Each adapter declares which credential types it supports. An API-key
 *     account and a subscription (OAuth) account expose different data, or none
 *     at all, and reporting "unsupported" is better than guessing.
 *  3. Providers with no public quota endpoint say so explicitly
 *     (`code: "no-endpoint"`) and offer the page where the usage actually lives,
 *     instead of fabricating a request that would fail.
 *
 * Requests go through `createProxyAwareFetch`, so a host that is only reachable
 * through the proxy still works.
 *
 * Verified endpoints today:
 *   - Anthropic (Claude Pro/Max, OAuth): `GET https://api.anthropic.com/api/oauth/usage`
 *     with `anthropic-beta: oauth-2025-04-20` and a `claude-code/`-style
 *     User-Agent (without it the endpoint rate-limits aggressively).
 *   - OpenAI Codex (ChatGPT, OAuth): `chatgpt.com/backend-api/wham/usage`.
 *   - OpenRouter: `GET https://openrouter.ai/api/v1/key` (API key).
 *   - DeepSeek: `GET https://api.deepseek.com/user/balance` (API key).
 *
 * Not available as an API:
 *   - xAI/Grok: usage lives in the console (`console.x.ai/usage`) or in the
 *     subscription's weekly pool (Settings -> Usage). Rate limits are returned
 *     as `x-ratelimit-*` headers on model calls, not as a quota endpoint.
 *   - Anthropic with an API key: usage lives in the console.
 */

import { createHash } from "node:crypto";
import { fetchGptUsage, USAGE_PAGE_URL } from "../status.mjs";
import { createProxyAwareFetch, isNetworkError } from "../http.mjs";
import { safeReadAuthStore } from "./store.mjs";

/** Window definitions for the Anthropic OAuth usage payload. */
const ANTHROPIC_WINDOWS = [
	{ key: "five_hour", seconds: 5 * 3600, kind: "primary", bucket: "" },
	{ key: "seven_day", seconds: 7 * 24 * 3600, kind: "secondary", bucket: "" },
	{ key: "seven_day_sonnet", seconds: 7 * 24 * 3600, kind: "primary", bucket: "sonnet" },
	{ key: "seven_day_opus", seconds: 7 * 24 * 3600, kind: "primary", bucket: "opus" },
	{ key: "seven_day_oauth_apps", seconds: 7 * 24 * 3600, kind: "primary", bucket: "apps" },
	{ key: "seven_day_cowork", seconds: 7 * 24 * 3600, kind: "primary", bucket: "cowork" },
];

function finiteNumber(value) {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function percent(value) {
	const number = finiteNumber(value);
	if (number == null) return undefined;
	return Math.max(0, Math.min(100, number));
}

function hostOf(baseUrl) {
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

/**
 * Anthropic returns `utilization` inconsistently across deployments: sometimes
 * a fraction (0.34) and sometimes a percentage (34.0). Decide once per payload
 * using the largest value seen, so a single window at 1.0 is read as 100%.
 */
function utilizationScale(payload) {
	const values = [];
	const collect = (window) => {
		const value = finiteNumber(window?.utilization);
		if (value != null) values.push(value);
	};
	for (const definition of ANTHROPIC_WINDOWS) collect(payload?.[definition.key]);
	collect(payload?.extra_usage);
	return values.length > 0 && Math.max(...values) <= 1 ? 100 : 1;
}

export const quotaAdapters = {
	anthropic: {
		id: "anthropic",
		/** Only the official API host; a proxy must not receive the OAuth token. */
		hosts: ["api.anthropic.com"],
		/** Subscription accounts only; API keys have no public usage endpoint. */
		credentialTypes: ["oauth"],
		pageUrl: () => "https://claude.ai/settings/usage",
		noEndpointFor: () => "api-key",
		request({ credential, env = {} }) {
			return {
				url: env.TSUKUYOMI_ANTHROPIC_USAGE_URL || "https://api.anthropic.com/api/oauth/usage",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					Authorization: `Bearer ${credential.access}`,
					"anthropic-beta": "oauth-2025-04-20",
					// Required: without it the endpoint returns persistent 429s.
					"User-Agent": "claude-code/",
				},
			};
		},
		parse(payload, { capturedAt }) {
			const source = payload && typeof payload === "object" ? payload : {};
			const scale = utilizationScale(source);
			const windows = [];
			for (const definition of ANTHROPIC_WINDOWS) {
				const window = source[definition.key];
				const utilization = finiteNumber(window?.utilization);
				if (utilization == null) continue;
				const usedPercent = percent(utilization * scale);
				if (usedPercent == null) continue;
				windows.push({
					kind: definition.kind,
					bucketName: definition.bucket || "claude",
					usedPercent,
					remainingPercent: Math.max(0, 100 - usedPercent),
					windowSeconds: definition.seconds,
					resetAt: resetAtOf(window?.resets_at, capturedAt),
				});
			}
			const extra = source.extra_usage;
			let monthly;
			let credits;
			if (extra && typeof extra === "object") {
				const limit = finiteNumber(extra.monthly_limit);
				const used = finiteNumber(extra.used_credits);
				const utilization = percent(finiteNumber(extra.utilization) != null ? finiteNumber(extra.utilization) * scale : undefined);
				if (limit != null && used != null) {
					monthly = {
						used: String(used),
						limit: String(limit),
						remainingPercent: limit > 0 ? Math.max(0, 100 - used / limit * 100) : undefined,
					};
				} else if (utilization != null) {
					monthly = { used: used == null ? undefined : String(used), limit: limit == null ? undefined : String(limit), remainingPercent: Math.max(0, 100 - utilization) };
				}
				if (extra.is_enabled === true || (used != null && limit != null)) {
					credits = {
						hasCredits: extra.is_enabled !== false,
						balance: used != null && limit != null ? `${used} / ${limit}` : undefined,
					};
				}
			}
			if (windows.length === 0 && !monthly && !credits) return undefined;
			return { kind: "available", planType: source.plan_type == null ? undefined : String(source.plan_type), windows, monthly, credits, capturedAt };
		},
	},

	openrouter: {
		id: "openrouter",
		hosts: ["openrouter.ai"],
		credentialTypes: ["api_key"],
		pageUrl: () => "https://openrouter.ai/settings/credits",
		request({ key }) {
			return {
				url: "https://openrouter.ai/api/v1/key",
				headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
			};
		},
		parse(payload) {
			const data = payload?.data;
			if (!data || typeof data.usage !== "number") return undefined;
			return {
				kind: "available",
				windows: [],
				monthly: {
					used: String(data.usage),
					limit: data.limit == null ? undefined : String(data.limit),
					remainingPercent: data.limit > 0 ? Math.max(0, 100 * (1 - data.usage / data.limit)) : undefined,
				},
				credits: data.limit_remaining == null ? undefined : {
					balance: String(data.limit_remaining),
					hasCredits: data.limit_remaining > 0,
				},
			};
		},
	},

	deepseek: {
		id: "deepseek",
		hosts: ["api.deepseek.com"],
		credentialTypes: ["api_key"],
		pageUrl: () => "https://platform.deepseek.com/usage",
		request({ key }) {
			return {
				url: "https://api.deepseek.com/user/balance",
				headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
			};
		},
		parse(payload) {
			if (!Array.isArray(payload?.balance_infos) || payload.balance_infos.length === 0) return undefined;
			return {
				kind: "available",
				windows: [],
				credits: {
					hasCredits: payload.is_available === true,
					balance: payload.balance_infos
						.map((item) => `${item.total_balance} ${item.currency}`)
						.join(" / "),
				},
			};
		},
	},

	/**
	 * xAI/Grok has no public quota or balance endpoint. Usage is visible in the
	 * console (API keys) or in Settings -> Usage (subscription weekly pool), and
	 * rate limits are only returned as `x-ratelimit-*` headers on model calls.
	 */
	xai: {
		id: "xai",
		hosts: ["api.x.ai"],
		credentialTypes: ["oauth", "api_key"],
		unsupported: "no-public-quota-endpoint",
		pageUrl: (credentialType) =>
			credentialType === "oauth" ? "https://grok.com/settings/usage" : "https://console.x.ai/usage",
	},
};

function resetAtOf(value, capturedAt) {
	if (value == null) return undefined;
	const parsed = Date.parse(value);
	if (Number.isFinite(parsed)) return parsed;
	const seconds = finiteNumber(value);
	if (seconds == null) return undefined;
	// Accept epoch seconds as well as milliseconds.
	return seconds < 100_000_000_000 ? seconds * 1_000 : seconds;
}

export class ProviderUsageClient {
	constructor({ agentDir, env = process.env, resolveAuth, fetchImpl, now = Date.now, ttlMs = 30_000, timeoutMs = 10_000 } = {}) {
		// Quota hosts are not always reachable directly; fall back to curl through
		// the configured proxy instead of surfacing "fetch failed".
		const fetcher = fetchImpl ?? createProxyAwareFetch({ env });
		Object.assign(this, { agentDir, env, resolveAuth, fetchImpl: fetcher, now, ttlMs, timeoutMs });
		this.cache = new Map();
	}

	clear() {
		this.cache.clear();
	}

	/** Supported credential types for a provider, or undefined when unknown. */
	static supports(providerId, credentialType) {
		const adapter = quotaAdapters[providerId];
		if (!adapter || adapter.unsupported) return false;
		return adapter.credentialTypes.includes(credentialType);
	}

	async get(model, { force = false } = {}) {
		const provider = model?.provider;
		if (!provider) return { kind: "unsupported", code: "model" };
		const adapter = quotaAdapters[provider];
		const authStore = safeReadAuthStore(this.agentDir);
		const credential = authStore[provider];
		const credentialType = credential?.type;

		// Codex keeps its own resolver: it honours the status-URL override and
		// understands the ChatGPT usage payload.
		if (provider === "openai-codex") {
			return this.#cached(model, credential, force, async () =>
				fetchGptUsage({
					model,
					authStore,
					env: this.env,
					fetchImpl: this.fetchImpl,
					now: this.now,
					timeoutMs: this.timeoutMs,
				}));
		}

		if (!adapter) return { kind: "unsupported", code: "endpoint", provider };
		if (adapter.unsupported) {
			return {
				kind: "unsupported",
				code: "no-endpoint",
				provider,
				pageUrl: adapter.pageUrl?.(credentialType),
			};
		}

		// Never send a credential to a host that is not the provider's own.
		const host = hostOf(model?.baseUrl);
		if (adapter.hosts?.length && host && !adapter.hosts.includes(host)) {
			return { kind: "unsupported", code: "endpoint", provider };
		}
		if (!credentialType) return { kind: "unsupported", code: "no-auth", provider, pageUrl: adapter.pageUrl?.(undefined) };
		if (!adapter.credentialTypes.includes(credentialType)) {
			return {
				kind: "unsupported",
				code: credentialType === "api_key" ? "api-key" : "expired-auth",
				provider,
				pageUrl: adapter.pageUrl?.(credentialType),
			};
		}

		return this.#cached(model, credential, force, async () =>
			this.#requestAdapter({ adapter, model, credential, credentialType }));
	}

	async #requestAdapter({ adapter, model, credential, credentialType }) {
		const resolved = await this.resolveAuth?.(model);
		const key = credentialType === "oauth"
			? credential.access
			: (resolved?.auth?.apiKey || credential.key);
		if (!key) return { kind: "unsupported", code: "no-auth", provider: adapter.id };

		const { url, headers, method, body } = adapter.request({ model, credential, resolved, key, env: this.env });
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await this.fetchImpl(url, { method: method || "GET", headers, body, signal: controller.signal, redirect: "error" });
			if (response.status === 401 || response.status === 403) {
				return { kind: "unsupported", code: "expired-auth", provider: adapter.id, pageUrl: adapter.pageUrl?.(credentialType) };
			}
			if (response.status === 429) {
				return { kind: "error", code: "rate-limited", provider: adapter.id, pageUrl: adapter.pageUrl?.(credentialType) };
			}
			if (!response.ok) {
				return { kind: "error", code: "http", status: response.status, provider: adapter.id };
			}
			let payload;
			try {
				payload = await response.json();
			} catch {
				return { kind: "error", code: "malformed", provider: adapter.id };
			}
			const parsed = adapter.parse(payload, { capturedAt: this.now(), response });
			if (!parsed) return { kind: "error", code: "malformed", provider: adapter.id };
			return { ...parsed, provider: adapter.id, pageUrl: parsed.pageUrl || adapter.pageUrl?.(credentialType) };
		} catch (error) {
			if (error?.name === "AbortError" || error?.name === "TimeoutError") {
				return { kind: "error", code: "timeout", provider: adapter.id };
			}
			if (isNetworkError(error)) {
				return { kind: "error", code: "network", provider: adapter.id, reason: error.message };
			}
			return { kind: "error", code: "http", provider: adapter.id, reason: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	}

	/** Cache identical queries for `ttlMs`; `force` bypasses it. */
	async #cached(model, credential, force, run) {
		const identity = createHash("sha256")
			.update(JSON.stringify([
				model?.provider,
				model?.baseUrl,
				credential?.type,
				credential?.expires ?? null,
				this.env.TSUKUYOMI_STATUS_URL || this.env.KAGUYAPI_STATUS_URL || null,
				this.env.TSUKUYOMI_ANTHROPIC_USAGE_URL || null,
			]))
			.digest("hex");
		const cached = this.cache.get(identity);
		if (!force && cached && this.now() - cached.at < this.ttlMs) {
			return { ...cached.value, cached: true };
		}
		const value = await run();
		this.cache.set(identity, { value, at: this.now() });
		return value;
	}
}

export { USAGE_PAGE_URL };
