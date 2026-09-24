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
 *   - xAI/Grok OAuth: Grok Build's CLI chat proxy
 *     `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`
 *     (same request as `x.ai/billing` in grok-build). API keys have no
 *     consumer quota endpoint.
 *   - Anthropic with an API key: usage lives in the console.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { join } from "node:path";
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

		/** Grok Build's own `/usage` data comes from its CLI chat proxy. */
	xai: {
		id: "xai",
		hosts: ["api.x.ai", "grok.com"],
		credentialTypes: ["oauth"],
		pageUrl: (credentialType) =>
			credentialType === "oauth" ? "https://grok.com/?_s=usage" : "https://console.x.ai/usage",
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

export const GROK_CLI_CHAT_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_TOKEN_AUTH = "xai-grok-cli";
export const GROK_CLIENT_VERSION = "1.0.32";
export const GROK_CLIENT_IDENTIFIER = "grok-shell";

function decodeJwtPayload(token) {
	try {
		const part = String(token || "").split(".")[1];
		if (!part) return undefined;
		const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** `x-userid` from a Grok OAuth access token (`principal_id`, else `sub`). */
export function xaiUserIdFromAccessToken(access) {
	const payload = decodeJwtPayload(access);
	const id = payload?.principal_id || payload?.sub;
	return typeof id === "string" && id.trim() ? id : undefined;
}

function centValue(value) {
	if (value == null) return undefined;
	if (typeof value === "object") return finiteNumber(value.val);
	return finiteNumber(value);
}

/**
 * Headers Grok Build sends on every CLI chat-proxy billing request.
 * `X-XAI-Token-Auth` is required so nginx routes the request to OAuth;
 * without it the proxy can hang until our abort timer fires.
 */
export function grokProxyHeaders({ token, userId, env = {} } = {}) {
	const headers = {
		Accept: "application/json",
		Authorization: `Bearer ${token}`,
		"X-XAI-Token-Auth": env.GROK_TOKEN_HEADER || GROK_TOKEN_AUTH,
		"x-grok-client-version": env.GROK_CLIENT_VERSION || GROK_CLIENT_VERSION,
		"x-grok-client-identifier": env.GROK_CLIENT_NAME || GROK_CLIENT_IDENTIFIER,
		"x-grok-client-mode": "interactive",
	};
	if (userId) headers["x-userid"] = userId;
	return headers;
}

/**
 * Parse a `/rest/subscriptions` payload. Prefers an active subscription,
 * otherwise the first one. Returns a normalized plan or undefined when there
 * is nothing usable.
 */
export function parseXaiSubscriptions(payload) {
	const subs = Array.isArray(payload?.subscriptions) ? payload.subscriptions : [];
	if (subs.length === 0) return undefined;
	const active = subs.find((sub) => sub?.status === "SUBSCRIPTION_STATUS_ACTIVE") || subs[0];
	const tier = String(active?.tier || "")
		.replace(/^SUBSCRIPTION_TIER_/, "")
		.replace(/_/g, " ")
		.toLowerCase();
	const status = String(active?.status || "")
		.replace(/^SUBSCRIPTION_STATUS_/, "")
		.toLowerCase();
	const periodEnd = active?.billingPeriodEnd ? Date.parse(active.billingPeriodEnd) : undefined;
	return {
		tier: tier || undefined,
		status: status || undefined,
		periodEnd: Number.isFinite(periodEnd) ? periodEnd : undefined,
	};
}

/** Normalize the billing payload used by Grok Build's `/usage` modal. */
export function parseXaiBilling(payload, capturedAt = Date.now()) {
	const config = payload?.config;
	if (!config || typeof config !== "object") return undefined;
	const period = config.currentPeriod || config.current_period || {};
	let usedPercent = percent(config.creditUsagePercent ?? config.credit_usage_percent);
	if (usedPercent == null) {
		const limit = centValue(config.monthlyLimit ?? config.monthly_limit);
		const used = centValue(config.used);
		if (limit > 0 && used != null) usedPercent = percent(used / limit * 100);
	}
	if (usedPercent == null) return undefined;
	const start = resetAtOf(period.start ?? config.billingPeriodStart ?? config.billing_period_start, capturedAt);
	const end = resetAtOf(period.end ?? config.billingPeriodEnd ?? config.billing_period_end, capturedAt);
	const prepaid = centValue(config.prepaidBalance ?? config.prepaid_balance);
	return {
		usedPercent,
		remainingPercent: Math.max(0, 100 - usedPercent),
		windowSeconds: start != null && end != null && end > start ? (end - start) / 1000 : undefined,
		resetAt: end,
		periodType: String(period.type || period.periodType || "").replace(/^USAGE_PERIOD_TYPE_/, "").toLowerCase() || undefined,
		products: Array.isArray(config.productUsage) ? config.productUsage : Array.isArray(config.product_usage) ? config.product_usage : [],
		prepaidBalance: prepaid,
		subscriptionTier: payload.subscriptionTier || payload.subscription_tier || undefined,
	};
}

export class ProviderUsageClient {
	constructor({ agentDir, env = process.env, resolveAuth, fetchImpl, now = Date.now, ttlMs = 30_000, timeoutMs = 10_000 } = {}) {
		// Quota hosts are not always reachable directly; fall back to curl through
		// the configured proxy instead of surfacing "fetch failed".
		const fetcher = fetchImpl ?? createProxyAwareFetch({ env });
		// Resolve the credential directory the same way the rest of the app does
		// (tui.mjs reads the Tsukuyomi-owned canonical root).
		// Without this, a missing env var would make credential lookup fail and the
		// status view would wrongly report "no public endpoint" instead of the
		// real subscription plan.
		const resolvedAgentDir = agentDir
			|| env?.TSUKUYOMI_DIR
			|| env?.PI_CODING_AGENT_DIR
			|| join(process.env.HOME || "", ".tsukuyomi", "agent");
		Object.assign(this, { agentDir: resolvedAgentDir, env, resolveAuth, fetchImpl: fetcher, now, ttlMs, timeoutMs });
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
			return this.#cached(model, credential, force, async () => {
				const resolved = await this.#resolveCredential(model, credential);
				return fetchGptUsage({
					model,
					authStore,
					credential: resolved.credential,
					env: this.env,
					fetchImpl: this.fetchImpl,
					now: this.now,
					timeoutMs: this.timeoutMs,
				});
			});
		}

		// xAI/Grok: the consumer subscription plan is readable with the OAuth
		// token, but the weekly usage pool is not (see adapter note).
		if (provider === "xai") {
			return this.#cached(model, credential, force, async () =>
				this.#requestXai({ model, credential, credentialType }));
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

	async #resolveCredential(model, credential) {
		if (!this.resolveAuth) return { credential, resolved: undefined };
		try {
			const resolved = await this.resolveAuth(model);
			const key = resolved?.auth?.apiKey;
			if (!key || !credential) return { credential, resolved };
			// PI may have just refreshed an OAuth access token.  Keep metadata
			// such as accountId, but clear a stale expires so status checks do
			// not reject a token the runtime already considers usable.
			const next = credential.type === "oauth"
				? { ...credential, access: key, expires: Math.max(Number(credential.expires) || 0, this.now() + 60_000) }
				: { ...credential, key };
			return { credential: next, resolved };
		} catch {
			// Status/quota is best effort.  A stale token may still be accepted,
			// while a transient refresh failure should not hide the endpoint.
			return { credential, resolved: undefined };
		}
	}

	async #requestAdapter({ adapter, model, credential, credentialType }) {
		const resolved = await this.#resolveCredential(model, credential);
		const effectiveCredential = resolved.credential;
		const key = credentialType === "oauth"
			? (effectiveCredential?.access || credential.access)
			: (resolved.resolved?.auth?.apiKey || effectiveCredential?.key || credential.key);
		if (!key) return { kind: "unsupported", code: "no-auth", provider: adapter.id };

		const { url, headers, method, body } = adapter.request({ model, credential: effectiveCredential, resolved: resolved.resolved, key, env: this.env });
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

	/**
	 * xAI/Grok. API-key accounts have no consumer subscription and no quota
	 * endpoint (rate limits only arrive as `x-ratelimit-*` headers on model
	 * calls), so they fall back to "no-endpoint". OAuth accounts use Grok Build's
	 * CLI chat proxy billing endpoints for the same data shown by `/usage`.
	 */
	async #requestXai({ model, credential, credentialType }) {
		if (credentialType !== "oauth") {
			return {
				kind: "unsupported",
				code: "no-endpoint",
				provider: "xai",
				pageUrl: credentialType === "api_key" ? "https://console.x.ai/usage" : "https://grok.com/?_s=usage",
			};
		}
		const resolved = await this.#resolveCredential(model, credential);
		const token = resolved.credential?.access;
		if (!token) {
			return { kind: "unsupported", code: "no-auth", provider: "xai", pageUrl: "https://grok.com/?_s=usage" };
		}
		const base = String(this.env.GROK_CLI_CHAT_PROXY_BASE_URL || GROK_CLI_CHAT_PROXY_BASE_URL).replace(/\/$/, "");
		const headers = grokProxyHeaders({
			token,
			userId: xaiUserIdFromAccessToken(token),
			env: this.env,
		});
		const fetchOne = async (url) => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), this.timeoutMs);
			try {
				return await this.fetchImpl(url, { method: "GET", headers, signal: controller.signal, redirect: "error" });
			} finally {
				clearTimeout(timer);
			}
		};
		// `/user` is enrichment only. Grok Build's `/usage` is billed from
		// `/billing?format=credits`; waiting on a hung `/user` used to surface
		// a timeout even after billing had already returned.
		let userPayload;
		const userPromise = fetchOne(`${base}/user?include=subscription`)
			.then(async (response) => {
				if (!response?.ok) return undefined;
				return response.json().catch(() => undefined);
			})
			.then((payload) => { userPayload = payload; return payload; })
			.catch(() => undefined);
		try {
			const billingResponse = await fetchOne(`${base}/billing?format=credits`);
			if (billingResponse.status === 401 || billingResponse.status === 403) {
				return { kind: "unsupported", code: "expired-auth", provider: "xai", pageUrl: "https://grok.com/?_s=usage" };
			}
			if (!billingResponse.ok) return { kind: "error", code: "http", status: billingResponse.status, provider: "xai" };
			const billing = parseXaiBilling(await billingResponse.json().catch(() => null), this.now());
			if (!billing) return { kind: "error", code: "malformed", provider: "xai" };
			await Promise.race([userPromise, Promise.resolve()]);
			const user = userPayload && typeof userPayload === "object" ? userPayload : undefined;
			const tier = user?.subscriptionTier || user?.subscription_tier || billing.subscriptionTier;
			const products = billing.products
				.filter((item) => item?.product && finiteNumber(item?.usagePercent) != null)
				.map((item) => `${item.product}: ${percent(item.usagePercent)}%`).join(" · ");
			const productName = billing.products.find((item) => item?.product)?.product;
			const prepaid = billing.prepaidBalance;
			return {
				kind: "available",
				plan: { tier: tier || undefined, status: "active" },
				windows: [{ kind: "primary", bucketName: productName || billing.periodType || "grok", usedPercent: billing.usedPercent, remainingPercent: billing.remainingPercent, windowSeconds: billing.windowSeconds, resetAt: billing.resetAt }],
				credits: prepaid != null && prepaid > 0 ? { hasCredits: true, balance: `$${(prepaid / 100).toFixed(2)}` } : undefined,
				pageUrl: "https://grok.com/?_s=usage",
				note: products || undefined,
				provider: "xai",
				capturedAt: this.now(),
			};
		} catch (error) {
			if (error?.name === "AbortError" || error?.name === "TimeoutError") {
				return { kind: "error", code: "timeout", provider: "xai" };
			}
			if (isNetworkError(error)) {
				return { kind: "error", code: "network", provider: "xai", reason: error.message };
			}
			return { kind: "error", code: "http", provider: "xai", reason: error instanceof Error ? error.message : String(error) };
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
