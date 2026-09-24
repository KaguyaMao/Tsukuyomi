#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findPi, findPiRoot } from "../app/pi-runtime.mjs";
import { applyNetworkEnv, needsProxyRestart, networkEnvForChild, restartWithProxy } from "../app/net-env.mjs";
import { migrate } from "../app/migration.mjs";
import { migrateOpenCodeAuth } from "../app/providers/opencode-auth.mjs";
import { codexAuthPath, syncCodexCredential } from "../app/providers/codex-auth.mjs";
import { WorkspacePool, sessionlessArgs } from "../app/workspaces.mjs";
import { TaskService } from "../app/task-service.mjs";
import { removeUserShadows, resolvePackagedExec } from "../app/packaged-runtime.mjs";
import { legacyAgentDirs, resolveAgentDir } from "../app/paths.mjs";
import { applyManagedSkillArgs } from "../app/skills.mjs";

const ENTRY = realpathSync(fileURLToPath(import.meta.url));
const ROOT = resolve(dirname(ENTRY), "..");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const HOME = homedir();
// Tsukuyomi is the only active owner. Explicit Pi/Kaguya directories remain
// migration sources so launching this app cannot create a second live config.
const AGENT_DIR = resolveAgentDir({ env: process.env, home: HOME });
const LEGACY_AGENT_DIRS = legacyAgentDirs({ env: process.env, home: HOME, target: AGENT_DIR });

