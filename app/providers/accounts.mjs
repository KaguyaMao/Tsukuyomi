import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCredential, readAuthStore, writeStoredCredential } from "./store.mjs";

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
