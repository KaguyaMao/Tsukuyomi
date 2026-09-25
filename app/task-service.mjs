import { createServer } from "node:net";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync, chmodSync, copyFileSync, lstatSync, unlinkSync, rmdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pty from "node-pty";
import xterm from "@xterm/headless";
import { PiRpc } from "./rpc.mjs";
import { redactText } from "./redact.mjs";
import { materializeAccountRuntime } from "./providers/accounts.mjs";
import { readAuthStore, writeAuthStore } from "./providers/store.mjs";
import { TeamBroker } from "./team-broker.mjs";
import { resolveWorkerPolicy, workerMode } from "./team-policy.mjs";
import { managedSkillArgs } from "./skills.mjs";

const exec = promisify(execFile);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const git = async (cwd, args) => (await exec("git", args, { cwd, maxBuffer: 40 * 1024 * 1024 })).stdout;
const textOf = (m) => (m?.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
const toolHeading = (event) => {
	const args = event.args || {};
	const label = event.toolName === "bash" ? `$ ${args.command || ""}`
		: event.toolName === "web_search" ? `Web Search: ${args.query || ""}`
		: ["edit", "write"].includes(event.toolName) ? `Edit: ${args.path || args.file || ""}`
		: ["read", "view"].includes(event.toolName) ? `Read: ${args.path || args.file || ""}`
		: `${event.toolName || "Tool"}: ${args.path || args.query || args.action || ""}`;
	return label.slice(0, 240);
};
export function subagentsEnabled(agentDir) {
	for (const name of ["tsukuyomi-tools.json", "kaguya-tools.json"]) {
		try {
			const p = JSON.parse(readFileSync(join(agentDir, name), "utf8"));
			return p.subagents === true && !p.disabled?.includes("subagent");
		} catch {
			// try the legacy name, then report disabled
		}
	}
	return false;
}

/** Git worktree isolation needs a repository; shared-write can write the current workspace outside Git. */
export { workerMode };

export class TaskService {
	constructor({ agentDir, piBin, root }) {
		this.agentDir = agentDir; this.piBin = piBin; this.root = root; this.jobs = new Map(); this.clients = new Set(); this.queue = []; this.activeAgents = 0; this.stopping = false;
		this.controllerToken = randomBytes(32).toString("hex");
		this.broker = new TeamBroker({ getJob: (id) => this.jobs.get(id), publish: (event) => this.publishTeam(event), controllerToken: this.controllerToken });
	}
	async start() {
		this.directory = mkdtempSync(join(tmpdir(), "tsukuyomi-tasks-")); if (process.platform !== "win32") chmodSync(this.directory, 0o700);
		// AF_UNIX on Windows must be a named pipe, not a filesystem path.
		this.socketPath = process.platform === "win32"
			? `\\\\.\\pipe\\tsukuyomi-tasks-${randomBytes(16).toString("hex")}`
			: join(this.directory, "control.sock");
		this.token = randomBytes(32).toString("hex");
		this.server = createServer((socket) => {
			let buffer = ""; socket.setEncoding("utf8"); socket.on("error", () => {}); this.clients.add(socket);
			socket.on("close", () => this.clients.delete(socket));
			socket.on("data", (data) => {
				buffer += data; if (buffer.length > 2_000_000) { socket.destroy(); return; }
				for (;;) {
					const end = buffer.indexOf("\n"); if (end < 0) break;
					let message; try { message = JSON.parse(buffer.slice(0, end)); } catch { socket.destroy(); return; } buffer = buffer.slice(end + 1);
					if (message.token !== this.token) { socket.destroy(); return; }
					if (message.method === "subscribe") socket.subscribed = true;
					Promise.resolve().then(() => this.request(message.method, message.params || {})).then((result) => socket.write(`${JSON.stringify({ id: message.id, result })}\n`), (error) => socket.write(`${JSON.stringify({ id: message.id, error: redactText(error.message) })}\n`));
				}
			});
		});
		await new Promise((resolvePromise, reject) => { this.server.once("error", reject); this.server.listen(this.socketPath, resolvePromise); });
		if (process.platform !== "win32") chmodSync(this.socketPath, 0o600);
		this.policyTimer = setInterval(() => { if (!subagentsEnabled(this.agentDir)) this.cancelAgents(); }, 250); this.policyTimer.unref();
		return { TSUKUYOMI_TASK_SOCKET: this.socketPath, TSUKUYOMI_TASK_TOKEN: this.token, TSUKUYOMI_TASK_CONTROLLER_TOKEN: this.controllerToken };
	}
	snapshot(job) { return { id: job.id, kind: job.kind, cwd: job.ownerCwd || job.cwd, toolCallId: job.toolCallId, command: job.command, status: job.status, activity: job.activity || (job.status === "waiting" ? "waiting" : "working"), output: redactText(job.output), result: redactText(job.result || ""), screen: redactText(job.screen || ""), exitCode: job.exitCode, readonly: job.readonly, profile: job.profile, role: job.params?.role, isolation: job.isolation, sharedWrite: job.sharedWrite, worktree: job.worktree, patchPath: job.patchPath, logPath: job.logPath, accountRef: job.params?.accountRef || job.params?.accountId, teamId: job.params?.teamId, memberId: job.params?.memberId, startedAt: job.startedAt, endedAt: job.endedAt }; }
	publish(job) {
		if (job.timer) return;
		job.timer = setTimeout(() => { job.timer = undefined; const event = `${JSON.stringify({ event: "job", job: this.snapshot(job) })}\n`; for (const socket of this.clients) if (socket.subscribed && socket.writable && socket.writableLength < 2_000_000) socket.write(event); }, 80);
	}
	publishTeam(event) {
		const message = `${JSON.stringify({ event })}\n`;
		for (const socket of this.clients) if (socket.subscribed && socket.writable && socket.writableLength < 2_000_000) socket.write(message);
	}
	queueScreenSnapshot(job) {
		if (job.screenTimer) return;
		job.screenTimer = setTimeout(() => {
			job.screenTimer = undefined;
			const buffer = job.emulator.buffer.active;
			job.screen = Array.from({ length: job.emulator.rows }, (_unused, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) || "").join("\n");
			this.publish(job);
		}, 120);
	}
	create(params, kind) {
		const id = randomUUID(), directory = join(this.agentDir, "jobs", id); mkdirSync(directory, { recursive: true, mode: 0o700 });
		const job = { id, kind, cwd: realpathSync(params.cwd), toolCallId: params.toolCallId, command: params.command || params.task, status: "running", activity: "working", output: "", startedAt: Date.now(), directory, logPath: join(directory, "output.log"), params, capabilityToken: kind === "subagent" && params.teamId ? randomBytes(32).toString("hex") : undefined };
		writeFileSync(job.logPath, "", { mode: 0o600 }); this.jobs.set(id, job); this.persist(job); return job;
	}
	persist(job) { writeFileSync(join(job.directory, "job.json"), `${JSON.stringify(this.snapshot(job), null, 2)}\n`, { mode: 0o600 }); }
	output(job, text) { const safe = redactText(text); job.output = (job.output + safe).slice(-256_000); appendFileSync(job.logPath, safe); this.publish(job); }
	finish(job, code, error) {
		if (job.endedAt) return;
		if (job.leaseTimer) { clearInterval(job.leaseTimer); job.leaseTimer = undefined; }
		job.exitCode = code; job.endedAt = Date.now(); job.status = job.status === "cancelled" ? "cancelled" : code === 0 ? "done" : "error";
		this.broker.releaseJob(job);
		if (error) this.output(job, `\n${error}\n`); this.persist(job); this.publish(job);
	}
	cancel(job) {
		if (!job || job.endedAt) return;
		if (job.leaseTimer) { clearInterval(job.leaseTimer); job.leaseTimer = undefined; }
		job.status = "cancelled"; job.rpc?.stop(); job.terminal?.kill("SIGTERM");
		this.broker.releaseJob(job);
		if (job.terminal) setTimeout(() => { if (!job.endedAt) try { job.terminal.kill("SIGKILL"); } catch {} }, 500).unref();
		if (!job.terminal) this.finish(job, 130);
	}
	cancelAgents() { for (const job of this.jobs.values()) if (job.kind === "subagent") this.cancel(job); this.queue = []; }
	async request(method, params) {
		if (this.stopping) throw new Error("Task service is shutting down");
		if (method.startsWith("team.")) return this.broker.request(method, params || {});
		if (method === "subscribe" || method === "list") return [...this.jobs.values()].map((job) => this.snapshot(job));
		if (method === "policy") { if (!subagentsEnabled(this.agentDir)) this.cancelAgents(); return true; }
		if (method === "pty.start") {
			const job = this.create(params, "pty");
			job.emulator = new xterm.Terminal({ cols: params.cols || 90, rows: params.rows || 12, scrollback: 2000, allowProposedApi: true });
			const isWin = process.platform === "win32";
			const shell = isWin ? (process.env.ComSpec || "cmd.exe") : (process.env.SHELL || "/bin/bash");
			const shellArgs = isWin ? ["/d", "/s", "/c", params.command] : ["-c", params.command];
			job.terminal = pty.spawn(shell, shellArgs, { cwd: job.cwd, cols: params.cols || 90, rows: params.rows || 12, name: "xterm-256color", env: { ...process.env, TERM: "xterm-256color" } });
			job.terminal.onData((data) => { this.output(job, data); job.emulator.write(data, () => this.queueScreenSnapshot(job)); });
			job.terminal.onExit(({ exitCode }) => this.finish(job, exitCode)); this.publish(job); return this.snapshot(job);
		}
		if (method === "subagent.start") {
			if (!subagentsEnabled(this.agentDir)) throw new Error("Subagents are disabled. Enable subagent in /tools.");
			if (params.depth || [...this.jobs.values()].some((job) => job.worktree === params.cwd)) throw new Error("Recursive subagents are disabled");
			if (params.teamId && !params.memberId) throw new Error("Team workers require a member id");
			const job = this.create(params, "subagent"); this.broker.registerJob(job); job.status = "queued"; this.queue.push(job); this.drain(); return this.snapshot(job);
		}
		const job = this.jobs.get(params.id); if (!job) throw new Error("Unknown task");
		if (method === "get") return this.snapshot(job);
		if (method === "cancel") { this.cancel(job); return this.snapshot(job); }
		if (method === "input") { if (job.endedAt) throw new Error("Task already ended"); job.terminal?.write(String(params.data || "")); return true; }
		if (method === "resize") { const cols = Math.max(10, Math.min(500, params.cols | 0)), rows = Math.max(3, Math.min(200, params.rows | 0)); job.terminal?.resize(cols, rows); job.emulator?.resize(cols, rows); return true; }
		if (method === "steer") { if (!job.rpc || job.endedAt) throw new Error("Agent is not running"); return job.rpc.request({ type: "prompt", message: params.message, streamingBehavior: "steer" }); }
		if (method === "apply") {
			if (!subagentsEnabled(this.agentDir)) throw new Error("Subagents are disabled");
			if (job.status !== "done" || !job.patchPath) throw new Error("No completed patch to apply");
			if (await this.fingerprint(job.cwd) !== job.baseFingerprint) throw new Error("Main workspace changed; inspect and resolve the patch manually");
			await git(job.cwd, ["apply", "--check", job.patchPath]); await git(job.cwd, ["apply", job.patchPath]); job.applied = true; this.persist(job); return { applied: true, patchPath: job.patchPath };
		}
		throw new Error(`Unknown task operation: ${method}`);
	}
	async fingerprint(cwd) {
		const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
		return hash(await git(cwd, ["rev-parse", "HEAD"]) + await git(cwd, ["diff", "--binary", "HEAD"]) + untracked.map((file) => `${file}:${hash(readFileSync(join(cwd, file)))}`).join("\n"));
	}
	drain() {
		while (!this.stopping && subagentsEnabled(this.agentDir) && this.activeAgents < 3 && this.queue.length) {
			const job = this.queue.shift(); if (job.endedAt) continue;
			this.activeAgents++; this.runAgent(job).catch((error) => this.finish(job, 1, error.message)).finally(() => { this.activeAgents--; this.drain(); });
		}
	}
	async runAgent(job) {
		job.status = "running"; job.activity = "thinking"; const params = job.params;
		job.ownerCwd = job.cwd;
		let gitRoot; try { gitRoot = (await git(job.cwd, ["rev-parse", "--show-toplevel"])).trim(); } catch {}
		const mode = resolveWorkerPolicy({ gitRoot, profile: params.profile, isolation: params.isolation, readonly: params.readonly });
		job.readonly = mode.readonly;
		job.profile = mode.profile;
		job.isolation = mode.isolation;
		job.sharedWrite = mode.sharedWrite;
		let childCwd = job.cwd;
		if (mode.fallback) this.output(job, "\nWritable worktrees require a Git workspace; running this worker in read-only mode.\n");
		if (mode.sharedWrite) await this.waitForSharedWriteLease(job);
		if (job.endedAt) return;
		if (mode.isolated) {
			job.cwd = realpathSync(gitRoot); job.baseFingerprint = await this.fingerprint(job.cwd);
			job.worktree = join(job.directory, "worktree");
			await git(job.cwd, ["worktree", "add", "--detach", job.worktree, "HEAD"]);
			const patch = await git(job.cwd, ["diff", "--binary", "HEAD"]);
			if (patch.trim()) { const file = join(job.directory, "baseline.patch"); writeFileSync(file, patch, { mode: 0o600 }); await git(job.worktree, ["apply", file]); }
			for (const file of (await git(job.cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)) {
				const source = join(job.cwd, file); if (lstatSync(source).isSymbolicLink()) throw new Error(`Untracked symlink requires manual isolation: ${file}`);
				const destination = join(job.worktree, file); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
			}
			await git(job.worktree, ["add", "-A"]); await git(job.worktree, ["-c", "user.name=Tsukuyomi", "-c", "user.email=agent@localhost", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "Isolated task baseline"]);
			job.baseline = (await git(job.worktree, ["rev-parse", "HEAD"])).trim(); childCwd = job.worktree;
		}
		if (job.endedAt || !subagentsEnabled(this.agentDir)) { this.cancel(job); return; }
		const tools = mode.readonly ? "read,grep,find,ls" : "read,bash,edit,write,grep,find,ls";
		const args = ["--no-extensions", "--no-approve", "--tools", params.teamId ? `${tools},team_message,team_inbox,team_report,team_assign,team_request_permission,team_lease` : tools, "--session-dir", join(job.directory, "sessions")];
		if (params.teamId && params.memberId) args.push("--extension", join(this.root, "src", "team-worker.ts"));
		// Use the same Tsukuyomi-owned skill snapshot as the main kernel. This
		// prevents workers from consulting PI's ambient ~/.pi or ~/.agents roots.
		args.push(...managedSkillArgs(this.agentDir));
		if (params.provider && params.model) args.push("--provider", params.provider, "--model", params.model);
		if (params.thinking) args.push("--thinking", params.thinking);
		if (params.systemPrompt) {
			const promptPath = join(job.directory, "system-prompt.md");
			writeFileSync(promptPath, String(params.systemPrompt).slice(0, 100_000), { mode: 0o600 });
			args.push("--append-system-prompt", promptPath);
		}
		// Never let a child switch the main runtime's active credential. Each job
		// gets a private agent dir with the selected account materialized into it.
		const runtimeDir = join(job.directory, "agent");
		if (params.accountRef || params.accountId) materializeAccountRuntime(this.agentDir, runtimeDir, params.accountRef || params.accountId, params.provider);
		else writeAuthStore(runtimeDir, readAuthStore(this.agentDir));
		const canonicalSkills = join(this.agentDir, "skills");
		if (existsSync(canonicalSkills)) {
			try { symlinkSync(canonicalSkills, join(runtimeDir, "skills"), "dir"); } catch {}
		}
		const modelsPath = join(this.agentDir, "models.json");
		if (existsSync(modelsPath)) copyFileSync(modelsPath, join(runtimeDir, "models.json"));
		const childEnv = {
			...process.env,
			PI_CODING_AGENT_DIR: runtimeDir,
			TSUKUYOMI_DIR: runtimeDir,
			TSUKUYOMI_SUBAGENT: "1",
			...(params.teamId ? {
				TSUKUYOMI_TASK_SOCKET: this.socketPath,
				TSUKUYOMI_TASK_TOKEN: this.token,
				TSUKUYOMI_TEAM_ID: params.teamId,
				TSUKUYOMI_TEAM_MEMBER_ID: params.memberId,
				TSUKUYOMI_TEAM_JOB_ID: job.id,
				TSUKUYOMI_TEAM_CAPABILITY: job.capabilityToken,
				TSUKUYOMI_TEAM_ROLE: params.role || "peer",
				TSUKUYOMI_TEAM_PROFILE: mode.profile,
			} : {}),
		};
		job.rpc = new PiRpc(this.piBin, args, childEnv, childCwd);
		const toolOutput = new Map();
		await new Promise((resolvePromise, reject) => {
			job.rpc.onStderr((line) => this.output(job, `${line}\n`));
			job.rpc.onExit(({ error }) => job.status === "cancelled" ? resolvePromise() : reject(error));
		job.rpc.onEvent((event) => {
				if (event.type === "message_update") {
					if (event.assistantMessageEvent?.type === "thinking_delta") { job.activity = "thinking"; this.publish(job); }
					if (event.assistantMessageEvent?.type === "text_delta") { job.activity = "working"; this.output(job, event.assistantMessageEvent.delta); }
				}
				if (event.type === "tool_execution_start") { job.activity = "working"; this.output(job, `\n▣ ${toolHeading(event)}\n`); }
				if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
					const id = event.toolCallId || event.toolName;
					const next = textOf(event.partialResult || event.result).slice(-16_000);
					const previous = toolOutput.get(id) || "";
					if (next && next !== previous) this.output(job, next.startsWith(previous) ? next.slice(previous.length) : `\n${next}`);
					toolOutput.set(id, next);
					if (event.type === "tool_execution_end") this.output(job, event.isError ? "\n✖ Tool failed\n" : "\n✓ Done\n");
				}
				if (event.type === "agent_settled") resolvePromise();
			});
			const executionNote = mode.readonly
				? "Perform read-only analysis in the current workspace; do not claim that you changed files. "
				: mode.sharedWrite && params.teamId
				? "Work directly in the shared workspace only while holding the shared-write lease. "
				: mode.isolated
				? "Work only in this isolated workspace. "
				: "Work directly in the current workspace. ";
			job.rpc.start(); job.rpc.request({ type: "prompt", message: `${executionNote}${params.task}\nReturn findings with paths and a concise result summary.` }).catch(reject);
		});
		const messages = await job.rpc.request({ type: "get_messages" }).catch(() => ({ messages: [] }));
		job.result = textOf(messages.messages.filter((message) => message.role === "assistant").at(-1)); job.rpc.stop();
		if (job.endedAt) return;
		if (job.worktree && mode.isolated) {
			await git(job.worktree, ["add", "-A"]); const patch = await git(job.worktree, ["diff", "--cached", "--binary", job.baseline]);
			if (patch.trim()) { job.patchPath = join(job.directory, "result.patch"); writeFileSync(job.patchPath, patch, { mode: 0o600 }); this.output(job, `\nInspect ${job.patchPath}, then use subagent action=apply id=${job.id} to integrate and run validation.\n`); }
		}
		this.finish(job, 0);
	}
	async waitForSharedWriteLease(job) {
		job.status = "waiting";
		job.activity = "waiting";
		this.publish(job);
		while (!job.endedAt && !this.stopping) {
			const lease = this.broker.request("team.lease.acquire", {
				jobId: job.id, teamId: job.params.teamId, memberId: job.params.memberId, capabilityToken: job.capabilityToken,
			});
			if (lease.acquired) {
				job.status = "running";
				job.activity = "working";
				job.leaseTimer = setInterval(() => {
					try {
						this.broker.request("team.lease.heartbeat", {
							jobId: job.id, teamId: job.params.teamId, memberId: job.params.memberId, capabilityToken: job.capabilityToken,
						});
					} catch { /* The worker may have finished as the timer fired. */ }
				}, 5_000);
				job.leaseTimer.unref();
				this.publish(job);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}
	async stop() {
		this.stopping = true; clearInterval(this.policyTimer); this.queue = [];
		for (const job of this.jobs.values()) { this.cancel(job); if (job.timer) clearTimeout(job.timer); if (job.screenTimer) clearTimeout(job.screenTimer); job.emulator?.dispose(); }
		for (const client of this.clients) client.destroy();
		if (this.server) await new Promise((resolvePromise) => this.server.close(resolvePromise));
		if (this.socketPath && existsSync(this.socketPath)) unlinkSync(this.socketPath); if (this.directory) rmdirSync(this.directory);
	}
}
