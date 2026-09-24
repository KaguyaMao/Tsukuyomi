import { test } from "node:test";
import assert from "node:assert/strict";
import { applySourceUpdate, checkForUpdates, formatUpdateDetails, isSourcePath, parseGitHubRemote } from "../app/updater.mjs";

test("parseGitHubRemote accepts common GitHub remote formats", () => {
	assert.deepEqual(parseGitHubRemote("https://github.com/KaguyaMao/Tsukuyomi.git"), { owner: "KaguyaMao", repo: "Tsukuyomi" });
	assert.deepEqual(parseGitHubRemote("git@github.com:KaguyaMao/Tsukuyomi.git"), { owner: "KaguyaMao", repo: "Tsukuyomi" });
	assert.deepEqual(parseGitHubRemote("ssh://git@github.com/KaguyaMao/Tsukuyomi.git"), { owner: "KaguyaMao", repo: "Tsukuyomi" });
	assert.equal(parseGitHubRemote("https://gitlab.com/KaguyaMao/Tsukuyomi.git"), undefined);
});

test("isSourcePath only selects runtime source and package manifests", () => {
	assert.equal(isSourcePath("app/tui.mjs"), true);
	assert.equal(isSourcePath("src/backend.ts"), true);
	assert.equal(isSourcePath("bin/tsukuyomi.mjs"), true);
	assert.equal(isSourcePath("package-lock.json"), true);
	assert.equal(isSourcePath("README.md"), false);
	assert.equal(isSourcePath("docs/PROVIDERS.md"), false);
});

test("checkForUpdates reports source commits and ignores documentation-only changes", async () => {
	const root = process.cwd();
	const git = async (args) => {
		const command = args.join(" ");
		if (command === "rev-parse --show-toplevel") return `${root}\n`;
		if (command === "remote get-url origin") return "https://github.com/KaguyaMao/Tsukuyomi.git\n";
		if (command === "rev-parse HEAD") return "a".repeat(40) + "\n";
		if (command.startsWith("status --porcelain")) return "";
		throw new Error(`unexpected git command: ${command}`);
	};
	const fetchImpl = async (url) => {
		if (url.endsWith("/repos/KaguyaMao/Tsukuyomi")) return Response.json({ default_branch: "main" });
		return Response.json({
			ahead_by: 2,
			behind_by: 0,
			head_commit: { sha: "c".repeat(40) },
			commits: [
				{ sha: "b".repeat(40), commit: { message: "Older source change\n\nDetails", author: { date: "2026-09-15T00:00:00Z" } } },
				{ sha: "c".repeat(40), commit: { message: "Latest source change", author: { date: "2026-09-16T00:00:00Z" } } },
			],
			files: [{ filename: "README.md" }, { filename: "app/tui.mjs" }, { filename: "src/backend.ts" }],
		});
	};
	const result = await checkForUpdates({ root, git, fetchImpl });
	assert.equal(result.available, true);
	assert.equal(result.repository, "KaguyaMao/Tsukuyomi");
	assert.deepEqual(result.sourceFiles, ["app/tui.mjs", "src/backend.ts"]);
	assert.equal(result.canUpdate, true);
	const message = formatUpdateDetails(result, { locale: "zh" });
	assert.match(message, /Latest commits|最新 commits/);
	assert.match(message, /Latest source change|最新源代码变更/);
});

test("applySourceUpdate fast-forwards clean source and refreshes changed dependencies", async () => {
	const calls = [];
	let headReads = 0;
	const git = async (args) => {
		calls.push(args);
		const command = args.join(" ");
		if (command.startsWith("status --porcelain")) return "";
		if (command === "branch --show-current") return "main\n";
		if (command === "rev-parse HEAD") return `${headReads++ ? "b" : "a"}`.repeat(40) + "\n";
		if (command.startsWith("pull --ff-only")) return "Fast-forward\n";
		if (command.startsWith("diff --name-only")) return "app/tui.mjs\npackage-lock.json\n";
		throw new Error(`unexpected git command: ${command}`);
	};
	let command;
	const result = await applySourceUpdate({
		root: process.cwd(),
		update: { supported: true, available: true, branch: "main" },
		git,
		runCommand: async (...args) => { command = args; },
	});
	assert.equal(result.updated, true);
	assert.equal(result.before, "a".repeat(40));
	assert.equal(result.after, "b".repeat(40));
	assert.equal(command[0], "npm");
	assert.deepEqual(command[1], ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
	assert.equal(calls.some((args) => args[0] === "pull"), true);
});
