import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyNetworkEnv,
	curlFetchCandidates,
	envFileCandidates,
	findCurlFetchHook,
	installFetchHook,
	loadEnvFile,
	needsProxyRestart,
	networkEnvForChild,
	parseEnvFile,
	restartWithProxy,
	withRequireOption,
} from "../app/net-env.mjs";

const require = createRequire(import.meta.url);

test("parseEnvFile handles export, quotes, comments, and blank lines", () => {
	const values = parseEnvFile(
		[
			"# comment",
			"",
			"HTTP_PROXY=http://127.0.0.1:12450",
			"export HTTPS_PROXY=http://127.0.0.1:12450",
			'NO_PROXY="localhost, 127.0.0.1,::1"',
			"  no_proxy = 'localhost'",
			"BROKEN",
			"=nokey",
		].join("\n"),
	);
	assert.equal(values.HTTP_PROXY, "http://127.0.0.1:12450");
	assert.equal(values.HTTPS_PROXY, "http://127.0.0.1:12450");
	assert.equal(values.NO_PROXY, "localhost, 127.0.0.1,::1");
	assert.equal(values.no_proxy, "localhost");
	assert.equal(values.BROKEN, undefined);
	assert.equal(values[""], undefined);
});

test("envFileCandidates puts an explicit override first", () => {
	const previous = process.env.TSUKUYOMI_ENV_FILE;
	process.env.TSUKUYOMI_ENV_FILE = "/tmp/explicit.env";
	try {
		assert.equal(envFileCandidates({ agentDir: "/tmp/agent", home: "/home/u" })[0], "/tmp/explicit.env");
	} finally {
		if (previous === undefined) delete process.env.TSUKUYOMI_ENV_FILE;
		else process.env.TSUKUYOMI_ENV_FILE = previous;
	}
	const plain = envFileCandidates({ agentDir: "/tmp/agent", home: "/home/u" });
	assert.ok(plain.some((path) => path.endsWith("/.tsukuyomi/agent/.env")));
	assert.ok(plain.some((path) => path.endsWith("/.kaguyapi/agent/.env")));
});

test("loadEnvFile reads the agent .env and honors TSUKUYOMI_NO_PROXY_FILE", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "tsukuyomi-env-"));
	writeFileSync(join(agentDir, ".env"), "HTTPS_PROXY=http://127.0.0.1:9\nIGNORED=1\n");
	const loaded = loadEnvFile({ agentDir, home: agentDir, env: {} });
	assert.equal(loaded.file, join(agentDir, ".env"));
	assert.equal(loaded.values.HTTPS_PROXY, "http://127.0.0.1:9");
	assert.equal(loadEnvFile({ agentDir, home: agentDir, env: { TSUKUYOMI_NO_PROXY_FILE: "1" } }).file, undefined);
});

test("findCurlFetchHook prefers an explicit path, then the vendored hook", () => {
	const appRoot = mkdtempSync(join(tmpdir(), "tsukuyomi-root-"));
	mkdirSync(join(appRoot, "app"), { recursive: true });
	const vendored = join(appRoot, "app", "curl-fetch.cjs");
	writeFileSync(vendored, "module.exports = {};\n");
	assert.equal(findCurlFetchHook({ appRoot, home: appRoot, env: {} }), vendored);
	const explicit = join(appRoot, "custom.cjs");
	writeFileSync(explicit, "module.exports = {};\n");
	assert.equal(findCurlFetchHook({ appRoot, home: appRoot, env: { TSUKUYOMI_CURL_FETCH: explicit } }), explicit);
});

test("curlFetchCandidates includes the legacy user-level path", () => {
	const candidates = curlFetchCandidates({ appRoot: "/app", home: "/home/u", env: {} });
	assert.ok(candidates.some((path) => path.endsWith("/.local/share/tsukuyomi/pi-curl-fetch.cjs")));
	assert.ok(candidates.some((path) => path.endsWith("/.local/share/kaguyapi/pi-curl-fetch.cjs")));
});

test("withRequireOption prepends once and does not duplicate", () => {
	assert.equal(withRequireOption(undefined, "/h.cjs"), "--require=/h.cjs");
	assert.equal(withRequireOption("--inspect", "/h.cjs"), "--require=/h.cjs --inspect");
	assert.equal(withRequireOption("--require=/h.cjs --inspect", "/h.cjs"), "--require=/h.cjs --inspect");
	assert.equal(withRequireOption("--inspect", undefined), "--inspect");
});

