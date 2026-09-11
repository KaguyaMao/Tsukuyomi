/**
 * File-level view of the credential store (`<agentDir>/auth.json`).
 *
 * PI's `ModelRuntime` is the authority for sign-in and auth *resolution*; this
 * module is for the cases PI does not cover: reading/listing credentials for
 * status and quota, importing from another agent directory (PI or a previous
 * Tsukuyomi install), exporting a redacted summary, and atomic writes used by
 * migration and the CLI.
 *
 * Schema (identical to PI's, so the kernel reads what we write):
 *   { [providerId]:
 *       { type: "api_key", key?: string, env?: Record<string,string> }
 *     | { type: "oauth", access: string, refresh: string, expires: number, ...extras } }
 *
 * Credentials are never symlinked. The old bootstrap symlinked/copied
 * `~/.pi/agent/auth.json`, which could silently diverge; import is copy-once
 * instead, and this file is the single owner.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AuthErrorCode, authError } from "./errors.mjs";

/** POSIX mode for auth.json: owner read/write only. */
export const AUTH_FILE_MODE = 0o600;

/** Path of the credential file inside an agent directory. */
export function authFilePath(agentDir) {
	if (!agentDir) throw new TypeError("authFilePath requires an agent directory");
	return join(agentDir, "auth.json");
}

function readJsonFile(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw authError(AuthErrorCode.STORE, `Failed to read ${path}: ${error.message}`, { cause: error });
	}
}

/** Atomic, permission-tightening JSON write. */
function writeJsonAtomic(path, value) {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: AUTH_FILE_MODE });
	try {
		chmodSync(temp, AUTH_FILE_MODE);
	} catch {
		// best effort on filesystems without POSIX modes
	}
	renameSync(temp, path);
	return value;
}

/** True when a value looks like a credential PI can consume. */
export function isCredential(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (value.type === "api_key") {
		const keyOk = value.key === undefined || typeof value.key === "string";
		const envOk =
			value.env === undefined ||
			(typeof value.env === "object" && value.env !== null && !Array.isArray(value.env) &&
				Object.values(value.env).every((entry) => typeof entry === "string"));
		return keyOk && envOk;
	}
	if (value.type === "oauth") {
		return (
			typeof value.access === "string" &&
			typeof value.refresh === "string" &&
			typeof value.expires === "number" &&
			Number.isFinite(value.expires)
		);
	}
	return false;
}

/** Read the whole store; `{}` when the file is missing. Never throws on absent file. */
export function readAuthStore(agentDir) {
	const data = readJsonFile(authFilePath(agentDir));
	if (data === undefined) return {};
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw authError(AuthErrorCode.STORE, "Invalid auth.json: expected an object");
	}
	return data;
}

/**
 * Display-safe read: any failure (missing, unreadable, malformed) yields `{}`.
 * Use this from status/quota UI so a broken credential file cannot crash the TUI.
 */
export function safeReadAuthStore(agentDir) {
	try {
		return readAuthStore(agentDir);
	} catch {
		return {};
	}
}

/** `{providerId, type}[]` without exposing secrets. */
export function listStoredCredentials(agentDir) {
	return Object.entries(readAuthStore(agentDir))
		.filter(([, credential]) => isCredential(credential))
		.map(([providerId, credential]) => ({ providerId, type: credential.type }));
}

/** One stored credential, or undefined. */
export function getStoredCredential(agentDir, providerId) {
	const credential = readAuthStore(agentDir)[providerId];
	return isCredential(credential) ? credential : undefined;
}

/**
 * Validate an OAuth credential's lifetime.
 * @returns {{valid: boolean, expired: boolean, expires?: number}}
 */
export function credentialLifetime(credential, now = Date.now()) {
	if (credential?.type !== "oauth") return { valid: credential !== undefined, expired: false };
	const expires = credential.expires;
	if (!Number.isFinite(expires)) return { valid: true, expired: false };
	return { valid: true, expired: expires <= now, expires };
}

/** Write one credential, preserving the rest of the store. */
export function writeStoredCredential(agentDir, providerId, credential) {
	if (!isCredential(credential)) {
		throw authError(AuthErrorCode.CONFIG, `Invalid credential for provider "${providerId}"`);
	}
	const store = readAuthStore(agentDir);
	return writeJsonAtomic(authFilePath(agentDir), { ...store, [providerId]: credential });
}

/** Remove one credential; returns the remaining store. */
export function removeStoredCredential(agentDir, providerId) {
	const store = readAuthStore(agentDir);
	if (!(providerId in store)) return store;
	const next = { ...store };
	delete next[providerId];
	return writeJsonAtomic(authFilePath(agentDir), next);
}

/** Redacted, serializable summary (no keys/tokens) for diagnostics and export. */
export function credentialSummary(credential, now = Date.now()) {
	if (!isCredential(credential)) return undefined;
	if (credential.type === "api_key") {
		return { type: "api_key", hasKey: typeof credential.key === "string" && credential.key.length > 0, env: credential.env ? Object.keys(credential.env) : undefined };
	}
	const lifetime = credentialLifetime(credential, now);
	return {
		type: "oauth",
		expires: lifetime.expires,
		expired: lifetime.expired,
		// Provider-specific extras (e.g. openai-codex accountId) are metadata, not secrets.
		extras: Object.keys(credential).filter((key) => !["type", "access", "refresh", "expires"].includes(key)),
	};
}

/** Redacted view of the whole store. */
export function exportCredentials(agentDir, now = Date.now()) {
	const store = readAuthStore(agentDir);
	return Object.entries(store)
		.filter(([, credential]) => isCredential(credential))
		.map(([providerId, credential]) => ({ providerId, ...credentialSummary(credential, now) }));
}

/**
 * Copy-once import from another agent directory (PI, a previous Tsukuyomi
 * install, or an explicit `--migrate-from` path).
 *
 * Existing credentials are never overwritten unless `overwrite` is set, so the
 * destination stays the single owner after the first import. Invalid entries
 * are ignored rather than failing the whole import.
 *
 * @returns {{imported: string[], skipped: string[], source: string|undefined}}
 */
export function importCredentials(agentDir, sourceDir, { overwrite = false } = {}) {
	if (!sourceDir || !existsSync(authFilePath(sourceDir))) return { imported: [], skipped: [], source: undefined };
	const source = readAuthStore(sourceDir);
	const store = readAuthStore(agentDir);
	const imported = [];
	const skipped = [];
	let next = store;
	for (const [providerId, credential] of Object.entries(source)) {
		if (!isCredential(credential)) continue;
		if (providerId in store && !overwrite) {
			skipped.push(providerId);
			continue;
		}
		if (next === store) next = { ...store };
		next[providerId] = credential;
		imported.push(providerId);
	}
	if (imported.length > 0) writeJsonAtomic(authFilePath(agentDir), next);
	return { imported, skipped, source: sourceDir };
}

/** Delete the credential file entirely (used by tests and `--logout --all`). */
export function clearAuthStore(agentDir) {
	const path = authFilePath(agentDir);
	if (existsSync(path)) unlinkSync(path);
}
