import { safeReadAuthStore } from "./providers/store.mjs";

export const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const USAGE_PAGE_URL = "https://chatgpt.com/codex/settings/usage";
export const DEFAULT_USAGE_CACHE_TTL_MS = 30_000;

const KNOWN_CHATGPT_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com"]);

function finiteNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

function firstValue(object, keys) {
	if (!object || typeof object !== "object") return undefined;
	for (const key of keys) {
		if (object[key] !== undefined && object[key] !== null) return object[key];
	}
	return undefined;
}

function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function epochMilliseconds(value) {
	const number = finiteNumber(value);
	if (number == null || number <= 0) return undefined;
	return number < 100_000_000_000 ? number * 1_000 : number;
}

function clampPercent(value) {
	const number = finiteNumber(value);
	return number == null ? undefined : Math.max(0, Math.min(100, number));
}

function isOpenAiProvider(provider) {
	const value = String(provider || "").toLowerCase();
	return value === "openai" || value.includes("openai") || value.includes("codex");
}

/** Return true only for GPT-family models backed by an OpenAI/Codex provider. */
export function isGptModel(model) {
	const id = String(model?.id || model?.name || "").trim().toLowerCase();
	if (!/^gpt(?:[-_.]|$)/.test(id)) return false;
	return isOpenAiProvider(model?.provider) || String(model?.api || "").toLowerCase().includes("openai") ||
		KNOWN_CHATGPT_HOSTS.has(String(model?.baseUrl || "").replace(/^https?:\/\//, "").split("/")[0].toLowerCase());
}

/**
 * Display-safe credential read. The file parsing/validation lives in
 * `app/providers/store.mjs`; re-exported here so existing callers keep working
 * while the format is owned in one place.
 */
export function readAuthStore(agentDir) {
	return safeReadAuthStore(agentDir);
}

export function selectCredential(authStore, provider) {
	if (!authStore || typeof authStore !== "object") return undefined;
	const candidates = [provider].filter(Boolean);
	for (const name of [...new Set(candidates)]) {
		const credential = asObject(authStore[name]);
		if (credential) return credential;
	}
	return undefined;
}

export function classifyGptStatus(model, credential, now = Date.now()) {
	if (model?.provider !== "openai-codex") return { kind: "unsupported", code: "model" };
	if (!credential) return { kind: "unsupported", code: "no-auth" };
	if (credential.type === "oauth") {
		if (typeof credential.access !== "string" || !credential.access.trim()) return { kind: "unsupported", code: "no-auth" };
		const expires = finiteNumber(credential.expires);
		if (expires != null && expires > 0 && expires <= now) return { kind: "unsupported", code: "expired-auth" };
		return { kind: "oauth", code: "ok" };
	}
	if (credential.type === "api_key") return { kind: "api-key", code: "api-key" };
	return { kind: "unsupported", code: "no-auth" };
}

function normalizeUsageUrl(raw, explicit = false) {
	let url;
	try {
		url = new URL(raw || DEFAULT_USAGE_URL);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:") return undefined;
	const host = url.hostname.toLowerCase();
	if (!explicit && !KNOWN_CHATGPT_HOSTS.has(host)) return undefined;
	url.search = "";
	url.hash = "";
	const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
	if (normalizedPath.endsWith("/wham/usage")) {
		url.pathname = normalizedPath;
		return url.toString();
	}
	if (explicit && normalizedPath !== "/" && !normalizedPath.endsWith("/backend-api")) {
		url.pathname = normalizedPath;
		return url.toString();
	}
	if (!explicit && KNOWN_CHATGPT_HOSTS.has(host)) {
		url.pathname = "/backend-api/wham/usage";
		return url.toString();
	}
	let pathname = normalizedPath === "/" ? "" : normalizedPath;
	if (!pathname.endsWith("/backend-api")) pathname += "/backend-api";
	url.pathname = `${pathname}/wham/usage`;
	return url.toString();
}

export function usageUrlForModel(model, env = process.env, explicitUrl) {
	const override = explicitUrl || env?.TSUKUYOMI_STATUS_URL || env?.KAGUYAPI_STATUS_URL;
	if (override) return normalizeUsageUrl(override, true);
	const baseUrl = model?.baseUrl || (String(model?.provider || "").toLowerCase().includes("codex") ? "https://chatgpt.com/backend-api" : undefined);
	return normalizeUsageUrl(baseUrl, false);
}

function normalizeWindow(raw, kind, bucketName, capturedAt) {
	const source = asObject(raw);
	if (!source) return undefined;
	let usedPercent = clampPercent(firstValue(source, ["used_percent", "usedPercent", "percent_used", "percentUsed"]));
	let remainingPercent = clampPercent(firstValue(source, ["remaining_percent", "remainingPercent", "percent_remaining", "percentRemaining"]));
	if (usedPercent == null && remainingPercent != null) usedPercent = 100 - remainingPercent;
	if (remainingPercent == null && usedPercent != null) remainingPercent = 100 - usedPercent;
	if (usedPercent == null && remainingPercent == null) return undefined;

	const windowSeconds = finiteNumber(firstValue(source, [
		"limit_window_seconds", "limitWindowSeconds", "window_seconds", "windowSeconds",
	]));
	const windowMinutes = finiteNumber(firstValue(source, ["window_minutes", "windowMinutes", "window_duration_mins", "windowDurationMins"]));
	const resetRaw = firstValue(source, ["reset_at", "resetAt", "resets_at", "resetsAt"]);
	let resetAt = epochMilliseconds(resetRaw);
	if (resetAt == null) {
		const after = finiteNumber(firstValue(source, ["reset_after_seconds", "resetAfterSeconds", "reset_after", "resetAfter"]));
		if (after != null && after >= 0) resetAt = capturedAt + after * 1_000;
	}
	return {
		kind,
		bucketName: bucketName || "codex",
		usedPercent,
		remainingPercent,
		windowSeconds: windowSeconds != null && windowSeconds > 0 ? windowSeconds : windowMinutes != null && windowMinutes > 0 ? windowMinutes * 60 : undefined,
		resetAt,
	};
}

function appendWindowRows(rows, source, bucketName, capturedAt) {
	const object = asObject(source);
	if (!object) return;
	const rateLimit = asObject(object.rate_limit || object.rateLimit) || object;
	const primary = firstValue(rateLimit, ["primary_window", "primaryWindow", "primary"]);
	const secondary = firstValue(rateLimit, ["secondary_window", "secondaryWindow", "secondary"]);
	const primaryRow = normalizeWindow(primary, "primary", bucketName, capturedAt);
	const secondaryRow = normalizeWindow(secondary, "secondary", bucketName, capturedAt);
	if (primaryRow) rows.push(primaryRow);
	if (secondaryRow) rows.push(secondaryRow);
}

function parseCredits(value) {
	const source = asObject(value);
	if (!source) return undefined;
	const hasCreditsValue = firstValue(source, ["has_credits", "hasCredits", "enabled"]);
	const balance = firstValue(source, ["balance", "remaining", "amount"]);
	if (hasCreditsValue == null && source.unlimited == null && balance == null) return undefined;
	const hasCredits = hasCreditsValue == null ? source.unlimited === true || balance != null : Boolean(hasCreditsValue);
	return {
		hasCredits: hasCredits,
		unlimited: Boolean(firstValue(source, ["unlimited", "is_unlimited", "isUnlimited"])),
		balance: balance == null ? undefined : String(balance),
	};
}

function parseMonthlyLimit(value, capturedAt) {
	const source = asObject(value);
	if (!source) return undefined;
	const nested = asObject(source.individual_limit || source.individualLimit) || source;
	const limit = firstValue(nested, ["limit", "total", "max"]);
	const used = firstValue(nested, ["used", "consumed"]);
	let remainingPercent = clampPercent(firstValue(nested, ["remaining_percent", "remainingPercent", "percent_remaining", "percentRemaining"]));
	const usedPercent = clampPercent(firstValue(nested, ["used_percent", "usedPercent", "percent_used", "percentUsed"]));
	if (remainingPercent == null && usedPercent != null) remainingPercent = 100 - usedPercent;
	if (remainingPercent == null && limit != null && used != null) {
		const total = finiteNumber(limit);
		const consumed = finiteNumber(used);
		if (total != null && total > 0 && consumed != null) remainingPercent = 100 - consumed / total * 100;
	}
	if (limit == null && used == null && remainingPercent == null) return undefined;
	const resetRaw = firstValue(nested, ["reset_at", "resetAt", "resets_at", "resetsAt"]);
	let resetAt = epochMilliseconds(resetRaw);
	if (resetAt == null) {
		const after = finiteNumber(firstValue(nested, ["reset_after_seconds", "resetAfterSeconds", "reset_after", "resetAfter"]));
		if (after != null && after >= 0) resetAt = capturedAt + after * 1_000;
	}
	return {
		remainingPercent: remainingPercent == null ? undefined : Math.max(0, Math.min(100, remainingPercent)),
		used: used == null ? undefined : String(used),
		limit: limit == null ? undefined : String(limit),
		resetAt,
	};
}

/**
 * Normalize the OpenAI/Codex `/wham/usage` response.
 *
 * The backend has added optional fields over time, so this intentionally accepts both the
 * snake_case payload used by Codex and camelCase variants emitted by compatible gateways.
 */
export function parseUsagePayload(payload, capturedAt = Date.now()) {
	const source = asObject(payload) || {};
	const windows = [];
	const primarySource = firstValue(source, ["rate_limit", "rateLimit"]);
	const rateLimitBuckets = firstValue(source, ["rate_limits", "rateLimits"]);
	if (Array.isArray(rateLimitBuckets)) {
		for (const bucket of rateLimitBuckets) {
			const object = asObject(bucket);
			appendWindowRows(windows, object, firstValue(object, ["limit_name", "limitName", "limit_id", "limitId"]) || "codex", capturedAt);
		}
	} else {
		appendWindowRows(windows, primarySource, "codex", capturedAt);
	}
	if (!windows.length) appendWindowRows(windows, source, "codex", capturedAt);

	const additional = firstValue(source, ["additional_rate_limits", "additionalRateLimits"]);
	if (Array.isArray(additional)) {
		for (const bucket of additional) {
			const object = asObject(bucket);
			if (!object) continue;
			const name = firstValue(object, ["limit_name", "limitName", "metered_feature", "meteredFeature", "limit_id", "limitId"]) || "additional";
			appendWindowRows(windows, object, String(name), capturedAt);
		}
	}
	const codeReview = firstValue(source, ["code_review_rate_limit", "codeReviewRateLimit"]);
	if (codeReview) appendWindowRows(windows, codeReview, "code-review", capturedAt);

	const credits = parseCredits(firstValue(source, ["credits", "credit"]));
	const monthly = parseMonthlyLimit(firstValue(source, ["spend_control", "spendControl", "individual_limit", "individualLimit"]), capturedAt);
	const planType = firstValue(source, ["plan_type", "planType", "plan"]);
	return {
		kind: "available",
		planType: planType == null ? undefined : String(planType),
		windows,
		credits,
		monthly,
		ordinaryUsageAllowed: firstValue(source, ["ordinary_usage_allowed", "ordinaryUsageAllowed"]),
		capturedAt,
	};
}

export async function fetchGptUsage({ model, agentDir, env = process.env, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10_000, statusUrl, authStore: providedAuthStore } = {}) {
	const authStore = providedAuthStore || readAuthStore(agentDir || env?.PI_CODING_AGENT_DIR);
	const credential = selectCredential(authStore, model?.provider);
	const capability = classifyGptStatus(model, credential, now());
	if (capability.kind === "unsupported") return { kind: "unsupported", code: capability.code };
	if (capability.kind === "api-key") return { kind: "unsupported", code: "api-key" };
	if (typeof fetchImpl !== "function") return { kind: "error", code: "fetch-unavailable", reason: "fetch is unavailable" };
	const url = usageUrlForModel(model, env, statusUrl);
	if (!url) return { kind: "unsupported", code: "endpoint" };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const headers = {
		Accept: "application/json",
		"Cache-Control": "no-cache, no-store",
		Authorization: `Bearer ${credential.access}`,
		"User-Agent": "Tsukuyomi",
	};
	const accountId = credential.accountId || credential.account_id;
	if (typeof accountId === "string" && accountId.trim()) headers["ChatGPT-Account-Id"] = accountId;
	try {
		const response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
		if (!response?.ok) {
			if (response?.status === 401 || response?.status === 403) return { kind: "error", code: "expired-auth", status: response.status };
			return { kind: "error", code: "http", status: response?.status || 0 };
		}
		let payload;
		try {
			payload = await response.json();
		} catch {
			return { kind: "error", code: "malformed" };
		}
		if (!asObject(payload)) return { kind: "error", code: "malformed" };
		const result = parseUsagePayload(payload, now());
		return { ...result, url };
	} catch (error) {
		if (error?.name === "AbortError") return { kind: "error", code: "timeout" };
		return { kind: "error", code: "network", reason: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}

export class OpenAIUsageClient {
	constructor({ agentDir, env = process.env, fetchImpl = globalThis.fetch, ttlMs = DEFAULT_USAGE_CACHE_TTL_MS, timeoutMs = 10_000, now = Date.now, authStore } = {}) {
		this.agentDir = agentDir || env?.PI_CODING_AGENT_DIR;
		this.env = env;
		this.fetchImpl = fetchImpl;
		this.ttlMs = ttlMs;
		this.timeoutMs = timeoutMs;
		this.now = now;
		this.authStore = authStore;
		this.cache = new Map();
		this.inFlight = new Map();
	}

	get(model, { force = false, statusUrl } = {}) {
		const key = `${model?.provider || ""}/${model?.id || model?.name || ""}`;
		const cached = this.cache.get(key);
		if (!force && cached && this.now() - cached.cachedAt < this.ttlMs) return Promise.resolve({ ...cached.value, cached: true });
		if (!force && this.inFlight.has(key)) return this.inFlight.get(key);
		const request = fetchGptUsage({
			model,
			agentDir: this.agentDir,
			env: this.env,
			fetchImpl: this.fetchImpl,
			now: this.now,
			timeoutMs: this.timeoutMs,
			statusUrl,
			authStore: this.authStore,
		}).then((value) => {
			this.cache.set(key, { value, cachedAt: this.now() });
			return { ...value, cached: false };
		}).finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, request);
		return request;
	}

	clear() {
		this.cache.clear();
	}
}