test("installFetchHook loads the hook and reports failure gracefully", () => {
	const dir = mkdtempSync(join(tmpdir(), "tsukuyomi-hook-"));
	const hook = join(dir, "hook.cjs");
	writeFileSync(hook, "globalThis.__tsukuyomiCurlFetchInstalled = true;\n");
	delete globalThis.__tsukuyomiCurlFetchInstalled;
	assert.equal(installFetchHook(hook, { require }), true);
	assert.equal(globalThis.__tsukuyomiCurlFetchInstalled, true);
	delete globalThis.__tsukuyomiCurlFetchInstalled;
	const broken = join(dir, "broken.cjs");
	writeFileSync(broken, "throw new Error('nope');\n");
	assert.equal(installFetchHook(broken, { require }), false);
	assert.equal(installFetchHook(undefined, { require }), false);
});

test("applyNetworkEnv applies proxy gaps and configures the child env", () => {
	const home = mkdtempSync(join(tmpdir(), "tsukuyomi-home-"));
	const agentDir = join(home, ".tsukuyomi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, ".env"), "HTTPS_PROXY=http://127.0.0.1:12450\nSECRET_TOKEN=leak\n");
	const hook = join(agentDir, "hook.cjs");
	writeFileSync(hook, "globalThis.__tsukuyomiCurlFetchInstalled = true;\n");
	delete globalThis.__tsukuyomiCurlFetchInstalled;

	const env = { TSUKUYOMI_CURL_FETCH: hook };
	const result = applyNetworkEnv({ agentDir, appRoot: home, home, env });
	assert.equal(result.envFile, join(agentDir, ".env"));
	assert.deepEqual(result.applied, ["HTTPS_PROXY"]);
	assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:12450");
	// Non-network keys from the file must not leak into the environment.
	assert.equal(env.SECRET_TOKEN, undefined);
	assert.equal(result.hookPath, hook);
	assert.equal(result.hookInstalled, true);
	assert.equal(result.nodeOptions, `--require=${hook}`);
	assert.equal(env.NODE_OPTIONS, `--require=${hook}`);

	const child = networkEnvForChild({ nodeOptions: result.nodeOptions, env });
	assert.equal(child.NODE_OPTIONS, `--require=${hook}`);
	assert.equal(child.HTTPS_PROXY, "http://127.0.0.1:12450");
	assert.equal(child.TSUKUYOMI_CURL_FETCH, undefined);
	delete globalThis.__tsukuyomiCurlFetchInstalled;
});

test("applyNetworkEnv never overrides an explicit proxy", () => {
	const home = mkdtempSync(join(tmpdir(), "tsukuyomi-home-"));
	const agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, ".env"), "HTTPS_PROXY=http://from-file\n");
	const env = { HTTPS_PROXY: "http://from-shell" };
	const result = applyNetworkEnv({ agentDir, appRoot: home, home, env });
	assert.equal(env.HTTPS_PROXY, "http://from-shell");
	assert.equal(result.applied.includes("HTTPS_PROXY"), false);
});

test("needsProxyRestart only fires when a proxy is set and it is the first pass", () => {
	assert.equal(needsProxyRestart({}), false);
	assert.equal(needsProxyRestart({ HTTPS_PROXY: "http://p" }), true);
	assert.equal(needsProxyRestart({ HTTPS_PROXY: "http://p", NODE_USE_ENV_PROXY: "1" }), false);
	assert.equal(needsProxyRestart({ HTTPS_PROXY: "http://p", TSUKUYOMI_NET_PROXY_EXEC: "1" }), false);
});

test("restartWithProxy re-executes with the marker and returns the child status", () => {
	const calls = [];
	const previousArgv = process.argv;
	process.argv = ["node", "/tmp/tsukuyomi.mjs", "--plan"];
	try {
		const status = restartWithProxy({
			env: { HTTPS_PROXY: "http://p" },
			spawn: (command, args, options) => {
				calls.push({ command, args, options });
				return { status: 7 };
			},
		});
		assert.equal(status, 7);
	} finally {
		process.argv = previousArgv;
	}
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].args, ["/tmp/tsukuyomi.mjs", "--plan"]);
	assert.equal(calls[0].options.env.NODE_USE_ENV_PROXY, "1");
	assert.equal(calls[0].options.env.TSUKUYOMI_NET_PROXY_EXEC, "1");
});

test("restartWithProxy reports failure without crashing the launcher", () => {
	assert.equal(
		restartWithProxy({
			env: { HTTPS_PROXY: "http://p" },
			spawn: () => ({ error: new Error("spawn failed") }),
		}),
		undefined,
	);
});
