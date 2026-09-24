import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentHubRows } from "../app/tui/agent-hub.mjs";

test("Hub lists real members, pending permissions, reports, workspace tasks and templates", () => {
	const team = { active: true, objective: "Build", phase: "executing", collaborationMode: "leader", members: [{ id: "m", name: "Ada", status: "running", role: "builder", profile: "build", isolation: "git-worktree" }], permissionRequests: [{ id: "p", memberId: "m", kind: "shell", status: "pending" }, { id: "old", status: "denied" }], reports: [{ id: "r", memberId: "m", status: "done", text: "Patch", patchPath: "/tmp/x.patch" }] };
	const jobs = [{ id: "j", cwd: "/repo", kind: "subagent", command: "test", status: "done", patchPath: "/tmp/x.patch" }, { id: "other", cwd: "/private", command: "hidden" }];
	const rows = buildAgentHubRows({ team, jobs, agents: [{ id: "a", name: "Agent", provider: "p", model: "m" }], cwd: "/repo" });
	assert.deepEqual(rows.map((row) => row.kind), ["summary", "member", "permission", "report", "task", "agent"]);
	assert.ok(rows.find((row) => row.kind === "task").detail.includes("Patch available"));
	assert.ok(rows.every((row) => row.kind === "agent" || row.detail.includes("usage —")));
	assert.equal(rows.some((row) => row.kind === "revive" || /\brevive\b/i.test(row.title)), false);
	assert.equal(rows.some((row) => row.id === "other"), false);
});

test("Hub does not invent unavailable capabilities or render terminal control sequences", () => {
	const rows = buildAgentHubRows({ cwd: "/repo", agents: [{ id: "x", name: "\x1b[31mRed", description: "line\nnext" }] });
	assert.equal(rows[0].kind, "summary");
	assert.match(rows[0].detail, /revive —/);
	assert.equal(rows.some((row) => row.kind === "revive"), false);
	assert.equal(rows[1].title.includes("\x1b"), false);
	assert.equal(rows[1].detail.includes("\n"), false);
});
