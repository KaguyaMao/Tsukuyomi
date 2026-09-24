import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexCredentialFromAuth, readCodexCredential, syncCodexCredential } from "../../app/providers/codex-auth.mjs";

function jwt(payload) {
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function auth(accountId = "acct-1", exp = 2_000_000_000) {
	return {
		auth_mode: "chatgpt",
		tokens: {
			access_token: jwt({ exp, "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
			refresh_token: "refresh-token",
			account_id: accountId,
		},
	};
}

test("Codex auth is converted using the access-token expiry, not id-token expiry", () => {
	const source = auth("acct-1", 2_000_000_000);
	source.tokens.id_token = jwt({ exp: 1_700_000_000 });
	const credential = codexCredentialFromAuth(source);
	assert.equal(credential.type, "oauth");
	assert.equal(credential.access, source.tokens.access_token);
	assert.equal(credential.refresh, "refresh-token");
	assert.equal(credential.expires, 2_000_000_000_000);
	assert.equal(credential.accountId, "acct-1");
});

test("Codex account sync persists and activates a changed external account", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "tsukuyomi-codex-auth-"));
	const source = join(agentDir, "codex-auth.json");
	writeFileSync(source, JSON.stringify(auth("acct-2", 2_000_000_000)));
	const result = syncCodexCredential(agentDir, { path: source });
	assert.equal(result.imported, true);
	assert.equal(result.activated, true);
	assert.equal(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))["openai-codex"].accountId, "acct-2");
	const accounts = JSON.parse(readFileSync(join(agentDir, "accounts.json"), "utf8"));
	assert.equal(accounts.providers["openai-codex"].active, "codex-acct-2");
	assert.equal(accounts.providers["openai-codex"].codexAccountId, "codex-acct-2");

	// A user-selected account is not stolen back by a later token refresh for
	// the same Codex account.
	accounts.providers["openai-codex"].active = "manual";
	writeFileSync(join(agentDir, "accounts.json"), JSON.stringify(accounts));
	const next = syncCodexCredential(agentDir, { path: source });
	assert.equal(next.activated, false);
});

test("invalid or absent Codex auth is ignored", () => {
	const dir = mkdtempSync(join(tmpdir(), "tsukuyomi-codex-auth-"));
	assert.equal(readCodexCredential(join(dir, "missing.json")), undefined);
	assert.equal(codexCredentialFromAuth({ tokens: { access_token: "a", refresh_token: "r" } }), undefined);
});
