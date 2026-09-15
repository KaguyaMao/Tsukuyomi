#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findPi, findPiRoot } from "../app/pi-runtime.mjs";
import { applyNetworkEnv, needsProxyRestart, networkEnvForChild, restartWithProxy } from "../app/net-env.mjs";
import { migrate } from "../app/migration.mjs";
import { WorkspacePool, sessionlessArgs } from "../app/workspaces.mjs";
import { TaskService } from "../app/task-service.mjs";
import { removeUserShadows, resolvePackagedExec } from "../app/packaged-runtime.mjs";

const ENTRY = realpathSync(fileURLToPath(import.meta.url));
const ROOT = resolve(dirname(ENTRY), "..");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const HOME = homedir();
// TSUKUYOMI_* wins; legacy KAGUYAPI_* is honoured once so existing installs keep
// working through the rename (the migration imports ~/.kaguyapi/agent below).
const LEGACY_AGENT_DIR = join(HOME, ".kaguyapi", "agent");
const AGENT_DIR = process.env.TSUKUYOMI_DIR || process.env.KAGUYAPI_DIR || process.env.PI_CODING_AGENT_DIR || join(HOME, ".tsukuyomi", "agent");
const PI_AGENT_DIR = join(HOME, ".pi", "agent");

// Load proxy settings and install the curl-fetch hook before anything can make
// a request. OAuth login runs in this process, so it needs both; the kernel
// receives the same configuration through networkEnvForChild() below.
const network = applyNetworkEnv({ agentDir: AGENT_DIR, appRoot: ROOT, home: HOME });
if (network.hookPath && !network.hookInstalled) {
	console.error("Tsukuyomi: continuing without the curl-fetch hook; OpenAI sign-in may fail with a region error.");
}
// Node only honours HTTP(S)_PROXY for fetch when NODE_USE_ENV_PROXY is set at
// startup, so restart once with it. Without this, provider endpoints that are
// only reachable through the proxy (api.x.ai and friends) fail with
// "fetch failed" even after a successful sign-in.
if (needsProxyRestart()) {
	const status = restartWithProxy();
	if (status !== undefined) process.exit(status);
}


function bootstrap(options = {}) {
	return migrate({ target: AGENT_DIR, sources: [PI_AGENT_DIR, LEGACY_AGENT_DIR, ...migrationSources], appRoot: ROOT, ...options });
}

function printBanner() {
	console.log(`Tsukuyomi ${VERSION}`);
	console.log(`Grok Build-style sessions and OpenCode-style workspace panels, powered by the PI RPC kernel.`);
	console.log(`Original PI plugins, tools, sessions, and providers remain available.`);
	console.log(`Config: ${AGENT_DIR}`);
	console.log("");
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--fix-path")) {
	const removed = removeUserShadows(HOME);
	if (!removed.length) console.log("Tsukuyomi: no user-level launcher is shadowing /usr/bin/tsukuyomi.");
	else for (const shadow of removed) console.log(`Tsukuyomi: removed ${shadow.path}${shadow.link ? ` -> ${shadow.link}` : ""}`);
	process.exit(0);
}
const packaged = resolvePackagedExec({ currentRoot: ROOT });
if (packaged) {
	const result = spawnSync(packaged.node, ["--no-global-search-paths", packaged.entry, ...rawArgs], {
		stdio: "inherit",
		env: packaged.env,
	});
	process.exit(result.status === null ? 1 : result.status);
}
const migrationSources = [];
for (let i = 0; i < rawArgs.length; i++) {
	if (rawArgs[i] === "--migrate-from") {
		if (!rawArgs[i + 1] || rawArgs[i + 1].startsWith("--")) throw new Error("--migrate-from requires a directory");
		migrationSources.push(resolve(rawArgs[i + 1])); rawArgs.splice(i, 2); i--;
	}
}
if (rawArgs.includes("--migrate")) {
	try { console.log(JSON.stringify(bootstrap({ dryRun: rawArgs.includes("--dry-run") }), null, 2)); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
	process.exit(process.exitCode || 0);
}
if (rawArgs.includes("--ask")) { console.error("Ask mode was removed. Use --plan for read-only planning."); process.exit(1); }
if (rawArgs.includes("--tsukuyomi-version") || rawArgs[0] === "-V") {
	printBanner();
	process.exit(0);
}

const piBin = findPi({ root: ROOT, home: HOME });
if (!piBin) {
	console.error("Tsukuyomi: could not find the `pi` binary.");
	console.error("Install Pi first: npm install -g --ignore-scripts @earendil-works/pi-coding-agent");
	process.exit(1);
}

if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
	printBanner();
	console.log("Usage: tsukuyomi [--workspace <directory>] [--language en|zh] [PI options]");
	console.log("       tsukuyomi <directory> [PI options]");
	console.log("       tsukuyomi --plan     start in Plan mode");
	console.log("       tsukuyomi --migrate [--dry-run] [--migrate-from <agent-directory>]");
	console.log("       tsukuyomi --fix-path  remove ~/.local/bin/tsukuyomi if it shadows the package");
	console.log("       tsukuyomi --language zh  start with Chinese UI");
	console.log("");
	console.log("Shortcuts:");
	console.log("  shift+tab  cycle Build/Plan         ctrl+p  command palette");
	console.log("  ctrl+s     browse/restore sessions   /tools  toggle agent tools");
	console.log("  ctrl+b     ask/show workspace files ctrl+o  toggle Workflow");
	console.log("  ctrl+t     toggle Todo              wheel   scroll the panel under the pointer");
	console.log("  mouse      click panels/options     page up/down  scroll transcript");
	console.log("  touch mode TSUKUYOMI_TOUCH_MODE=1 or /touch on prevents transcript drag selection");
	console.log("  middle     paste PRIMARY (Linux)");
	console.log("  language   TSUKUYOMI_LANG=en|zh or /language en|zh");
	console.log("  esc        close overlays/dialogs or abort the active run");
	console.log("");
	console.log("PI RPC options such as --provider, --model, --continue, --session,");
	console.log("--session-dir, --no-session, and extension flags are forwarded.");
	process.exit(0);
}

