import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTH_PHASE, createAuthInteraction, createAuthState, isTerminalPhase, reduceAuth, runAuthFlow } from "../../app/providers/auth-flow.mjs";
import { AuthErrorCode, TsukuyomiAuthError } from "../../app/providers/errors.mjs";

function abortError() {
	const error = new Error("aborted");
	error.name = "AbortError";
	return error;
}

test("reducer walks the full happy path", () => {
	let state = createAuthState();
	state = reduceAuth(state, { type: "start", providerId: "anthropic", providerName: "Anthropic" });
	assert.equal(state.phase, AUTH_PHASE.PROVIDER);
	state = reduceAuth(state, { type: "method", authType: "oauth" });
	assert.equal(state.phase, AUTH_PHASE.METHOD);
	state = reduceAuth(state, { type: "waiting" });
	assert.equal(state.phase, AUTH_PHASE.WAITING);
	state = reduceAuth(state, { type: "notify", event: { type: "auth_url", url: "https://auth" } });
	assert.equal(state.challenge.url, "https://auth");
	state = reduceAuth(state, { type: "prompt", prompt: { type: "secret", message: "key" } });
	assert.equal(state.phase, AUTH_PHASE.PROMPTING);
	state = reduceAuth(state, { type: "answer", value: "sk" });
	assert.equal(state.answered, 1);
	state = reduceAuth(state, { type: "success" });
	assert.equal(state.phase, AUTH_PHASE.SUCCEEDED);
	assert.ok(isTerminalPhase(state.phase));
});

test("reducer records device-code challenges", () => {
	let state = reduceAuth(createAuthState(), { type: "start", providerId: "github-copilot" });
	state = reduceAuth(state, { type: "notify", event: { type: "device_code", userCode: "ABCD", verificationUri: "https://gh/device", intervalSeconds: 5 } });
	assert.deepEqual(state.challenge, { kind: "device_code", url: "https://gh/device", code: "ABCD", intervalSeconds: 5, expiresInSeconds: undefined });
});

test("reducer ignores events after a terminal phase", () => {
	let state = reduceAuth(createAuthState(), { type: "start", providerId: "x" });
	state = reduceAuth(state, { type: "cancel" });
	assert.equal(state.phase, AUTH_PHASE.CANCELLED);
	const again = reduceAuth(state, { type: "notify", event: { type: "progress", message: "late" } });
	assert.equal(again, state);
});

test("reducer normalizes cancellations and failures", () => {
	const started = reduceAuth(createAuthState(), { type: "start", providerId: "x" });
	const cancelled = reduceAuth(started, { type: "fail", error: abortError() });
	assert.equal(cancelled.phase, AUTH_PHASE.CANCELLED);
	assert.equal(cancelled.error, undefined);

	const failed = reduceAuth(started, { type: "fail", error: new Error("boom") });
	assert.equal(failed.phase, AUTH_PHASE.FAILED);
	assert.equal(failed.error.code, AuthErrorCode.UNKNOWN);
});

test("createAuthInteraction masks secret prompts and combines signals", async () => {
	const seen = [];
	const interaction = createAuthInteraction(
		{
			prompt: async (prompt) => {
				seen.push(prompt);
				return "value";
			},
			notify: () => {},
		},
		undefined,
	);
	const value = await interaction.prompt({ type: "secret", message: "Enter key" });
	assert.equal(value, "value");
	assert.equal(seen[0].secret, true);
	const text = await interaction.prompt({ type: "text", message: "Enter name" });
	assert.equal(text, "value");
	assert.equal(seen[1].secret, false);
});

test("runAuthFlow succeeds without prompting when the provider does not ask", async () => {
	const result = await runAuthFlow({
		providerId: "openrouter",
		method: "api_key",
		login: async () => ({ type: "api_key", key: "sk" }),
		ui: { prompt: async () => "unused", notify: () => {} },
	});
	assert.equal(result.ok, true);
	assert.equal(result.state.phase, AUTH_PHASE.SUCCEEDED);
	assert.equal(result.credential.key, "sk");
});

test("runAuthFlow forwards prompts and notifications", async () => {
	const events = [];
	const prompts = [];
	const result = await runAuthFlow({
		providerId: "custom",
		method: "api_key",
		login: async (_id, _type, interaction) => {
			interaction.notify({ type: "progress", message: "working" });
			const key = await interaction.prompt({ type: "secret", message: "Key" });
			return { type: "api_key", key };
		},
		ui: {
			prompt: async (prompt) => {
				prompts.push(prompt.message);
				return "sk-123";
			},
			notify: (event) => events.push(event.type),
		},
	});
	assert.equal(result.ok, true);
	assert.deepEqual(prompts, ["Key"]);
	assert.deepEqual(events, ["progress"]);
	assert.equal(result.credential.key, "sk-123");
	// onChange observed the prompting phase.
});

test("runAuthFlow reports cancellation without an error toast", async () => {
	const result = await runAuthFlow({
		providerId: "custom",
		method: "api_key",
		login: async (_id, _type, interaction) => interaction.prompt({ type: "secret", message: "Key" }),
		ui: { prompt: async () => { throw abortError(); }, notify: () => {} },
	});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, AuthErrorCode.CANCELLED);
	assert.equal(result.error.silent, true);
	assert.equal(result.state.phase, AUTH_PHASE.CANCELLED);
});

test("runAuthFlow surfaces provider failures", async () => {
	const result = await runAuthFlow({
		providerId: "custom",
		method: "api_key",
		login: async () => { throw new Error("unknown provider: custom"); },
		ui: { prompt: async () => "", notify: () => {} },
	});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, AuthErrorCode.PROVIDER);
	assert.equal(result.state.phase, AUTH_PHASE.FAILED);
});

test("runAuthFlow treats a credential-sync failure as success with a warning", async () => {
	const syncError = new Error("snapshot failed");
	syncError.name = "CredentialSynchronizationError";
	syncError.operation = "login";
	const result = await runAuthFlow({
		providerId: "custom",
		method: "api_key",
		login: async () => { throw syncError; },
		ui: { prompt: async () => "", notify: () => {} },
	});
	assert.equal(result.ok, true);
	assert.equal(result.state.phase, AUTH_PHASE.SUCCEEDED);
	assert.equal(result.warning.code, AuthErrorCode.SYNC);
});

test("runAuthFlow emits reducer state changes through onChange", async () => {
	const phases = [];
	await runAuthFlow({
		providerId: "custom",
		method: "api_key",
		login: async (_id, _type, interaction) => {
			await interaction.prompt({ type: "secret", message: "Key" });
			return { type: "api_key", key: "sk" };
		},
		ui: { prompt: async () => "sk", notify: () => {} },
		onChange: (state) => phases.push(state.phase),
	});
	assert.ok(phases.includes(AUTH_PHASE.PROMPTING));
	assert.equal(phases.at(-1), AUTH_PHASE.SUCCEEDED);
});

test("TsukuyomiAuthError carries code and retryability", () => {
	const error = new TsukuyomiAuthError(AuthErrorCode.NETWORK, "offline");
	assert.equal(error.retryable, true);
	assert.equal(error.cancelled, false);
	assert.equal(new TsukuyomiAuthError(AuthErrorCode.CONFIG, "bad").retryable, false);
});
