import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrate } from "../../app/migration.mjs";

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function legacyDir() {
	const dir = mkdtempSync(join(tmpdir(), "tsukuyomi-legacy-agent-"));
	writeJson(join(dir, "settings.json"), { theme: "dark" });
	writeJson(join(dir, "kaguya.json"), { language: "zh" });
	writeJson(join(dir, "kaguya-tools.json"), { disabled: [], subagents: true });
	writeJson(join(dir, "kaguya-web.json"), { allowLocal: true });
	writeJson(join(dir, "auth.json"), { anthropic: { type: "api_key", key: "legacy-key" } });
	writeJson(join(dir, "models.json"), { providers: { handwritten: { api: "openai-completions", baseUrl: "https://h.dev", models: [{ id: "m" }] } } });
	writeJson(join(dir, "sessions", "one.jsonl"), {});
	return dir;
}

test("migration renames legacy kaguya*.json files", () => {
	const target = mkdtempSync(join(tmpdir(), "tsukuyomi-agent-"));
	const source = legacyDir();
	const report = migrate({ target, sources: [source] });

	assert.equal(report.errors.length, 0);
	assert.equal(existsSync(join(target, "tsukuyomi.json")), true);
	assert.equal(existsSync(join(target, "kaguya.json")), false);
	assert.equal(existsSync(join(target, "tsukuyomi-tools.json")), true);
	assert.equal(existsSync(join(target, "tsukuyomi-web.json")), true);
	assert.equal(existsSync(join(target, "kaguya-tools.json")), false);
	assert.deepEqual(JSON.parse(readFileSync(join(target, "tsukuyomi.json"), "utf8")), { language: "zh" });
});

test("migration imports credentials and providers", () => {
	const target = mkdtempSync(join(tmpdir(), "tsukuyomi-agent-"));
	const source = legacyDir();
	migrate({ target, sources: [source] });
	assert.deepEqual(JSON.parse(readFileSync(join(target, "auth.json"), "utf8")), {
		anthropic: { type: "api_key", key: "legacy-key" },
	});
	assert.ok(JSON.parse(readFileSync(join(target, "models.json"), "utf8")).providers.handwritten);
	assert.equal(existsSync(join(target, "sessions", "one.jsonl")), true);
});

test("migration merges auth.json keys instead of dropping either side", () => {
	const target = mkdtempSync(join(tmpdir(), "tsukuyomi-agent-"));
	writeJson(join(target, "auth.json"), { openai: { type: "api_key", key: "target-key" } });
	const source = legacyDir();
	migrate({ target, sources: [source] });
	const merged = JSON.parse(readFileSync(join(target, "auth.json"), "utf8"));
	assert.equal(merged.openai.key, "target-key");
	assert.equal(merged.anthropic.key, "legacy-key");
});

test("migration is copy-once and idempotent", () => {
	const target = mkdtempSync(join(tmpdir(), "tsukuyomi-agent-"));
	const source = legacyDir();
	migrate({ target, sources: [source] });
	const second = migrate({ target, sources: [source] });
	assert.equal(second.copied.length, 0);
	assert.equal(second.conflicts.length, 0);
	const ledger = JSON.parse(readFileSync(join(target, ".migration", "ledger.json"), "utf8"));
	assert.deepEqual(ledger.sources, [source]);
});

test("migration sources are never modified", () => {
	const source = legacyDir();
	const target = mkdtempSync(join(tmpdir(), "tsukuyomi-agent-"));
	migrate({ target, sources: [source] });
	assert.equal(existsSync(join(source, "kaguya.json")), true);
	assert.deepEqual(JSON.parse(readFileSync(join(source, "auth.json"), "utf8")), {
		anthropic: { type: "api_key", key: "legacy-key" },
	});
});

test("migration does not import a legacy kaguyapi backend extension", () => {
	// A previous distro install: /opt/kaguyapi/{package.json,src/backend.ts}.
	const legacyInstall = mkdtempSync(join(tmpdir(), "kaguyapi-install-"));
	writeJson(join(legacyInstall, "package.json"), { name: "kaguyapi" });
	const legacyBackend = join(legacyInstall, "src", "backend.ts");
	writeJson(legacyBackend, { legacy: true });

	const source = mkdtempSync(join(tmpdir(), "tsukuyomi-legacy-agent-"));
	writeJson(join(source, "settings.json"), { extensions: [legacyBackend] });

	const appRoot = mkdtempSync(join(tmpdir(), "tsukuyomi-app-"));
	const backend = join(appRoot, "src", "backend.ts");
	writeJson(backend, { backend: true });

	const target = mkdtempSync(join(tmpdir(), "tsukuyomi-agent-"));
	migrate({ target, sources: [source], appRoot });

	const settings = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
	assert.deepEqual(settings.extensions, [backend]);
});

test("migration prunes a foreign backend already present in the target", () => {
	const appRoot = mkdtempSync(join(tmpdir(), "tsukuyomi-app-"));
	const backend = join(appRoot, "src", "backend.ts");
	writeJson(backend, { backend: true });

	const target = mkdtempSync(join(tmpdir(), "tsukuyomi-agent-"));
	const foreign = join(target, "imported", "abc123", "backend.ts");
	writeJson(foreign, { legacy: true });
	writeJson(join(target, "settings.json"), { extensions: [foreign] });

	migrate({ target, sources: [], appRoot });

	const settings = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
	assert.deepEqual(settings.extensions, [backend]);
});
