import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_TUI_RELATIVE = ["@earendil-works", "pi-tui", "dist", "index.js"];

/** Resolve a module specifier with ESM conditions, or undefined when absent. */
function tryResolve(specifier) {
	try {
		return fileURLToPath(import.meta.resolve(specifier));
	} catch {
		return undefined;
	}
}

/**
 * Root of the PI kernel bundled with this install.
 *
 * Tsukuyomi declares `@earendil-works/pi-coding-agent` as a normal dependency, so
 * Node's own resolution finds the exact copy npm installed (works with hoisting
 * and on Windows). This is what makes the kernel self-contained: no separate
 * `pi` on PATH is required.
 */
export function bundledPiRoot() {
	const index = tryResolve(PI_PACKAGE);
	if (!index) return undefined;
	// `dist/index.js` -> package root.
	const directory = dirname(dirname(index));
	return existsSync(join(directory, "dist", "index.js")) ? directory : undefined;
}

/** The kernel CLI entry (`package.json#bin.pi`) inside the bundled package. */
export function bundledPiEntry() {
	const directory = bundledPiRoot();
	if (!directory) return undefined;
	const cli = join(directory, "dist", "bundle", "cli.js");
	return existsSync(cli) ? cli : undefined;
}

/** Walk `node_modules` ancestors from `start`; npm may hoist dependencies. */
function findInAncestors(start, relative) {
	let directory = start;
	for (;;) {
		const candidate = join(directory, "node_modules", ...relative);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function pathSegments() {
	return (process.env.PATH || "").split(delimiter).filter(Boolean);
}

/** CLI entry for a global npm prefix directory (its `node_modules`). */
function globalPiCli(baseDir) {
	return join(baseDir, "node_modules", ...PI_PACKAGE.split("/"), "dist", "bundle", "cli.js");
}

/**
 * Locate the PI runtime, preferring the kernel bundled with this install.
 *
 * Order: packaged snapshot -> explicit override -> bundled dependency -> global
 * npm installs -> PATH. The RPC kernel is still a separate process; only the
 * lookup changed so distributions no longer depend on a system `pi`.
 */
export function findPi({ root = process.cwd(), home = process.env.HOME || "" } = {}) {
	const packaged = join(root, "runtime", "bin", "pi");
	if (existsSync(packaged)) return packaged;
	const explicit = process.env.TSUKUYOMI_PI || process.env.KAGUYAPI_PI;
	if (explicit && existsSync(explicit)) return explicit;
	const bundled = bundledPiEntry();
	if (bundled) return bundled;
	const win = process.platform === "win32";
	const winGlobalDirs = [
		process.env.APPDATA && join(process.env.APPDATA, "npm"),
		join(home, "AppData", "Roaming", "npm"),
		join(home, "AppData", "Local", "npm"),
	].filter(Boolean);
	const candidates = [
		join(root, "node_modules", ".bin", "pi"),
		...(win ? winGlobalDirs.flatMap((dir) => [globalPiCli(dir), join(dir, "pi.cmd")]) : []),
		join(home, ".local/share/pi-node/node-v22.23.2-linux-x64/bin/pi"),
		join(home, ".local/bin/pi"), "/usr/local/bin/pi",
		...pathSegments().flatMap((dir) => win ? [globalPiCli(dir), join(dir, "pi.cmd"), join(dir, "pi")] : [join(dir, "pi")]),
	];
	return candidates.find((candidate) => existsSync(candidate)) || null;
}

/**
 * Locate the PI package root (the directory that owns `dist/index.js` and a
 * `pi-tui`).
 *
 * When `piBin` is the bundled kernel this is its dependency directory. Otherwise
 * `realpath(piBin)` alone is not enough: `pi` is often a shell wrapper that
 * execs the real CLI, and walking up from a wrapper in `$HOME` finds nothing. So
 * prefer the resolved bundled package, then the app's own `node_modules`, then
 * walk up from the real binary, then well-known global install roots.
 */
export function findPiRoot(piBin, { appRoot } = {}) {
	const bundled = bundledPiRoot();
	if (bundled && piBin) {
		try {
			const real = realpathSync(piBin);
			if (real === join(bundled, "dist", "index.js") || real.startsWith(`${bundled}/`)) return bundled;
		} catch {
			// A missing/broken `pi` is reported by findPi(); keep looking elsewhere.
		}
	}
	const packaged = (dir) => existsSync(join(dir, "dist", "index.js"));
	const hasTui = (dir) => Boolean(findInAncestors(dir, PI_TUI_RELATIVE));
	const candidates = [];
	if (appRoot) {
		candidates.push(join(appRoot, "node_modules", ...PI_PACKAGE.split("/")));
		candidates.push(join(appRoot, "runtime", "lib", "node_modules", ...PI_PACKAGE.split("/")));
	}
	try {
		let directory = dirname(realpathSync(piBin));
		for (;;) {
			if (packaged(directory) && hasTui(directory)) {
				candidates.push(directory);
				break;
			}
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	} catch {
		// A missing/broken `pi` is reported by findPi(); keep looking elsewhere.
	}
	candidates.push(
		"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
	);
	const resolved = candidates.find((candidate) => packaged(candidate) && hasTui(candidate))
		?? candidates.find((candidate) => packaged(candidate));
	if (resolved) return resolved;
	throw new Error(`could not locate ${PI_PACKAGE} for ${piBin}`);
}

/**
 * Resolve pi-tui from the app's own dependency tree first so a packaged or
 * hoisted install never depends on a Pi tree in $HOME.
 */
export function resolvePiTui({ appRoot, piRoot } = {}) {
	const candidates = [
		appRoot && join(appRoot, "node_modules", ...PI_TUI_RELATIVE),
		appRoot && join(appRoot, "node_modules", ...PI_PACKAGE.split("/"), "node_modules", ...PI_TUI_RELATIVE),
		appRoot && join(appRoot, "runtime", "lib", "node_modules", ...PI_PACKAGE.split("/"), "node_modules", ...PI_TUI_RELATIVE),
		piRoot && join(piRoot, "node_modules", ...PI_TUI_RELATIVE),
		piRoot && join(piRoot, "node_modules", ...PI_PACKAGE.split("/"), "node_modules", ...PI_TUI_RELATIVE),
	].filter(Boolean);
	const found = candidates.find((candidate) => existsSync(candidate))
		?? (piRoot && findInAncestors(piRoot, PI_TUI_RELATIVE))
		?? (appRoot && findInAncestors(appRoot, PI_TUI_RELATIVE))
		?? tryResolve("@earendil-works/pi-tui");
	if (found) return realpathSync(found);
	throw new Error(`Cannot find @earendil-works/pi-tui. Looked in:\n${candidates.map((candidate) => `  ${candidate}`).join("\n")}`);
}

/** Import PI from the installation that owns the running kernel. */
export async function loadPiRuntime(piRoot) {
	const localEntry = join(piRoot, "dist", "index.js");
	const entry = existsSync(localEntry)
		? localEntry
		: join(piRoot, "node_modules", ...PI_PACKAGE.split("/"), "dist", "index.js");
	try {
		return await import(pathToFileURL(entry).href);
	} catch (primary) {
		try { return await import(PI_PACKAGE); }
		catch { throw new Error(`Unable to load PI runtime: ${primary instanceof Error ? primary.message : String(primary)}`); }
	}
}
