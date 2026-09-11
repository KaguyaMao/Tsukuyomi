import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Current preferences file; the legacy name is read once for migration. */
export const PREFERENCES_FILE = "tsukuyomi.json";
/** Previous name, kept readable so an in-place config dir keeps working. */
export const LEGACY_PREFERENCES_FILE = "kaguya.json";

export function preferencesPath(agentDir) {
	return join(agentDir || ".", PREFERENCES_FILE);
}

/** Legacy path, or undefined when `agentDir` is unknown. */
export function legacyPreferencesPath(agentDir) {
	return agentDir ? join(agentDir, LEGACY_PREFERENCES_FILE) : undefined;
}

function readJson(path) {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function loadPreferences(agentDir) {
	return readJson(preferencesPath(agentDir)) ?? readJson(legacyPreferencesPath(agentDir)) ?? {};
}

export function savePreferences(agentDir, updates) {
	if (!agentDir || !updates || typeof updates !== "object") return false;
	const current = loadPreferences(agentDir);
	const next = { ...current, ...updates };
	try {
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		writeFileSync(preferencesPath(agentDir), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}
