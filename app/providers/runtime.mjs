/**
 * Thin, typed wrapper over PI's `ModelRuntime`.
 *
 * PI owns provider definitions, credential resolution, OAuth refresh, and model
 * catalogs. We deliberately do not reimplement any of that: this module only
 * creates one `ModelRuntime` for the agent directory, caches it, and normalizes
 * its errors into {@link TsukuyomiAuthError}. Every method is cancellation-aware
 * and uses a bounded default timeout so a wedged provider cannot freeze the TUI.
 *
 * `login()` goes through PI's provider implementations on purpose: OAuth
 * credentials carry provider-specific fields (for example `openai-codex`
 * stores `accountId`), and PI is the only thing that produces and refreshes
 * them correctly.
 */

import { join } from "node:path";
import { loadPiRuntime } from "../pi-runtime.mjs";
import { AuthErrorCode, authError, toAuthError } from "./errors.mjs";

/** Default bound for runtime operations that touch the network or disk. */
export const DEFAULT_RUNTIME_TIMEOUT_MS = 15_000;

/** Build a timeout signal, or undefined when a caller supplied its own. */
function operationSignal(signal, timeoutMs) {
	if (signal) return signal;
	if (!timeoutMs) return undefined;
	return AbortSignal.timeout(timeoutMs);
}

export class ProviderRuntime {
	/**
	 * @param {{piRoot: string, agentDir: string, timeoutMs?: number, create?: Function}} options
	 *   `create` is an injection point for tests; it defaults to PI's
	 *   `ModelRuntime.create`.
	 */
	constructor({ piRoot, agentDir, timeoutMs = DEFAULT_RUNTIME_TIMEOUT_MS, create } = {}) {
		if (!agentDir) throw new TypeError("ProviderRuntime requires an agent directory");
		this.piRoot = piRoot;
		this.agentDir = agentDir;
		this.timeoutMs = timeoutMs;
		this.create = create;
		this._runtime = undefined;
	}

	/** Paths owned by this runtime, exposed for docs and diagnostics. */
	get paths() {
		return {
			agentDir: this.agentDir,
			auth: join(this.agentDir, "auth.json"),
			models: join(this.agentDir, "models.json"),
			modelsStore: join(this.agentDir, "models-store.json"),
		};
	}

