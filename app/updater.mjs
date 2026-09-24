import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { createProxyAwareFetch } from "./http.mjs";

const execFileAsync = promisify(execFile);
const SOURCE_ROOTS = ["app/", "bin/", "src/"];
const PACKAGE_FILES = new Set(["package.json", "package-lock.json"]);
const DEFAULT_BRANCH = "main";

function cleanText(value) {
	return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function shortSha(value) {
	return String(value || "").slice(0, 8);
}

function defaultGit(root, env = process.env) {
	return async (args, options = {}) => {
		const result = await execFileAsync("git", args, {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
			timeout: options.timeoutMs || 30_000,
			env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
		});
		return result.stdout;
	};
}

function defaultCommand(root, env = process.env) {
	return async (command, args, options = {}) => {
		const result = await execFileAsync(command, args, {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
			timeout: options.timeoutMs || 5 * 60_000,
			env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
		});
		return result.stdout;
	};
}

/** Parse HTTPS, SSH, and scp-style GitHub remotes into an API repository. */
export function parseGitHubRemote(remote) {
	const value = String(remote || "").trim().replace(/\.git$/, "");
	if (!value) return undefined;
	let path;
	try {
		const url = new URL(value);
		if (url.hostname.toLowerCase() !== "github.com") return undefined;
		path = url.pathname;
	} catch {
		const match = value.match(/^(?:[^@]+@)?github\.com:(.+)$/i);
		if (!match) return undefined;
		path = `/${match[1]}`;
	}
	const parts = path.split("/").filter(Boolean);
	if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
	return { owner: decodeURIComponent(parts[0]), repo: decodeURIComponent(parts[1]) };
}

/** Files which should trigger the source-update prompt. */
export function isSourcePath(filename) {
	const path = String(filename || "").replace(/^\.\//, "");
	return SOURCE_ROOTS.some((root) => path.startsWith(root)) || PACKAGE_FILES.has(path);
}

async function fetchJson(fetchImpl, url, { signal } = {}) {
	const response = await fetchImpl(url, {
		signal,
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "Tsukuyomi-update-check",
		},
	});
	if (!response?.ok) {
		const error = new Error(`GitHub returned HTTP ${response?.status || "?"}`);
		error.status = response?.status;
		throw error;
	}
	return response.json();
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs = 15_000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchJson(fetchImpl, url, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Check the current source checkout against its GitHub origin.
 * No local files are changed by this function.
 */
export async function checkForUpdates({ root, env = process.env, fetchImpl, git } = {}) {
	if (env.TSUKUYOMI_UPDATE_CHECK === "0") return { supported: false, disabled: true, available: false };
	if (!root) return { supported: false, available: false };
	const runGit = git || defaultGit(root, env);
	let remote;
	let localSha;
	let dirty;
	try {
		const top = (await runGit(["rev-parse", "--show-toplevel"])).trim();
		if (resolve(top) !== resolve(root)) return { supported: false, available: false };
		remote = (await runGit(["remote", "get-url", "origin"])).trim();
		localSha = (await runGit(["rev-parse", "HEAD"])).trim();
		dirty = Boolean((await runGit(["status", "--porcelain", "--untracked-files=all"])).trim());
	} catch {
		return { supported: false, available: false };
	}

	const override = parseGitHubRemote(env.TSUKUYOMI_UPDATE_REPO);
	const repository = override || parseGitHubRemote(remote);
	if (!repository || !localSha) return { supported: false, available: false };
	const fetcher = fetchImpl || createProxyAwareFetch({ env });
	const apiRoot = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
	const repositoryInfo = await fetchWithTimeout(fetcher, apiRoot);
	const branch = env.TSUKUYOMI_UPDATE_BRANCH || repositoryInfo.default_branch || DEFAULT_BRANCH;
	const compare = await fetchWithTimeout(fetcher, `${apiRoot}/compare/${encodeURIComponent(localSha)}...${encodeURIComponent(branch)}`);
	const files = Array.isArray(compare.files) ? compare.files : [];
	const sourceFiles = files
		.map((file) => cleanText(file?.filename))
		.filter(isSourcePath);
	const aheadBy = Number(compare.ahead_by) || 0;
	const behindBy = Number(compare.behind_by) || 0;
	return {
		supported: true,
		available: aheadBy > 0 && sourceFiles.length > 0,
		canUpdate: !dirty,
		dirty,
		repository: `${repository.owner}/${repository.repo}`,
		branch,
		localSha,
		remoteSha: compare.head_commit?.sha || "",
		aheadBy,
		behindBy,
		commits: Array.isArray(compare.commits) ? compare.commits : [],
		sourceFiles,
	};
}

/** Format the latest commit subjects/bodies for the confirmation dialog. */
export function formatUpdateDetails(details, { locale = "en", maxCommits = 4, maxFiles = 8 } = {}) {
	const zh = locale === "zh";
	const commits = (details?.commits || []).slice(-maxCommits).reverse();
	const files = [...new Set(details?.sourceFiles || [])];
	const lines = [
		zh
			? `远程源代码有 ${details?.aheadBy || commits.length || 0} 个新提交：${details?.repository || "GitHub"}/${details?.branch || DEFAULT_BRANCH}`
			: `${details?.aheadBy || commits.length || 0} new source commits on ${details?.repository || "GitHub"}/${details?.branch || DEFAULT_BRANCH}`,
		zh ? `本地 ${shortSha(details?.localSha)} → 远程 ${shortSha(details?.remoteSha)}` : `Local ${shortSha(details?.localSha)} → remote ${shortSha(details?.remoteSha)}`,
		"",
		zh ? "最新 commits：" : "Latest commits:",
	];
	for (const commit of commits) {
		const message = cleanText(commit?.commit?.message || commit?.message || "(no commit message)");
		const date = cleanText(commit?.commit?.author?.date || commit?.commit?.committer?.date || "").slice(0, 10);
		lines.push(`${shortSha(commit?.sha)}${date ? ` ${date}` : ""} ${message.slice(0, 220)}`);
	}
	if (!commits.length) lines.push(zh ? "（提交内容不可用）" : "(commit details unavailable)");
	lines.push("", zh ? `变更源文件（${files.length}）：${files.slice(0, maxFiles).join(", ")}` : `Changed source files (${files.length}): ${files.slice(0, maxFiles).join(", ")}`);
	if (files.length > maxFiles) lines.push(zh ? `以及另外 ${files.length - maxFiles} 个文件` : `and ${files.length - maxFiles} more files`);
	if (details?.dirty) lines.push("", zh ? "工作区存在本地改动，确认更新前必须先提交或清理。" : "The working tree has local changes; commit or clean them before updating.");
	return lines.join("\n");
}

/** Fast-forward the checkout and refresh dependencies if manifests changed. */
export async function applySourceUpdate({ root, update, env = process.env, git, runCommand } = {}) {
	if (!root || !update?.supported || !update?.available) return { updated: false };
	const runGit = git || defaultGit(root, env);
	const run = runCommand || defaultCommand(root, env);
	const dirty = (await runGit(["status", "--porcelain", "--untracked-files=all"])).trim();
	if (dirty) throw new Error("The working tree has local changes; automatic update was cancelled.");
	const branch = (await runGit(["branch", "--show-current"])).trim();
	if (branch !== update.branch) throw new Error(`Current branch is ${branch || "detached HEAD"}; update requires ${update.branch}.`);
	const before = (await runGit(["rev-parse", "HEAD"])).trim();
	await runGit(["pull", "--ff-only", "origin", update.branch], { timeoutMs: 120_000 });
	const after = (await runGit(["rev-parse", "HEAD"])).trim();
	if (!after || after === before) return { updated: false };
	const changed = (await runGit(["diff", "--name-only", `${before}..${after}`]))
		.split("\n").map((path) => path.trim()).filter(Boolean);
	if (changed.includes("package.json") || changed.includes("package-lock.json")) {
		await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { timeoutMs: 5 * 60_000, env });
	}
	return { updated: true, before, after, changed };
}
