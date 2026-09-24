/**
 * Import the canonical ChatGPT OAuth session written by the Codex CLI.
 *
 * Codex and PI use different on-disk envelopes for the same OAuth session:
 *   ~/.codex/auth.json -> { auth_mode, tokens: { access_token, refresh_token, account_id } }
 *   PI auth.json       -> { type, access, refresh, expires, accountId }
 *
 * The access token is not copied by reference or symlinked.  We take a
 * point-in-time copy, preserve the Codex account id, and let PI own future
 * refreshes.  This is deliberately best-effort: a broken or absent Codex
 * file must never prevent Tsukuyomi from starting.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { syncExternalAccount } from "./accounts.mjs";

export const CODEX_PROVIDER_ID = "openai-codex";

/** Resolve CODEX_HOME in the same shape as the Codex CLI: a directory. */
export function codexAuthPath({ home = homedir(), env = process.env } = {}) {
	const root = env?.CODEX_HOME || home;
	return join(root, env?.CODEX_HOME ? "auth.json" : ".codex/auth.json");
}

function stringValue(value) {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value) {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** Decode only the unsigned JWT payload; this is metadata extraction, not verification. */
export function decodeJwtPayload(token) {
	try {
		const part = String(token).split(".")[1];
		if (!part) return undefined;
		const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function accessTokenExpiry(access, tokens) {
	// Codex normally has no explicit expires_at; the access JWT's exp is the
	// authoritative lifetime.  A compatible Codex build may provide either
	// seconds or milliseconds in expires_at, so accept both forms as fallback.
	const jwtExpiry = numberValue(decodeJwtPayload(access)?.exp);
	if (jwtExpiry) return jwtExpiry < 100_000_000_000 ? jwtExpiry * 1_000 : jwtExpiry;
	const explicit = numberValue(tokens?.expires_at);
	if (explicit) return explicit < 100_000_000_000 ? explicit * 1_000 : explicit;
	return undefined;
}

/** Convert a Codex auth.json object into PI's canonical OAuth credential. */
export function codexCredentialFromAuth(auth) {
	if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
	const tokens = auth.tokens;
	if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return undefined;
	const access = stringValue(tokens.access_token);
	const refresh = stringValue(tokens.refresh_token);
	if (!access || !refresh) return undefined;
	const payload = decodeJwtPayload(access);
	const authClaims = payload?.["https://api.openai.com/auth"];
	const accountId = stringValue(tokens.account_id) || stringValue(authClaims?.chatgpt_account_id);
	const expires = accessTokenExpiry(access, tokens);
	if (!accountId || !expires) return undefined;
	return { type: "oauth", access, refresh, expires, accountId };
}

/** Read and convert ~/.codex/auth.json without throwing on startup errors. */
export function readCodexCredential(path = codexAuthPath()) {
	try {
		if (!existsSync(path)) return undefined;
		return codexCredentialFromAuth(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

/**
 * Synchronize the current Codex CLI account into Tsukuyomi's persistent
 * multi-account store. The first observed Codex account becomes active; later
 * refreshes update the saved copy without overriding a user-selected account.
 * If Codex itself switches to another account, that new account becomes active.
 */
export function syncCodexCredential(agentDir, { path = codexAuthPath(), name, now = Date.now } = {}) {
	const credential = readCodexCredential(path);
	if (!credential) return { imported: false, path };
	const shortId = credential.accountId.slice(0, 8);
	const accountId = `codex-${credential.accountId}`;
	const result = syncExternalAccount(agentDir, CODEX_PROVIDER_ID, accountId, credential, {
		name: name || `Codex · ${shortId}`,
		marker: "codexAccountId",
		now,
	});
	return { ...result, imported: true, path, accountId: credential.accountId, accountRef: accountId };
}
