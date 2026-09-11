import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Locate the PI executable, preferring a package-bundled runtime when present. */
export function findPi({ root = process.cwd(), home = process.env.HOME || "" } = {}) {
	const bundled = join(root, "runtime", "bin", "pi");
	if (existsSync(bundled)) return bundled;
	const explicit = process.env.TSUKUYOMI_PI || process.env.KAGUYAPI_PI;
	if (explicit && existsSync(explicit)) return explicit;
	const candidates = [
		join(root, "node_modules", ".bin", "pi"),
		join(home, ".local/share/pi-node/node-v22.23.2-linux-x64/bin/pi"),
		join(home, ".local/bin/pi"), "/usr/local/bin/pi",
		...(process.env.PATH || "").split(":").filter(Boolean).map((dir) => join(dir, "pi")),
	];
	return candidates.find((candidate) => existsSync(candidate)) || null;
}

/**
 * Locate the PI package root (the directory that owns `dist/index.js` and a
 * nested `@earendil-works/pi-tui`).
 *
 * `realpath(piBin)` alone is not enough: `pi` is often a shell wrapper
 * (`~/.local/bin/pi`) that execs the real CLI, and walking up from a wrapper in
 * `$HOME` finds nothing. So prefer the app's own node_modules, then walk up
 * from the real binary, then fall back to well-known global install roots.
 */
export function findPiRoot(piBin, { appRoot } = {}) {
	const packaged = (dir) => existsSync(join(dir, "dist", "index.js"));
	const hasTui = (dir) => existsSync(join(dir, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"));
	const candidates = [];
	if (appRoot) {
		candidates.push(join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent"));
		candidates.push(join(appRoot, "runtime", "lib", "node_modules", "@earendil-works", "pi-coding-agent"));
	}
	try {
		let directory = dirname(realpathSync(piBin));
		for (;;) {
			if (hasTui(directory)) {
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
	throw new Error(`could not locate @earendil-works/pi-coding-agent for ${piBin}`);
}

/**
 * Resolve pi-tui from the app's own node_modules first so a packaged install
 * never depends on a Pi tree in $HOME.
 */
export function resolvePiTui({ appRoot, piRoot } = {}) {
	const candidates = [
		appRoot && join(appRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
		appRoot && join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
		appRoot && join(appRoot, "runtime", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
		piRoot && join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
	].filter(Boolean);
	const found = candidates.find((candidate) => existsSync(candidate));
	if (found) return realpathSync(found);
	throw new Error(`Cannot find @earendil-works/pi-tui. Looked in:\n${candidates.map((candidate) => `  ${candidate}`).join("\n")}`);
}

/** Import PI from the installation that owns the running `pi` binary. */
export async function loadPiRuntime(piRoot) {
	const localEntry = join(piRoot, "dist", "index.js");
	const entry = existsSync(localEntry)
		? localEntry
		: join(piRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
	try {
		return await import(pathToFileURL(entry).href);
	} catch (primary) {
		try { return await import("@earendil-works/pi-coding-agent"); }
		catch { throw new Error(`Unable to load PI runtime: ${primary instanceof Error ? primary.message : String(primary)}`); }
	}
}