function resolveDirectory(value) {
	if (!value) return null;
	const expanded = value === "~" ? HOME : value.startsWith("~/") ? join(HOME, value.slice(2)) : value;
	try {
		const absolute = realpathSync(resolve(expanded));
		return statSync(absolute).isDirectory() ? absolute : null;
	} catch {
		return null;
	}
}

let workspace;
let workspaceExplicit = false;
let language;
let args = [];
for (let index = 0; index < rawArgs.length; index++) {
	const arg = rawArgs[index];
	if (arg === "--language" || arg === "-L") {
		const value = rawArgs[++index];
		if (!value || !["en", "zh"].includes(value.toLowerCase())) {
			console.error("Tsukuyomi: --language requires en or zh.");
			process.exit(1);
		}
		language = value.toLowerCase();
		continue;
	}
	if (arg.startsWith("--language=")) {
		const value = arg.slice("--language=".length).toLowerCase();
		if (!["en", "zh"].includes(value)) {
			console.error("Tsukuyomi: --language requires en or zh.");
			process.exit(1);
		}
		language = value;
		continue;
	}
	if (arg === "--workspace" || arg === "-w") {
		const value = rawArgs[++index];
		if (!value) {
			console.error("Tsukuyomi: --workspace requires a directory.");
			process.exit(1);
		}
		workspace = resolveDirectory(value);
		if (!workspace) {
			console.error(`Tsukuyomi: workspace is not a readable directory: ${value}`);
			process.exit(1);
		}
		workspaceExplicit = true;
		continue;
	}
	if (arg.startsWith("--workspace=")) {
		const value = arg.slice("--workspace=".length);
		workspace = resolveDirectory(value);
		if (!workspace) {
			console.error(`Tsukuyomi: workspace is not a readable directory: ${value}`);
			process.exit(1);
		}
		workspaceExplicit = true;
		continue;
	}
	args.push(arg);
}

if (!workspaceExplicit && args.length >= 1 && !args[0].startsWith("-")) {
	const directory = resolveDirectory(args[0]);
	if (directory) {
		workspace = directory;
		workspaceExplicit = true;
		args.splice(0, 1);
	}
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.error("Tsukuyomi: the independent TUI requires an interactive terminal.");
	process.exit(1);
}

bootstrap();

const env = {
	...process.env,
	// Proxy variables plus NODE_OPTIONS=--require <curl-fetch hook> for the kernel.
	...networkEnvForChild(network),
	PI_CODING_AGENT_DIR: AGENT_DIR,
	TSUKUYOMI: "1",
	AI_AGENT: process.env.AI_AGENT || "tsukuyomi",
	...(language ? { TSUKUYOMI_LANG: language } : {}),
};

let piRoot;
try {
	piRoot = findPiRoot(piBin, { appRoot: ROOT });
} catch (error) {
	console.error(`Tsukuyomi: could not resolve the PI installation: ${error.message}`);
	process.exit(1);
}

const workspacePool = new WorkspacePool();
const taskService = new TaskService({ agentDir: AGENT_DIR, piBin, root: ROOT });
try {
	Object.assign(env, await taskService.start());
	const { runTsukuyomi } = await import(pathToFileURL(join(ROOT, "app", "tui.mjs")).href);
	let launchCwd = workspace || process.cwd();
	let explicit = workspaceExplicit;
	for (;;) {
		const result = await runTsukuyomi({
			workspacePool,
			piBin,
			piRoot,
			args,
			env,
			cwd: launchCwd,
			workspaceExplicit: explicit,
			version: VERSION,
		});
		if (result && typeof result === "object") {
			if (result.restart === "provider") {
				// Always discard the parked kernel, including when a saved session
				// is resumed. It owns the pre-login model availability snapshot.
				workspacePool.remove(launchCwd);
				args.splice(0, args.length, ...sessionlessArgs(args));
				if (result.providerId) args.push("--provider", result.providerId);
				if (result.modelId) args.push("--model", result.modelId);
				if (result.session) args.push("--session", result.session);
				continue;
			}
			if (result.session) {
				workspacePool.remove(result.workspace || launchCwd);
				const cleaned = [];
				for (let index = 0; index < args.length; index++) {
					const arg = args[index];
					if (arg === "--session" || arg === "--session-id") {
						if (args[index + 1] && !args[index + 1].startsWith("-")) index += 1;
						continue;
					}
					if (arg === "--continue" || arg === "-c" || arg === "--resume" || arg === "-r" || arg.startsWith("--session=") || arg.startsWith("--session-id=")) continue;
					cleaned.push(arg);
				}
				args.length = 0;
				args.push(...cleaned, "--session", result.session);
			}
			if (result.workspace) {
				if (!result.session) args = sessionlessArgs(args);
				launchCwd = result.workspace;
				explicit = true;
			}
			continue;
		}
		process.exitCode = typeof result === "number" ? result : 0;
		break;
	}
} catch (error) {
	console.error(`Tsukuyomi: failed to launch: ${error instanceof Error ? error.message : String(error)}`);
	console.error(`  app=${ROOT}`);
	console.error(`  pi=${piBin}`);
	console.error(`  piRoot=${piRoot || "(unresolved)"}`);
	process.exitCode = 1;
} finally {
	workspacePool.stop();
	await taskService.stop();
}
