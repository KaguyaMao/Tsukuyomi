import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("removed Ask mode is rejected before any TUI or kernel starts", () => {
	const result = spawnSync(process.execPath, ["bin/tsukuyomi.mjs", "--ask"], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Ask mode was removed/);
	assert.equal(result.stdout, "");
});
