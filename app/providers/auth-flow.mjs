/**
 * Provider sign-in orchestration: a pure state reducer, a PI `AuthInteraction`
 * adapter, and `runAuthFlow()` which ties them to a login call.
 *
 * The reducer is intentionally UI-free and side-effect-free so cancellation and
 * failure are deterministic and unit-testable. The TUI only maps `state.phase`
 * and `state.prompt` to widgets; it never decides flow transitions itself.
 *
 * PI's contract (pi-ai `auth/types.d.ts`):
 *   AuthInteraction = { signal, prompt(AuthPrompt) => Promise<string>, notify(AuthEvent) => void }
 *   AuthPrompt      = text | secret | select | manual_code (+ optional signal)
 *   AuthEvent       = info | auth_url | device_code | progress
 * `runAuthFlow` is provider-agnostic: `login()` is injected (normally
 * `runtime.login(providerId, authType, interaction)`).
 */

import { AuthErrorCode, authError, toAuthError, isAbortError } from "./errors.mjs";

/** Discrete phases of a sign-in flow. */
export const AUTH_PHASE = Object.freeze({
	IDLE: "idle",
	/** A provider was picked; a sign-in method may need choosing. */
	PROVIDER: "provider",
	/** The api-key/OAuth method was chosen. */
	METHOD: "method",
	/** A prompt is outstanding; the next user input answers it. */
	PROMPTING: "prompting",
	/** No prompt outstanding; network/poll work is in flight. */
	WAITING: "waiting",
	SUCCEEDED: "succeeded",
	CANCELLED: "cancelled",
	FAILED: "failed",
});

const TERMINAL = new Set([AUTH_PHASE.SUCCEEDED, AUTH_PHASE.CANCELLED, AUTH_PHASE.FAILED]);

/** True once the flow has reached a terminal phase. */
export function isTerminalPhase(phase) {
	return TERMINAL.has(phase);
}

/** Prompt kinds that must not be echoed to the transcript. */
export function isSecretPrompt(prompt) {
	return prompt?.type === "secret" || prompt?.type === "manual_code";
}

/** Fresh reducer state. */
export function createAuthState(overrides = {}) {
	return {
		phase: AUTH_PHASE.IDLE,
		providerId: undefined,
		providerName: undefined,
		/** "api_key" | "oauth" | undefined */
		method: undefined,
		/** Current AuthPrompt awaiting an answer, if any. */
		prompt: undefined,
		/** Prompts answered so far (count only; values may be secret). */
		answered: 0,
		/** AuthEvent[] in arrival order (auth_url/device_code/progress/info). */
		events: [],
		/** Latest auth_url/device_code pair, kept for redraws. */
		challenge: undefined,
		/** Number of start attempts (retry support). */
		attempts: 0,
		/** Normalized failure, if phase === failed. */
		error: undefined,
		...overrides,
	};
}

/** The most recent challenge advertised by the flow, if any. */
function challengeFrom(state, event) {
	if (event.type === "auth_url") return { kind: "auth_url", url: event.url, instructions: event.instructions };
	if (event.type === "device_code") {
		return {
			kind: "device_code",
			url: event.verificationUri,
			code: event.userCode,
			intervalSeconds: event.intervalSeconds,
			expiresInSeconds: event.expiresInSeconds,
		};
	}
	return state.challenge;
}

/**
 * Pure reducer. Every transition is total: unknown/irrelevant events return the
 * previous state unchanged, so late async deliveries cannot corrupt the flow.
 *
 * @param {ReturnType<typeof createAuthState>} state
 * @param {{type: string}} event
 */
export function reduceAuth(state, event) {
	const current = state ?? createAuthState();
	switch (event.type) {
		case "start":
			return {
				...createAuthState(),
				phase: AUTH_PHASE.PROVIDER,
				providerId: event.providerId,
				providerName: event.providerName ?? event.providerId,
				attempts: current.attempts + 1,
			};
		case "method":
			if (isTerminalPhase(current.phase)) return current;
			return { ...current, phase: AUTH_PHASE.METHOD, method: event.authType, error: undefined };
		case "prompt":
			if (isTerminalPhase(current.phase)) return current;
			return { ...current, phase: AUTH_PHASE.PROMPTING, prompt: event.prompt };
		case "answer":
			if (isTerminalPhase(current.phase)) return current;
			return { ...current, phase: AUTH_PHASE.WAITING, prompt: undefined, answered: current.answered + 1 };
		case "waiting":
			if (isTerminalPhase(current.phase)) return current;
			if (current.phase === AUTH_PHASE.WAITING && !current.prompt) return current;
			return { ...current, phase: AUTH_PHASE.WAITING, prompt: undefined };
		case "notify": {
			if (isTerminalPhase(current.phase)) return current;
			const events = [...current.events, event.event];
			return { ...current, events, challenge: challengeFrom(current, event.event) };
		}
		case "success":
			return { ...current, phase: AUTH_PHASE.SUCCEEDED, prompt: undefined, error: undefined };
		case "cancel":
			if (isTerminalPhase(current.phase)) return current;
			return { ...current, phase: AUTH_PHASE.CANCELLED, prompt: undefined };
		case "fail": {
			const error = toAuthError(event.error, { providerId: current.providerId });
			if (error.cancelled) return { ...current, phase: AUTH_PHASE.CANCELLED, prompt: undefined };
			return { ...current, phase: AUTH_PHASE.FAILED, prompt: undefined, error };
		}
		case "reset":
			return createAuthState({ attempts: current.attempts });
		default:
			return current;
	}
}

