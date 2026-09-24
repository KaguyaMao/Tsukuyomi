import test from "node:test";
import assert from "node:assert/strict";
import { createToolCallStream } from "../app/tui/toolcall-stream.mjs";

test("delta-only Pi protocol assembles tool arguments without partial snapshots", () => {
	const stream = createToolCallStream();
	assert.deepEqual(stream.accept({ type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "bash" }), { id: "call-1", name: "bash", args: {} });
	assert.deepEqual(stream.accept({ type: "toolcall_delta", contentIndex: 0, delta: '{"command":' }).args, {});
	assert.deepEqual(stream.accept({ type: "toolcall_delta", contentIndex: 0, delta: '"ls"}' }).args, { command: "ls" });
	assert.deepEqual(stream.accept({ type: "toolcall_end", contentIndex: 0, toolCall: { id: "call-1", name: "bash", arguments: { command: "pwd" } } }).args, { command: "pwd" });
	assert.equal(stream.accept({ type: "toolcall_delta", contentIndex: 0, delta: "more" }), undefined);
});

test("stream reset and corrupt data never reuse stale tool arguments", () => {
	const stream = createToolCallStream();
	stream.accept({ type: "toolcall_start", contentIndex: 1, id: "old", toolName: "edit" });
	stream.reset();
	assert.equal(stream.accept({ type: "toolcall_end", contentIndex: 1 }), undefined);
	assert.equal(stream.accept({ type: "toolcall_start", contentIndex: -1, id: "bad", toolName: "bash" }), undefined);
});