	async runtime() {
		if (this._runtime) return this._runtime;
		const create = this.create ?? (await this.#resolveCreate());
		const created = await create({
			authPath: this.paths.auth,
			modelsPath: this.paths.models,
			modelsStorePath: this.paths.modelsStore,
			refreshOnCreate: false,
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!created) throw authError(AuthErrorCode.PROVIDER, "This PI installation does not expose ModelRuntime.");
		this._runtime = created;
		return created;
	}

	async #resolveCreate() {
		const pi = await loadPiRuntime(this.piRoot);
		const Runtime = pi?.ModelRuntime;
		if (!Runtime?.create) {
			throw authError(
				AuthErrorCode.PROVIDER,
				"This PI installation does not expose ModelRuntime.create; update pi-coding-agent.",
			);
		}
		return Runtime.create.bind(Runtime);
	}

	/** Drop the cached runtime so the next call re-reads auth.json/models.json. */
	invalidate() {
		this._runtime = undefined;
	}

	/** Configured providers with their models, auth methods, and status. */
	async providers() {
		const runtime = await this.runtime();
		const configured = runtime.getProviders() || [];
		const available = runtime.getAvailableSnapshot() || [];
		const registered = new Set(runtime.getRegisteredProviderIds?.() || []);
		return configured.map((provider) => ({
			id: provider.id,
			name: provider.name || provider.id,
			models: available.filter((model) => model.provider === provider.id),
			auth: provider.auth,
			status: safeStatus(runtime, provider.id),
			custom: registered.has(provider.id),
		}));
	}

	async provider(id) {
		return (await this.providers()).find((item) => item.id === id);
	}

	/** Available (authenticated) models for a provider, or all models when omitted. */
	async models(providerId, { signal } = {}) {
		const runtime = await this.runtime();
		return (await runtime.getAvailable(providerId, { signal: operationSignal(signal, this.timeoutMs) })) || [];
	}

	/** PI's authoritative auth status (`{configured, source?, label?}`). */
	authStatus(providerId) {
		const runtime = this._runtime;
		if (!runtime) return undefined;
		return safeStatus(runtime, providerId);
	}

	async checkAuth(providerId, { signal } = {}) {
		const runtime = await this.runtime();
		return runtime.checkAuth(providerId, { signal: operationSignal(signal, this.timeoutMs) });
	}

	async listCredentials({ signal } = {}) {
		const runtime = await this.runtime();
		return runtime.listCredentials({ signal: operationSignal(signal, this.timeoutMs) });
	}

	/**
	 * Run a provider's own login flow (api key or OAuth).
	 *
	 * Throws a typed error. A `SYNC` error means the credential was committed
	 * but the availability snapshot could not be rebuilt; callers should treat
	 * it as a warning and restart the kernel. `error.credentialCommitted` marks
	 * that case explicitly.
	 */
	async login(providerId, type, interaction) {
		const runtime = await this.runtime();
		try {
			return await runtime.login(providerId, type, interaction);
		} catch (error) {
			if (error?.name === "CredentialSynchronizationError" && error.operation === "login") {
				const normalized = toAuthError(error, { providerId, fallbackCode: AuthErrorCode.SYNC });
				normalized.credentialCommitted = true;
				throw normalized;
			}
			throw toAuthError(error, { providerId });
		}
	}

	/** Store an API key using PI's api-key login flow (no prompt shown). */
	async saveApiKey(providerId, key, { signal } = {}) {
		if (!key?.trim()) throw authError(AuthErrorCode.CONFIG, "API key is required.", { providerId });
		return this.login(providerId, "api_key", {
			signal: operationSignal(signal, this.timeoutMs),
			prompt: async () => key,
			notify() {},
		});
	}

	async logout(providerId, { signal } = {}) {
		const runtime = await this.runtime();
		try {
			return await runtime.logout(providerId, { signal: operationSignal(signal, this.timeoutMs) });
		} catch (error) {
			throw toAuthError(error, { providerId });
		}
	}

	/** Resolve request auth for a model (used by quota lookups). */
	async getAuth(model, { signal } = {}) {
		const runtime = await this.runtime();
		return runtime.getAuth(model, { signal: operationSignal(signal, this.timeoutMs) });
	}

	async setRuntimeApiKey(providerId, key, { signal } = {}) {
		const runtime = await this.runtime();
		return runtime.setRuntimeApiKey(providerId, key, { signal: operationSignal(signal, this.timeoutMs) });
	}

	async removeRuntimeApiKey(providerId, { signal } = {}) {
		const runtime = await this.runtime();
		return runtime.removeRuntimeApiKey(providerId, { signal: operationSignal(signal, this.timeoutMs) });
	}

	async refresh({ providers, signal } = {}) {
		const runtime = await this.runtime();
		return runtime.refresh?.({ providers, signal: operationSignal(signal, this.timeoutMs) });
	}

	/** Register a runtime-only provider config (custom provider not in models.json). */
	async registerProvider(providerId, config) {
		const runtime = await this.runtime();
		runtime.registerProvider(providerId, config);
		await this.refresh({ providers: [providerId] });
	}

	async unregisterProvider(providerId) {
		const runtime = await this.runtime();
		runtime.unregisterProvider(providerId);
	}

	// --- Backward-compatible aliases for existing callers -------------------
	// The previous provider-runtime.mjs exposed these names; keeping them lets
	// the TUI migrate method by method instead of in one risky rewrite.

	/** @deprecated use {@link providers} */
	getProviders() {
		return this.providers();
	}

	/** @deprecated use {@link authStatus} */
	getProviderAuthStatus(providerId) {
		return this.authStatus(providerId);
	}

	/** @deprecated use {@link models} */
	getModels(providerId, options) {
		return this.models(providerId, options);
	}
}

/** Best-effort status read; PI may not implement it on older builds. */
function safeStatus(runtime, providerId) {
	try {
		return runtime.getProviderAuthStatus?.(providerId);
	} catch {
		return undefined;
	}
}

/** Convenience factory mirroring the rest of the app's `create*` helpers. */
export function createProviderRuntime(options) {
	return new ProviderRuntime(options);
}
