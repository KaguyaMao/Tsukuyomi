import test from "node:test";
import assert from "node:assert/strict";
import { workerMode } from "../app/task-service.mjs";

test("legacy workers still remain read-only when no isolation mode is selected", () => {
	assert.deepEqual(workerMode({ gitRoot: undefined, readonly: false }), { isolated: false, readonly: true });
});

test("Git workers keep isolation while explicit research stays read-only", () => {
	assert.deepEqual(workerMode({ gitRoot: "/workspace/project", readonly: false }), { isolated: true, readonly: false });
	assert.deepEqual(workerMode({ gitRoot: "/workspace/project", readonly: true }), { isolated: false, readonly: true });
});
