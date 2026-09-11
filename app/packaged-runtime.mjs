import { existsSync, lstatSync, readlinkSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PACKAGED_ROOT = "/usr/lib/tsukuyomi";
export const PACKAGED_ENTRY = join(PACKAGED_ROOT, "bin/tsukuyomi.mjs");
export const PACKAGED_NODE = join(PACKAGED_ROOT, "runtime/bin/node");
export const PACKAGED_PI = join(PACKAGED_ROOT, "runtime/bin/pi");

export function userShadowPaths(home = homedir()) {
	return [join(home, ".local/bin/tsukuyomi"), join(home, "bin/tsukuyomi")];
}

function lstatOrNull(path) {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

export function isPackagedPath(path) {
	try {
		const resolved = realpathSync(path);
		return resolved === "/usr/bin/tsukuyomi" || resolved === PACKAGED_ROOT || resolved.startsWith(`${PACKAGED_ROOT}/`);
	} catch {
		return false;
	}
}

/** User-level launchers that would win over /usr/bin/tsukuyomi. */
export function planShadowFixes(home = homedir()) {
	const planned = [];
	for (const path of userShadowPaths(home)) {
		const stat = lstatOrNull(path);
		if (!stat) continue;
		if (isPackagedPath(path)) continue;
		planned.push({
			path,
			link: stat.isSymbolicLink() ? readlinkSync(path) : undefined,
		});
	}
	return planned;
}

export function removeUserShadows(home = homedir(), unlink = unlinkSync) {
	const removed = [];
	for (const shadow of planShadowFixes(home)) {
		unlink(shadow.path);
		removed.push(shadow);
	}
	return removed;
}

export function resolvePackagedExec({
	currentRoot,
	env = process.env,
	exists = existsSync,
} = {}) {
	if (env.TSUKUYOMI_USE_SOURCE === "1") return undefined;
	if (currentRoot === PACKAGED_ROOT) return undefined;
	if (!exists(PACKAGED_NODE) || !exists(PACKAGED_ENTRY)) return undefined;
	return {
		node: PACKAGED_NODE,
		entry: PACKAGED_ENTRY,
		env: {
			...env,
			TSUKUYOMI_PI: PACKAGED_PI,
			TSUKUYOMI_ROOT: PACKAGED_ROOT,
			NODE_PATH: join(PACKAGED_ROOT, "node_modules"),
			PATH: `${join(PACKAGED_ROOT, "runtime/bin")}:${env.PATH || ""}`,
		},
	};
}