/**
 * Adapt a minimal UI to PI's `AuthInteraction`.
 *
 * @param {{prompt: (prompt: object, options: {signal: AbortSignal|undefined}) => Promise<string>,
 *          notify: (event: object) => void}} ui
 * @param {AbortSignal|undefined} signal whole-flow cancellation
 */
export function createAuthInteraction(ui, signal) {
	if (typeof ui?.prompt !== "function") throw new TypeError("createAuthInteraction requires ui.prompt()");
	if (typeof ui?.notify !== "function") throw new TypeError("createAuthInteraction requires ui.notify()");
	return {
		signal,
		prompt: async (request) => {
			const signals = [signal, request?.signal].filter(Boolean);
			const combined = signals.length ? AbortSignal.any(signals) : undefined;
			combined?.throwIfAborted();
			const value = await ui.prompt(
				{ ...request, signal: combined, secret: isSecretPrompt(request) },
				{ signal: combined },
			);
			return value;
		},
		notify: (event) => {
			if (signal?.aborted) return;
			ui.notify(event);
		},
	};
}

/**
 * Run one sign-in flow end to end.
 *
 * @param {object} input
 * @param {(providerId: string, authType: string, interaction: object) => Promise<object>} input.login
 *        normally `runtime.login`; the returned credential is surfaced as-is.
 * @param {{prompt: Function, notify: Function}} input.ui
 * @param {string} [input.providerId]
 * @param {string} [input.providerName]
 * @param {"api_key"|"oauth"} [input.method] skip the method-choice phase when known
 * @param {AbortSignal} [input.signal]
 * @param {(state: object) => void} [input.onChange] called on every transition
 * @returns {Promise<{ok: boolean, state: object, credential?: object, error?: Error}>}
 */
export async function runAuthFlow({
	login,
	ui,
	providerId,
	providerName,
	method,
	signal,
	onChange,
}) {
	if (typeof login !== "function") throw new TypeError("runAuthFlow requires login()");

	let state = reduceAuth(createAuthState(), { type: "start", providerId, providerName });
	const dispatch = (event) => {
		const next = reduceAuth(state, event);
		if (next !== state) {
			state = next;
			onChange?.(state);
		}
		return state;
	};
	dispatch({ type: "method", authType: method });
	if (method === "oauth" || method === "api_key") dispatch({ type: "waiting" });

	const interaction = createAuthInteraction(
		{
			prompt: async (request) => {
				dispatch({ type: "prompt", prompt: request });
				try {
					const value = await ui.prompt(request, { signal: request.signal });
					dispatch({ type: "answer", value });
					dispatch({ type: "waiting" });
					return value;
				} catch (error) {
					if (isAbortError(error) || request.signal?.aborted) {
						throw authError(AuthErrorCode.CANCELLED, "Cancelled", { cause: error, providerId });
					}
					throw error;
				}
			},
			notify: (event) => {
				dispatch({ type: "notify", event });
				ui.notify(event);
			},
		},
		signal,
	);

	try {
		const credential = await login(providerId, method, interaction);
		dispatch({ type: "success", credential });
		return { ok: true, state, credential };
	} catch (error) {
		const normalized = toAuthError(error, { providerId });
		// A synchronization failure means the credential was committed but the
		// kernel snapshot could not be rebuilt. That is a warning, not a failed
		// sign-in: the caller should restart the kernel and keep going.
		if (normalized.code === AuthErrorCode.SYNC) {
			dispatch({ type: "success" });
			return { ok: true, state, warning: normalized };
		}
		dispatch({ type: normalized.cancelled ? "cancel" : "fail", error: normalized });
		return { ok: false, state, error: normalized };
	}
}
