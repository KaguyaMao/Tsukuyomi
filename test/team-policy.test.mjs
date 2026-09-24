import test from "node:test";
import assert from "node:assert/strict";
import { resolveWorkerPolicy, workerMode } from "../app/team-policy.mjs";

test("team profiles own permissions independently from isolation", () => {
	assert.deepEqual(resolveWorkerPolicy({ gitRoot: "/repo", profile: "plan", isolation: "shared-write" }), {
		profile: "plan", isolation: "current-readonly", readonly: true, isolated: false, sharedWrite: false, fallback: false,
	});
	assert.deepEqual(resolveWorkerPolicy({ gitRoot: "/repo", profile: "build", isolation: "git-worktree" }), {
		profile: "build", isolation: "git-worktree", readonly: false, isolated: true, sharedWrite: false, fallback: false,
	});
	assert.deepEqual(resolveWorkerPolicy({ gitRoot: "/repo", profile: "build", isolation: "shared-write" }), {
		profile: "build", isolation: "shared-write", readonly: false, isolated: false, sharedWrite: true, fallback: false,
	});
});

test("shared-write permits direct writes outside Git", () => {
	assert.deepEqual(resolveWorkerPolicy({ profile: "build", isolation: "shared-write" }), {
		profile: "build", isolation: "shared-write", readonly: false, isolated: false, sharedWrite: true, fallback: false,
	});
	assert.deepEqual(workerMode({ gitRoot: undefined, readonly: false }), { isolated: false, readonly: true });
});
