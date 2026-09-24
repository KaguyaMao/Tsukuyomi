import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyManagedSkillArgs,
	discoverSkills,
	loadSkillSettings,
	managedSkillArgs,
	saveSkillSettings,
	skillsConfigPath,
} from "../app/skills.mjs";

function skill(root, name, description = `${name} description`) {
	const directory = join(root, "skills", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

test("Tsukuyomi discovers canonical skills and passes only enabled skills to PI", () => {
	const root = mkdtempSync(join(tmpdir(), "tsukuyomi-skills-"));
	skill(root, "alpha");
	skill(root, "beta");
	assert.deepEqual(discoverSkills(root).skills.map((item) => item.name), ["alpha", "beta"]);
	assert.deepEqual(managedSkillArgs(root), [
		"--no-skills",
		"--skill", join(root, "skills", "alpha", "SKILL.md"),
		"--skill", join(root, "skills", "beta", "SKILL.md"),
	]);
	assert.deepEqual(applyManagedSkillArgs(["--model", "demo", "--skill", "/outside", "--no-skills"], root), [
		"--model", "demo", "--no-skills",
		"--skill", join(root, "skills", "alpha", "SKILL.md"),
		"--skill", join(root, "skills", "beta", "SKILL.md"),
	]);
});

test("skill enablement is persisted in Tsukuyomi's own config file", () => {
	const root = mkdtempSync(join(tmpdir(), "tsukuyomi-skills-"));
	skill(root, "alpha");
	skill(root, "beta");
	assert.equal(saveSkillSettings(root, { disabled: ["beta", "beta"] }), true);
	assert.deepEqual(loadSkillSettings(root), { version: 1, disabled: ["beta"] });
	assert.equal(statSync(skillsConfigPath(root)).mode & 0o777, 0o600);
	assert.deepEqual(managedSkillArgs(root), [
		"--no-skills",
		"--skill", join(root, "skills", "alpha", "SKILL.md"),
	]);
	assert.equal(existsSync(join(root, "skills", "beta", "SKILL.md")), true);
	assert.match(readFileSync(skillsConfigPath(root), "utf8"), /beta/);
});
