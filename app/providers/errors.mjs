/**
 * Typed errors for the provider/auth subsystem.
 *
 * PI surfaces failures as `ModelsError` (code: "auth" | "oauth" | "provider" |
 * "model_source" | "stream"), as `CredentialSynchronizationError`, or as plain
 * DOMException/AbortError. The UI should not switch on those shapes directly;
 * `categorize()` maps everything to a small, stable set of codes so dialogs can
 * render the right message and decide whether a retry is meaningful.
 */

/** Stable error codes used across the provider subsystem. */
export const AuthErrorCode = Object.freeze({
	/** The user aborted, or a per-prompt/callback signal won the race. */
	CANCELLED: "cancelled",
	/** Credential is missing/invalid, or a stored key could not be resolved. */
	AUTH: "auth",
	/** OAuth token refresh failed; the credential was preserved for re-login. */
	OAUTH_REFRESH: "oauth_refresh",
	/** Network/DNS/TLS/timeout failure while talking to the provider. */
	NETWORK: "network",
	/** Provider configuration is structurally invalid (id/url/api/models). */
	CONFIG: "config",
	/** Unknown provider id, or the provider exposes no usable auth method. */
	PROVIDER: "provider",
	/** Reading/writing the credential store failed. */
	STORE: "store",
	/** The credential was written but the runtime snapshot could not be synced. */
	SYNC: "sync",
	/** Model discovery from the provider's `/models` endpoint failed. */
	DISCOVERY: "discovery",
	/** Anything we could not classify. */
	UNKNOWN: "unknown",
});

/** Error codes that are worth retrying without changing user input. */
const RETRYABLE = new Set([
	AuthErrorCode.NETWORK,
	AuthErrorCode.OAUTH_REFRESH,
	AuthErrorCode.SYNC,
]);

/** Error codes that mean "nothing to show but cancelled" to the UI. */
const SILENT = new Set([AuthErrorCode.CANCELLED]);

/**
 * Error type used by every module in `app/providers`.
 *
 * @property {string} code one of {@link AuthErrorCode}
 * @property {string|undefined} providerId provider the failure belongs to
 * @property {boolean} retryable whether an unmodified retry may succeed
 */
export class TsukuyomiAuthError extends Error {
	constructor(code, message, { cause, providerId, retryable } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "TsukuyomiAuthError";
		this.code = code;
		this.providerId = providerId;
		this.retryable = retryable ?? RETRYABLE.has(code);
	}

	/** True when the flow was cancelled rather than failed. */
	get cancelled() {
		return this.code === AuthErrorCode.CANCELLED;
	}

	/** True when the UI should stay quiet (cancellation, benign aborts). */
	get silent() {
		return SILENT.has(this.code);
	}
}

/** Build a {@link TsukuyomiAuthError}. */
export function authError(code, message, options) {
	return new TsukuyomiAuthError(code, message, options);
}

/** True for any abort-shaped throwable (DOMException AbortError or reason()). */
export function isAbortError(error) {
	if (!error) return false;
	if (error.name === "AbortError" || error.name === "TimeoutError") return true;
	if (error instanceof TsukuyomiAuthError) return error.cancelled;
	return /abort/i.test(String(error.message || error));
}

/** Throw a cancellation error if `signal` is aborted. */
export function throwIfAborted(signal, message = "Cancelled") {
	if (signal?.aborted) throw authError(AuthErrorCode.CANCELLED, message, { cause: signal.reason });
}

/**
 * Map an arbitrary throwable to a stable {@link AuthErrorCode}.
 *
 * Order matters: an abort inside a network call is a cancellation, not a
 * network failure, and `CredentialSynchronizationError` is a sync problem even
 * though the credential itself was persisted.
 */
export function categorize(error) {
	if (error instanceof TsukuyomiAuthError) return error.code;
	if (isAbortError(error)) return AuthErrorCode.CANCELLED;
	const name = error?.name;
	const piCode = error?.code;
	const text = String(error?.message || error || "");
	if (name === "CredentialSynchronizationError") return AuthErrorCode.SYNC;
	// PI's ModelsError carries a numeric-ish string code.
	if (piCode === "oauth") return AuthErrorCode.OAUTH_REFRESH;
	if (piCode === "auth") return AuthErrorCode.AUTH;
	if (piCode === "provider") return AuthErrorCode.PROVIDER;
	if (piCode === "model_source") return AuthErrorCode.NETWORK;
	if (name === "TypeError" && /fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONN|socket/i.test(text)) return AuthErrorCode.NETWORK;
	if (/timed? ?out|timeout/i.test(name || "") || /timed? ?out|timeout/i.test(text)) return AuthErrorCode.NETWORK;
	if (/ENOENT|EACCES|ELOCKED|auth\.json|credential store/i.test(text)) return AuthErrorCode.STORE;
	if (/invalid|must |required|schema|models\.json|providers\.json/i.test(text)) return AuthErrorCode.CONFIG;
	if (/unknown provider|does not support .* login|no authentication method/i.test(text)) return AuthErrorCode.PROVIDER;
	return AuthErrorCode.UNKNOWN;
}

/**
 * Wrap an arbitrary throwable as a {@link TsukuyomiAuthError}, preserving the
 * original message and cause and attaching the provider id when known.
 */
export function toAuthError(error, { providerId, fallbackCode } = {}) {
	if (error instanceof TsukuyomiAuthError) {
		if (providerId && !error.providerId) error.providerId = providerId;
		return error;
	}
	const code = fallbackCode ?? categorize(error);
	const message = error instanceof Error ? error.message : String(error);
	return new TsukuyomiAuthError(code, message || code, { cause: error, providerId });
}

/**
 * Human-readable label for a code. Kept here (not in i18n) so non-TUI callers
 * and logs get something sensible; the TUI layers its own translations on top.
 */
export const ERROR_LABELS = Object.freeze({
	[AuthErrorCode.CANCELLED]: "Cancelled",
	[AuthErrorCode.AUTH]: "Authentication failed",
	[AuthErrorCode.OAUTH_REFRESH]: "Sign-in expired, please sign in again",
	[AuthErrorCode.NETWORK]: "Network error",
	[AuthErrorCode.CONFIG]: "Invalid provider configuration",
	[AuthErrorCode.PROVIDER]: "Provider is not available",
	[AuthErrorCode.STORE]: "Credential store error",
	[AuthErrorCode.SYNC]: "Signed in, but the kernel could not reload",
	[AuthErrorCode.DISCOVERY]: "Model discovery failed",
	[AuthErrorCode.UNKNOWN]: "Sign-in failed",
});

/** Default label for a normalized error. */
export function describeAuthError(error) {
	const normalized = toAuthError(error);
	return ERROR_LABELS[normalized.code] ?? ERROR_LABELS[AuthErrorCode.UNKNOWN];
}
