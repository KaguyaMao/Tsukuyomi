import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	accountCredential,
	activateAccount,
	authStoreForAccount,
	listAccounts,
	materializeAccountRuntime,
	parseAccountRef,
	saveAccount,
	syncExternalAccount,
} from "../../app/providers/accounts.mjs";
import { writeAuthStore } from "../../app/providers/store.mjs";

test("account refs resolve provider-local and provider-qualified ids", () => {
	assert.deepEqual(parseAccountRef("work", "openai"), { providerId: "openai", id: "work" });
	assert.deepEqual(parseAccountRef("anthropic:personal"), { providerId: "anthropic", id: "personal" });
	assert.deepEqual(parseAccountRef({ providerId: "xai", id: "team" }), { providerId: "xai", id: "team" });
	assert.equal(parseAccountRef("", "openai"), undefined);
});

test("selected account is materialized without changing the main auth store", () => {
	const dir = mkdtempSync(join(tmpdir(), "tsukuyomi-accounts-test-"));
	const runtime = join(dir, "child-agent");
	writeAuthStore(dir, { openai: { type: "api_key", key: "main-secret" } });
	saveAccount(dir, "openai", "first", { type: "api_key", key: "first-secret" }, "First");
	saveAccount(dir, "openai", "second", { type: "api_key", key: "second-secret" }, "Second");
	assert.equal(accountCredential(dir, "openai", "first").key, "first-secret");
	assert.equal(authStoreForAccount(dir, "openai:first").openai.key, "first-secret");
	materializeAccountRuntime(dir, runtime, "second", "openai");
	assert.equal(JSON.parse(readFileSync(join(runtime, "auth.json"), "utf8")).openai.key, "second-secret");
	assert.equal(listAccounts(dir, "openai").length, 2);
	assert.equal(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")).openai.key, "main-secret");
});

test("external account sync activates the first import and later source switches", () => {
	const dir = mkdtempSync(join(tmpdir(), "tsukuyomi-accounts-sync-"));
	const first = syncExternalAccount(dir, "openai-codex", "codex-a", {
		type: "oauth", access: "a1", refresh: "r1", expires: 9e12, accountId: "a",
	}, { name: "Codex A", marker: "codexAccountId" });
	assert.equal(first.activated, true);
	assert.equal(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))["openai-codex"].access, "a1");

	// Same external account keeps a user-selected active account.
	saveAccount(dir, "openai-codex", "manual", { type: "oauth", access: "m", refresh: "rm", expires: 9e12, accountId: "m" }, "Manual");
	assert.equal(activateAccount(dir, "openai-codex", "manual"), true);
	const kept = syncExternalAccount(dir, "openai-codex", "codex-a", {
		type: "oauth", access: "a2", refresh: "r2", expires: 9e12, accountId: "a",
	}, { name: "Codex A", marker: "codexAccountId" });
	assert.equal(kept.activated, false);
	assert.equal(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))["openai-codex"].access, "m");
	assert.equal(accountCredential(dir, "openai-codex", "codex-a").access, "a2");

	// A different external account is treated as a Codex login switch.
	const switched = syncExternalAccount(dir, "openai-codex", "codex-b", {
		type: "oauth", access: "b1", refresh: "rb", expires: 9e12, accountId: "b",
	}, { name: "Codex B", marker: "codexAccountId" });
	assert.equal(switched.activated, true);
	assert.equal(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))["openai-codex"].access, "b1");
});
