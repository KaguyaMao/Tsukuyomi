import test from "node:test";
import assert from "node:assert/strict";
import { LiveTool } from "../app/live-tools.mjs";

test("read and bash cards move through running, completed, and error states", () => {
	const tool = new LiveTool("x");
	tool.update({ type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts" } });
	assert.match(tool.rows("en")[0].text, /● read src\/a\.ts/);
	tool.update({ type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "one\ntwo" }] } });
	assert.equal(tool.status, "done");
	assert.ok(tool.rows("en").some((row) => row.text === "two"));
	assert.ok(tool.rows("en").some((row) => row.text === "Read 2 lines"));
	tool.update({ type: "tool_execution_end", toolName: "bash", args: { command: "false" }, isError: true, result: { content: [{ type: "text", text: "failed" }], details: { exitCode: 1 } } });
	assert.equal(tool.status, "error");
	assert.ok(tool.rows("en").some((row) => row.text === "Exit: 1"));
});

test("edit card distinguishes un-applied preview from applied diff", () => {
	const tool = new LiveTool("e");
	tool.update({ type: "tool_execution_start", toolName: "edit", args: { path: "a.ts", oldText: "old", newText: "new" } });
	assert.ok(tool.rows("en").some((row) => row.text === "Preview (not applied)"));
	tool.update({ type: "tool_execution_end", toolName: "edit", result: { content: [{ type: "text", text: "done" }], details: { diff: "-old\n+new", applied: true } } });
	assert.ok(tool.rows("en").some((row) => row.text === "Applied"));
});
