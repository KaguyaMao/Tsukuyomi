/**
 * Provider account/quota lookups for `/status`.
 *
 * API protocols do not define billing, so quota is only queried for known
 * endpoints: OpenRouter key budget, DeepSeek balance, and ChatGPT/Codex account
 * windows. An OpenAI-compatible model is not evidence of a ChatGPT account, so
 * the provider id and `baseUrl` host must both match.
 *
 * Credentials always come from the provider they belong to (`getAuth` through
 * the runtime, or the stored credential for that exact provider id). A key is
 * never borrowed from another provider, and a proxy credential is never sent to
 * a public upstream billing service.
 */

import { createHash } from "node:crypto";
import { fetchGptUsage, USAGE_PAGE_URL } from "../status.mjs";
import { safeReadAuthStore } from "./store.mjs";

export const quotaAdapters = {
	openrouter: {
		host: "openrouter.ai",
		url: "https://openrouter.ai/api/v1/key",
		pageUrl: "https://openrouter.ai/settings/credits",
		parse(payload) {
			const data = payload?.data;
			if (!data || typeof data.usage !== "number") return undefined;
			return {
				windows: [],
				monthly: {
					used: String(data.usage),
					limit: data.limit == null ? undefined : String(data.limit),
					remainingPercent: data.limit > 0 ? Math.max(0, 100 * (1 - data.usage / data.limit)) : undefined,
				},
				credits: data.limit_remaining == null ? undefined : { balance: String(data.limit_remaining), hasCredits: data.limit_remaining > 0 },
			};
		},
	},
	deepseek: {
		host: "api.deepseek.com",
		url: "https://api.deepseek.com/user/balance",
		pageUrl: "https://platform.deepseek.com/usage",
		parse(payload) {
			if (!Array.isArray(payload?.balance_infos) || payload.balance_infos.length === 0) return undefined;
			return {
				windows: [],
				credits: {
					hasCredits: payload.is_available === true,
					balance: payload.balance_infos.map((item) => `${item.total_balance} ${item.currency}`).join(" / "),
				},
			};
		},
	},
};

export class ProviderUsageClient {
	constructor({ agentDir, env = process.env, resolveAuth, fetchImpl = globalThis.fetch, now = Date.now, ttlMs = 30_000 } = {}) {
		Object.assign(this, { agentDir, env, resolveAuth, fetchImpl, now, ttlMs });
		this.cache = new Map();
	}

	async get(model, { force = false } = {}) {
		const provider = model?.provider;
		if (!provider) return { kind: "unsupported", code: "model" };
		const adapter = quotaAdapters[provider];
		if (!adapter && provider !== "openai-codex") return { kind: "unsupported", code: "endpoint", provider };
		// Never send a proxy credential to the public upstream billing service.
		if (adapter && model.baseUrl && new URL(model.baseUrl).hostname !== adapter.host) {
			return { kind: "unsupported", code: "endpoint", provider };
		}
		const resolved = await this.resolveAuth?.(model);
		const authStore = safeReadAuthStore(this.agentDir);
		const credential = authStore[provider];
		const key = resolved?.auth?.apiKey || (credential?.type === "api_key" ? credential.key : credential?.access);
		const identity = createHash("sha256")
			.update(JSON.stringify([provider, model.baseUrl, key, credential, this.env.TSUKUYOMI_STATUS_URL || this.env.TSUKUYOMI_STATUS_URL]))
			.digest("hex");
		const cached = this.cache.get(identity);
		if (!force && cached && this.now() - cached.at < this.ttlMs) return { ...cached.value, cached: true };

		let value;
		if (provider === "openai-codex") {
			value = await fetchGptUsage({ model, authStore, env: this.env, fetchImpl: this.fetchImpl, now: this.now });
			value.pageUrl = USAGE_PAGE_URL;
		} else if (!key) {
			value = { kind: "unsupported", code: "no-auth" };
		} else {
			try {
				const response = await this.fetchImpl(adapter.url, {
					headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
					signal: AbortSignal.timeout(10_000),
					redirect: "error",
				});
				if (!response.ok) {
					value = { kind: "error", code: response.status === 401 || response.status === 403 ? "expired-auth" : "http", status: response.status };
				} else {
					const parsed = adapter.parse(await response.json());
					value = parsed
						? { kind: "available", ...parsed, capturedAt: this.now(), pageUrl: adapter.pageUrl }
						: { kind: "error", code: "malformed" };
				}
			} catch (error) {
				value = { kind: "error", code: ["TimeoutError", "AbortError"].includes(error?.name) ? "timeout" : "network" };
			}
		}
		value = { ...value, provider };
		this.cache.set(identity, { value, at: this.now() });
		return value;
	}

	clear() {
		this.cache.clear();
	}
}