// Load proxy settings and install the curl-fetch hook before anything can make
// a request. OAuth login runs in this process, so it needs both; the kernel
// receives the same configuration through networkEnvForChild() below.
const network = await applyNetworkEnv({ agentDir: AGENT_DIR, appRoot: ROOT, home: HOME });
if (network.proxy && network.proxyUsable === false) {
	console.error(`Tsukuyomi: proxy ${network.proxy} is unreachable; using a direct connection.`);
}
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
	const report = migrate({ target: AGENT_DIR, sources: [...LEGACY_AGENT_DIRS, ...migrationSources], appRoot: ROOT, ...options });
	// Codex keeps ChatGPT OAuth in ~/.codex/auth.json rather than PI's auth.json.
	// Import it after the normal agent migration so the currently logged-in
	// Codex account is durable in Tsukuyomi and can replace an expired account.
	if (!options.dryRun) {
		try {
			report.codex = syncCodexCredential(AGENT_DIR, { path: codexAuthPath({ home: HOME, env: process.env }) });
		} catch (error) {
			report.codex = { imported: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
	return report;
}


function printBanner() {
	console.log(`Tsukuyomi ${VERSION}`);
	console.log(`Grok Build-style sessions and OpenCode-style workspace panels, powered by the PI RPC kernel.`);
	console.log(`Original PI plugins, tools, sessions, and providers remain available.`);
	console.log(`Config: ${AGENT_DIR}`);
	console.log("");
}

const rawArgs = process.argv.slice(2);
const launchArgs = [...rawArgs];
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
let openCodeAuthPath;
let openCodeConfigPath;
for (let i = 0; i < rawArgs.length; i++) {
	if (rawArgs[i] === "--opencode-auth" || rawArgs[i] === "--opencode-config") {
		if (!rawArgs[i + 1] || rawArgs[i + 1].startsWith("--")) throw new Error(`${rawArgs[i]} requires a file`);
		if (rawArgs[i] === "--opencode-auth") openCodeAuthPath = resolve(rawArgs[i + 1]);
		else openCodeConfigPath = resolve(rawArgs[i + 1]);
		rawArgs.splice(i, 2); i--;
	}
}
if (rawArgs.includes("--migrate")) {
	try { console.log(JSON.stringify(bootstrap({ dryRun: rawArgs.includes("--dry-run") }), null, 2)); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
	process.exit(process.exitCode || 0);
}
if (rawArgs.includes("--migrate-opencode")) {
	try {
		console.log(JSON.stringify(migrateOpenCodeAuth({
			targetDir: AGENT_DIR,
			sourcePath: openCodeAuthPath,
			configPath: openCodeConfigPath,
			env: process.env,
			home: HOME,
			dryRun: rawArgs.includes("--dry-run"),
		}), null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
	process.exit(process.exitCode || 0);
}
if (rawArgs.includes("--ask")) { console.error("Ask mode was removed. Use --plan for read-only planning."); process.exit(1); }
if (rawArgs.includes("--tsukuyomi-version") || rawArgs[0] === "-V") {
	printBanner();
	process.exit(0);
}

const piBin = findPi({ root: ROOT, home: HOME });
if (!piBin) {
	console.error("Tsukuyomi: could not find the bundled PI kernel.");
	console.error("Reinstall Tsukuyomi (npm install -g --ignore-scripts tsukuyomi) to restore it,");
	console.error("or point TSUKUYOMI_PI at an existing PI installation.");
	process.exit(1);
}

if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
	printBanner();
	console.log("Usage: tsukuyomi [--workspace <directory>] [--language en|zh] [PI options]");
	console.log("       tsukuyomi <directory> [PI options]");
	console.log("       tsukuyomi --plan     start in Plan mode");
	console.log("       tsukuyomi --migrate [--dry-run] [--migrate-from <agent-directory>]");
	console.log("       tsukuyomi --migrate-opencode [--dry-run] [--opencode-auth <file>] [--opencode-config <file>]");
	console.log("       tsukuyomi --fix-path  remove ~/.local/bin/tsukuyomi if it shadows the package");
	console.log("       tsukuyomi --language zh  start with Chinese UI");
	console.log("");
	console.log("Default OMP shortcuts (switch to legacy in /settings):");
	console.log("  ctrl+p/ctrl+shift+p  cycle models   alt+m   model picker");
	console.log("  alt+shift+p  toggle Build/Plan     shift+tab  cycle thinking");
	console.log("  ctrl+o  expand tools   ctrl+t  toggle thinking   alt+a  Agent Hub");
	console.log("  ctrl+q/ctrl+enter  queue follow-up   ctrl+b files   ctrl+s sessions");
	console.log("  --ask was removed; use --plan. Legacy preset keeps the old palette/panel keys.");
	console.log("  /skill     view and enable/disable Tsukuyomi skills");
	console.log("  /tools     toggle agent tools       wheel   scroll the panel under the pointer");
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

// Pi's project-local `.pi` resources are a separate configuration authority.
// Keep them out of the Tsukuyomi default; users can explicitly opt in with
// `--approve` when they deliberately want project-local Pi configuration.
if (!args.includes("--approve") && !args.includes("--no-approve")) args.push("--no-approve");

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.error("Tsukuyomi: the independent TUI requires an interactive terminal.");
	process.exit(1);
}

bootstrap();
// Skill discovery and enablement are Tsukuyomi-owned.  PI receives only this
// resolved snapshot and never gets to consult an ambient skill root.
args = applyManagedSkillArgs(args, AGENT_DIR);

const env = {
	...process.env,
	// Proxy variables plus NODE_OPTIONS=--require <curl-fetch hook> for the kernel.
	...networkEnvForChild(network),
	PI_CODING_AGENT_DIR: AGENT_DIR,
	TSUKUYOMI_DIR: AGENT_DIR,
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
			if (result.restart === "update") {
				workspacePool.remove(launchCwd);
				const restarted = spawnSync(process.execPath, [process.argv[1], ...launchArgs], { stdio: "inherit", env: process.env });
				process.exitCode = restarted.status === null ? 1 : restarted.status;
				break;
			}
			if (result.restart === "skills") {
				// Skill flags are startup configuration. Recreate the kernel so the
				// resource loader cannot retain a stale system-prompt skill list.
				workspacePool.remove(launchCwd);
				args = applyManagedSkillArgs(sessionlessArgs(args), AGENT_DIR);
				if (result.session) args.push("--session", result.session);
				continue;
			}
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
