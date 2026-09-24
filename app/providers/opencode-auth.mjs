import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseJsonc } from "./config/jsonc.mjs";
import { normalizeProvider, saveProviderConfig } from "./config/opencode.mjs";
import { syncProviderToModelsJson } from "./config/sync.mjs";
import { syncExternalAccount } from "./accounts.mjs";
import { isCredential, readAuthStore, writeAuthStore } from "./store.mjs";

const OPENAI_OAUTH_PROVIDER = "openai-codex";
const fileExists = (path) => typeof path === "string" && path.length > 0 && existsSync(path);
const shortHash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);

function unique(paths) {
	return [...new Set(paths.filter((path) => typeof path === "string" && path.length > 0).map((path) => resolve(path)))];
}

/** Standard and Flatpak OpenCode credential locations, most specific first. */
export function openCodeAuthCandidates({ env = process.env, home = homedir() } = {}) {
	const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
	return unique([
		env.OPENCODE_AUTH_FILE,
		join(dataHome, "opencode", "auth.json"),
		join(home, ".local", "share", "opencode", "auth.json"),
		join(home, ".var", "app", "ai.opencode.opencode", "data", "opencode", "auth.json"),
	]);
}

export function findOpenCodeAuth(options = {}) {
	return openCodeAuthCandidates(options).find(fileExists);
}

/** Standard and Flatpak OpenCode config locations. */
export function openCodeConfigCandidates({ env = process.env, home = homedir() } = {}) {
	const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
	return unique([
		env.OPENCODE_CONFIG,
		env.OPENCODE_CONFIG_FILE,
		join(configHome, "opencode", "opencode.jsonc"),
		join(configHome, "opencode", "opencode.json"),
		join(home, ".var", "app", "ai.opencode.opencode", "config", "opencode", "opencode.jsonc"),
		join(home, ".var", "app", "ai.opencode.opencode", "config", "opencode", "opencode.json"),
	]);
}

export function findOpenCodeConfig(options = {}) {
	return openCodeConfigCandidates(options).find(fileExists);
}

function readObject(path) {
	if (!path || !fileExists(path)) return undefined;
	const value = parseJsonc(readFileSync(path, "utf8"));
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** Convert one OpenCode auth entry to the PI-compatible Tsukuyomi shape. */
export function normalizeOpenCodeCredential(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	if (value.type === "api" || value.type === "api_key") {
		if (typeof value.key !== "string" || !value.key) return undefined;
		return { type: "api_key", key: value.key, ...(value.env && typeof value.env === "object" ? { env: value.env } : {}) };
	}
	if (value.type === "oauth" && typeof value.access === "string" && typeof value.refresh === "string" && Number.isFinite(value.expires)) {
		return { ...value, type: "oauth", expires: Number(value.expires) };
	}
	return undefined;
}

export function targetProviderId(sourceProvider, credential) {
	return sourceProvider === "openai" && credential.type === "oauth" ? OPENAI_OAUTH_PROVIDER : sourceProvider;
}

function accountId(sourceProvider, targetProvider, credential) {
	if (credential.type === "oauth" && credential.accountId) return `opencode-${String(credential.accountId)}`;
	return `opencode-${targetProvider}-${shortHash(sourceProvider)}`;
}

function accountName(sourceProvider, targetProvider, credential) {
	if (credential.type === "oauth" && credential.accountId) return `OpenCode · ${sourceProvider} · ${String(credential.accountId).slice(0, 8)}`;
	return `OpenCode · ${targetProvider}`;
}

/**
 * Import every credential currently stored by OpenCode without modifying the
 * source. OpenCode's active credential wins for a matching provider because
 * this operation is an explicit migration from that runtime.
 */
export function migrateOpenCodeAuth({ sourcePath, configPath, targetDir, env = process.env, home = homedir(), overwrite = true, dryRun = false } = {}) {
	const source = sourcePath || findOpenCodeAuth({ env, home });
	if (!source) throw new Error("Could not find OpenCode auth.json");
	const sourceStore = readObject(source);
	if (!sourceStore) throw new Error(`Invalid OpenCode auth.json: ${source}`);
	const current = readAuthStore(targetDir);
	const next = { ...current };
	const report = { source, config: configPath || findOpenCodeConfig({ env, home }), imported: [], overwritten: [], skipped: [], invalid: [], accounts: [], configs: [], dryRun };
	const converted = [];

	for (const [sourceProvider, value] of Object.entries(sourceStore)) {
		const credential = normalizeOpenCodeCredential(value);
		if (!credential || !isCredential(credential)) {
			report.invalid.push(sourceProvider);
			continue;
		}
		const provider = targetProviderId(sourceProvider, credential);
		if (provider in next && !overwrite) {
			report.skipped.push(provider);
			continue;
		}
		if (provider in next) report.overwritten.push(provider);
		else report.imported.push(provider);
		next[provider] = credential;
		converted.push({ sourceProvider, provider, credential });
	}

	if (!dryRun && converted.length > 0) writeAuthStore(targetDir, next);
	if (!dryRun) {
		for (const item of converted) {
			const id = accountId(item.sourceProvider, item.provider, item.credential);
			syncExternalAccount(targetDir, item.provider, id, item.credential, {
				name: accountName(item.sourceProvider, item.provider, item.credential),
				marker: "opencodeAccountId",
			});
			report.accounts.push({ provider: item.provider, id });
		}
	}

	const config = readObject(report.config);
	const configuredProviders = config?.provider && typeof config.provider === "object" ? config.provider : {};
	for (const item of converted) {
		const providerConfig = configuredProviders[item.sourceProvider] || configuredProviders[item.provider];
		if (!providerConfig) continue;
		if (dryRun) {
			report.configs.push(item.provider);
			continue;
		}
		const normalized = normalizeProvider(item.provider, providerConfig);
		saveProviderConfig(targetDir, item.provider, normalized);
		syncProviderToModelsJson(targetDir, item.provider, normalized);
		report.configs.push(item.provider);
	}
	return report;
}
