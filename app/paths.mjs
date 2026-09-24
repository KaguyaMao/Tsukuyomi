import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Tsukuyomi owns the runtime configuration root; Pi only consumes it. */
export function resolveAgentDir({ env = process.env, home = homedir(), cwd = process.cwd() } = {}) {
	const configured = env.TSUKUYOMI_DIR?.trim();
	if (!configured) return join(home, ".tsukuyomi", "agent");
	const expanded = configured === "~" ? home : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
	return resolve(cwd, expanded);
}

/** Legacy stores are import sources only, never active configuration roots. */
export function legacyAgentDirs({ env = process.env, home = homedir(), target } = {}) {
	const values = [
		env.PI_CODING_AGENT_DIR,
		env.KAGUYAPI_DIR,
		join(home, ".pi", "agent"),
		join(home, ".kaguyapi", "agent"),
	];
	const expand = (value) => value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
	const resolvedTarget = target ? resolve(expand(target)) : undefined;
	return [...new Set(values.filter(Boolean).map((value) => resolve(expand(value))).filter((value) => value !== resolvedTarget))];
}
