import { existsSync, mkdirSync, readFileSync, renameSync, chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

/**
 * Skill preferences are owned by Tsukuyomi.  PI only receives the already
 * resolved list of enabled SKILL.md files when its kernel is started.
 */
export const SKILLS_CONFIG_FILE = "tsukuyomi-skills.json";

export function skillsConfigPath(agentDir) {
	return join(agentDir || ".", SKILLS_CONFIG_FILE);
}

function normalizeDisabled(value) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim()))].sort();
}

export function loadSkillSettings(agentDir) {
	try {
		const value = JSON.parse(readFileSync(skillsConfigPath(agentDir), "utf8"));
		return { version: 1, disabled: normalizeDisabled(value?.disabled) };
	} catch {
		return { version: 1, disabled: [] };
	}
}

export function saveSkillSettings(agentDir, updates = {}) {
	if (!agentDir) return false;
	const current = loadSkillSettings(agentDir);
	const next = {
		version: 1,
		disabled: normalizeDisabled(updates.disabled === undefined ? current.disabled : updates.disabled),
	};
	const path = skillsConfigPath(agentDir);
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
		return true;
	} catch {
		try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
		return false;
	}
}

/** Discover only skills in Tsukuyomi's canonical, user-owned skill root. */
export function discoverSkills(agentDir) {
	const directory = join(agentDir || ".", "skills");
	const result = loadSkillsFromDir({ dir: directory, source: "user" });
	return {
		skills: result.skills.map((skill) => ({
			...skill,
			name: String(skill.name),
			filePath: skill.filePath,
			baseDir: skill.baseDir || dirname(skill.filePath),
		})),
		diagnostics: result.diagnostics || [],
	};
}

export function enabledSkillNames(agentDir, skills = discoverSkills(agentDir).skills) {
	const disabled = new Set(loadSkillSettings(agentDir).disabled);
	return skills.filter((skill) => !disabled.has(skill.name)).map((skill) => skill.name);
}

/**
 * Convert Tsukuyomi's skill state into PI CLI arguments. `--no-skills` is
 * intentional: it prevents PI's ambient ~/.pi and ~/.agents roots, project
 * resources, or PI settings from changing the effective skill set.
 */
export function managedSkillArgs(agentDir, skills = discoverSkills(agentDir).skills) {
	const disabled = new Set(loadSkillSettings(agentDir).disabled);
	const args = ["--no-skills"];
	for (const skill of skills) {
		if (disabled.has(skill.name)) continue;
		args.push("--skill", skill.filePath);
	}
	return args;
}

/** Remove user-provided PI skill flags so Tsukuyomi remains the sole authority. */
export function applyManagedSkillArgs(args, agentDir) {
	const cleaned = [];
	for (let index = 0; index < (args || []).length; index++) {
		const arg = args[index];
		if (arg === "--skill") {
			if (args[index + 1] && !args[index + 1].startsWith("-")) index++;
			continue;
		}
		if (arg === "--no-skills" || arg === "-ns" || arg.startsWith("--skill=")) continue;
		cleaned.push(arg);
	}
	return [...cleaned, ...managedSkillArgs(agentDir)];
}
