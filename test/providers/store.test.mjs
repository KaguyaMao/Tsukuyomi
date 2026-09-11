import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	authFilePath,
	clearAuthStore,
	credentialLifetime,
	credentialSummary,
	exportCredentials,
	getStoredCredential,
	importCredentials,
	isCredential,
	listStoredCredentials,
	readAuthStore,
	removeStoredCredential,
	safeReadAuthStore,
	writeStoredCredential,
} from "../../app/providers/store.mjs";
import { AuthErrorCode } from "../../app/providers/errors.mjs";

const agentDir = () => mkdtempSync(join(tmpdir(), "tsukuyomi-store-"));

test("isCredential accepts PI's api_key and oauth shapes only", () => {
	assert.equal(isCredential({ type: "api_key", key: "k" }), true);
	assert.equal(isCredential({ type: "api_key" }), true);
	assert.equal(isCredential({ type: "oauth", access: "a", refresh: "r", expires: 1 }), true);
	assert.equal(isCredential({ type: "oauth", access: "a", refresh: "r" }), false);
	assert.equal(isCredential({ type: "api", key: "k" }), false);
	assert.equal(isCredential(null), false);
});

test("writeStoredCredential writes 0600 and round-trips", () => {
	const dir = agentDir();
	writeStoredCredential(dir, "anthropic", { type: "api_key", key: "sk-test" });
	const path = authFilePath(dir);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(getStoredCredential(dir, "anthropic"), { type: "api_key", key: "sk-test" });
	assert.deepEqual(listStoredCredentials(dir), [{ providerId: "anthropic", type: "api_key" }]);
});

test("writeStoredCredential preserves other providers", () => {
	const dir = agentDir();
	writeStoredCredential(dir, "a", { type: "api_key", key: "1" });
	writeStoredCredential(dir, "b", { type: "oauth", access: "x", refresh: "y", expires: Date.now() + 1000 });
	assert.deepEqual(Object.keys(readAuthStore(dir)).sort(), ["a", "b"]);
	removeStoredCredential(dir, "a");
	assert.deepEqual(Object.keys(readAuthStore(dir)), ["b"]);
});

test("writeStoredCredential rejects invalid credentials", () => {
	const dir = agentDir();
	assert.throws(() => writeStoredCredential(dir, "bad", { type: "api", key: "k" }), (error) => error.code === AuthErrorCode.CONFIG);
});

test("readAuthStore throws on malformed JSON but safeReadAuthStore does not", () => {
	const dir = agentDir();
	writeFileSync(authFilePath(dir), "{ not json");
	assert.throws(() => readAuthStore(dir), (error) => error.code === AuthErrorCode.STORE);
	assert.deepEqual(safeReadAuthStore(dir), {});
});

test("readAuthStore returns {} for a missing file", () => {
	assert.deepEqual(readAuthStore(agentDir()), {});
});

test("credentialLifetime flags expired oauth tokens", () => {
	const now = 1_000_000;
	assert.deepEqual(credentialLifetime({ type: "oauth", access: "a", refresh: "r", expires: now - 1 }, now).expired, true);
	assert.deepEqual(credentialLifetime({ type: "oauth", access: "a", refresh: "r", expires: now + 1 }, now).expired, false);
	assert.deepEqual(credentialLifetime({ type: "api_key", key: "k" }, now).expired, false);
});

test("credentialSummary redacts secrets", () => {
	const summary = credentialSummary({ type: "oauth", access: "secret-access", refresh: "secret-refresh", expires: 5, accountId: "acct" });
	assert.equal(JSON.stringify(summary).includes("secret"), false);
	assert.deepEqual(summary.extras, ["accountId"]);
	assert.deepEqual(credentialSummary({ type: "api_key", key: "sk-x" }), { type: "api_key", hasKey: true, env: undefined });
});

test("importCredentials is copy-once and never overwrites by default", () => {
	const source = agentDir();
	const target = agentDir();
	writeStoredCredential(source, "anthropic", { type: "api_key", key: "source-key" });
	writeStoredCredential(source, "openai", { type: "api_key", key: "source-openai" });
	writeStoredCredential(target, "anthropic", { type: "api_key", key: "target-key" });

	const first = importCredentials(target, source);
	assert.deepEqual(first.imported, ["openai"]);
	assert.deepEqual(first.skipped, ["anthropic"]);
	assert.equal(getStoredCredential(target, "anthropic").key, "target-key");
	assert.equal(getStoredCredential(target, "openai").key, "source-openai");

	const overwrite = importCredentials(target, source, { overwrite: true });
	assert.deepEqual(overwrite.imported.sort(), ["anthropic", "openai"]);
	assert.equal(getStoredCredential(target, "anthropic").key, "source-key");
});

test("importCredentials is a no-op when the source has no auth.json", () => {
	const target = agentDir();
	const result = importCredentials(target, agentDir());
	assert.deepEqual(result, { imported: [], skipped: [], source: undefined });
});

test("exportCredentials lists providers without secrets", () => {
	const dir = agentDir();
	writeStoredCredential(dir, "openrouter", { type: "api_key", key: "sk-secret" });
	const exported = exportCredentials(dir);
	assert.equal(exported.length, 1);
	assert.equal(exported[0].providerId, "openrouter");
	assert.equal(JSON.stringify(exported).includes("sk-secret"), false);
});

test("clearAuthStore removes the file", () => {
	const dir = agentDir();
	writeStoredCredential(dir, "a", { type: "api_key", key: "1" });
	assert.equal(existsSync(authFilePath(dir)), true);
	clearAuthStore(dir);
	assert.equal(existsSync(authFilePath(dir)), false);
});
