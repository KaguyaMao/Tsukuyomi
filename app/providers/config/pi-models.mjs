/**
 * Read/write PI's `models.json` (JSONC).
 *
 * PI's `ModelConfig` loads `{ providers: { <id>: {...} } }` and composes custom
 * providers on top of built-ins. Tsukuyomi treats `providers.json` as the
 * primary source of truth but still writes this file because the PI kernel is
 * what actually talks to models, and it accepts comment-preserving JSONC.
 *
 * Unknown top-level keys and unknown provider fields are preserved: this module
 * edits one provider at a time and never rewrites the file into a lossy shape.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authError, AuthErrorCode } from "../errors.mjs";
import { parseJsonc } from "./jsonc.mjs";

export const MODELS_FILE = "models.json";
const FILE_MODE = 0o600;

/** Path of PI's models.json inside an agent directory. */
export function modelsJsonPath(agentDir) {
	if (!agentDir) throw new TypeError("modelsJsonPath requires an agent directory");
	return join(agentDir, MODELS_FILE);
}

/** Load models.json. Missing file yields an empty `{providers:{}}`. */
export function loadModelsJson(agentDir) {
	const path = modelsJsonPath(agentDir);
	if (!existsSync(path)) return { config: { providers: {} }, path, error: undefined };
	let parsed;
	try {
		parsed = parseJsonc(readFileSync(path, "utf8"));
	} catch (error) {
		return { config: { providers: {} }, path, error: `Failed to parse models.json: ${error.message}` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { config: { providers: {} }, path, error: "Invalid models.json: expected an object" };
	}
	const providers = parsed.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)
		? parsed.providers
		: {};
	return { config: { ...parsed, providers }, path, error: undefined };
}

/** Raw provider config map from models.json. */
export function listModelsProviders(agentDir) {
	const { config, path, error } = loadModelsJson(agentDir);
	return { providers: config.providers || {}, path, error };
}

function write(agentDir, config) {
	const path = modelsJsonPath(agentDir);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: FILE_MODE });
	try {
		chmodSync(temp, FILE_MODE);
	} catch {
		// best effort
	}
	renameSync(temp, path);
	return config;
}

/** Insert or replace one provider entry. Refuses to clobber an invalid file. */
export function upsertModelsProvider(agentDir, providerId, providerConfig) {
	const loaded = loadModelsJson(agentDir);
	if (loaded.error) throw authError(AuthErrorCode.CONFIG, `${loaded.error}; refusing to overwrite.`);
	const providers = { ...(loaded.config.providers || {}), [providerId]: providerConfig };
	return write(agentDir, { ...loaded.config, providers });
}

/** Remove one provider entry. */
export function removeModelsProvider(agentDir, providerId) {
	const loaded = loadModelsJson(agentDir);
	if (loaded.error) throw authError(AuthErrorCode.CONFIG, `${loaded.error}; refusing to overwrite.`);
	const providers = { ...(loaded.config.providers || {}) };
	delete providers[providerId];
	return write(agentDir, { ...loaded.config, providers });
}

/** Overwrite the `providers` map, preserving other top-level keys. */
export function replaceModelsProviders(agentDir, providers) {
	const loaded = loadModelsJson(agentDir);
	if (loaded.error) throw authError(AuthErrorCode.CONFIG, `${loaded.error}; refusing to overwrite.`);
	return write(agentDir, { ...loaded.config, providers: { ...providers } });
}
