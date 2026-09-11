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

export function findPiRoot(piBin) {
	const resolved = realpathSync(piBin);
	let directory = dirname(resolved);
	for (;;) {
		// `pi-tui` is installed below the coding-agent package.  Returning that
		// package root preserves the path contract used by app/tui.mjs.
		if (existsSync(join(directory, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"))) return directory;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(`could not locate @earendil-works/pi-coding-agent for ${resolved}`);
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
