import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCredential, readAuthStore, writeAuthStore, writeStoredCredential } from "./store.mjs";

const file = (dir) => join(dir, "accounts.json");
function read(dir) {
	try { return JSON.parse(readFileSync(file(dir), "utf8")); } catch (e) { if (e.code === "ENOENT") return { providers: {} }; throw e; }
}
function write(dir, value) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${file(dir)}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file(dir));
}
export function listAccounts(dir, providerId) {
	const data = read(dir); return Object.entries(data.providers?.[providerId]?.accounts || {}).map(([id, a]) => ({ id, ...a }));
}
export function listAllAccounts(dir) {
	const data = read(dir);
	return Object.entries(data.providers || {}).flatMap(([providerId, provider]) =>
		Object.entries(provider.accounts || {}).map(([id, account]) => ({ providerId, id, ...account, current: id === provider.active })),
	);
}
export function activeAccount(dir, providerId) { return read(dir).providers?.[providerId]?.active; }

/** Resolve an account without exposing it through the list/status APIs. */
export function accountCredential(dir, providerId, id) {
	const account = read(dir).providers?.[providerId]?.accounts?.[id];
	if (!account || !isCredential(account.credential)) return undefined;
	return account.credential;
}

/** Accept either {providerId, id}, "providerId:id", or a provider-local id. */
export function parseAccountRef(ref, fallbackProvider) {
	if (ref && typeof ref === "object") {
		const providerId = String(ref.providerId || fallbackProvider || "").trim();
		const id = String(ref.id || ref.accountId || "").trim();
		return providerId && id ? { providerId, id } : undefined;
	}
	const raw = String(ref || "").trim();
	if (!raw) return undefined;
	const separator = raw.indexOf(":");
	if (separator > 0) return { providerId: raw.slice(0, separator), id: raw.slice(separator + 1) };
	return fallbackProvider ? { providerId: fallbackProvider, id: raw } : undefined;
}

/**
 * Build an isolated auth store for a child runtime. The source account remains
 * untouched, and credentials for every other provider are retained so a child
 * can still resolve auxiliary providers without switching the main account.
 */
export function authStoreForAccount(dir, ref, fallbackProvider) {
	const parsed = parseAccountRef(ref, fallbackProvider);
	if (!parsed) return readAuthStore(dir);
	const credential = accountCredential(dir, parsed.providerId, parsed.id);
	if (!credential) throw new Error(`Unknown account: ${parsed.providerId}:${parsed.id}`);
	return { ...readAuthStore(dir), [parsed.providerId]: credential };
}

export function materializeAccountRuntime(sourceDir, runtimeDir, ref, fallbackProvider) {
	return writeAuthStore(runtimeDir, authStoreForAccount(sourceDir, ref, fallbackProvider));
}
/**
 * Update an account from an external credential owner without unexpectedly
 * replacing a manually selected account. `marker` stores the last external
 * account id in accounts.json (metadata only, never a token).
 */
export function syncExternalAccount(dir, providerId, id, credential, { name = id, marker = "externalAccountId" } = {}) {
	if (!isCredential(credential)) throw new TypeError("Invalid credential");
	const data = read(dir);
	const provider = data.providers?.[providerId] || { accounts: {} };
	const accounts = { ...(provider.accounts || {}) };
	const previous = accounts[id];
	const account = {
		...(previous || {}),
		name: previous?.name || name,
		credential,
	};
	const accountChanged = JSON.stringify(previous) !== JSON.stringify(account);
	accounts[id] = account;
	const sourceChanged = provider[marker] !== id;
	// First import and a Codex account switch should take effect immediately.
	// Once the source account is known, a user may switch to another saved
	// account and future Codex token refreshes will not steal that selection.
	const activate = sourceChanged || provider.active === id || !provider.active;
	const authChanged = activate && JSON.stringify(readAuthStore(dir)[providerId]) !== JSON.stringify(credential);
	if (authChanged) writeStoredCredential(dir, providerId, credential);
	const activeChanged = activate && provider.active !== id;
	provider.accounts = accounts;
	provider[marker] = id;
	if (activate) provider.active = id;
	data.providers = { ...(data.providers || {}), [providerId]: provider };
	if (accountChanged || sourceChanged || activeChanged) write(dir, data);
	return { updated: accountChanged, activated: activate, accountId: id };
}

export function saveAccount(dir, providerId, id, credential, name = id) {
	if (!isCredential(credential)) throw new TypeError("Invalid credential");
	const data = read(dir); const provider = data.providers?.[providerId] || { accounts: {} };
	provider.accounts = { ...(provider.accounts || {}), [id]: { name, credential } }; provider.active = id;
	data.providers = { ...(data.providers || {}), [providerId]: provider }; write(dir, data);
}
export function renameAccount(dir, providerId, id, name) {
	const data = read(dir); const account = data.providers?.[providerId]?.accounts?.[id]; if (!account) return;
	account.name = name; write(dir, data);
}
export function deleteAccount(dir, providerId, id) {
	const data = read(dir); const provider = data.providers?.[providerId]; if (!provider?.accounts?.[id]) return;
	delete provider.accounts[id]; if (provider.active === id) provider.active = Object.keys(provider.accounts)[0]; write(dir, data);
}
export function activateAccount(dir, providerId, id) {
	const data = read(dir); const account = data.providers?.[providerId]?.accounts?.[id]; if (!account) return false;
	writeStoredCredential(dir, providerId, account.credential); data.providers[providerId].active = id; write(dir, data); return true;
}

// Import the existing single credential as account #1 without changing it.
export function migrateCurrentCredential(dir, providerId) {
	const credential = readAuthStore(dir)[providerId]; if (!isCredential(credential) || listAccounts(dir, providerId).length) return;
	saveAccount(dir, providerId, "account-1", credential, "Account #1");
}
export function migrateAllCurrentCredentials(dir) {
	for (const providerId of Object.keys(readAuthStore(dir))) migrateCurrentCredential(dir, providerId);
}
