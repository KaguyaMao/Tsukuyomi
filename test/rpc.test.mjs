import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LineBuffer, PiRpc } from "../app/rpc.mjs";

test("LineBuffer reassembles lines split across chunk boundaries", () => {
	const buffer = new LineBuffer();
	const collector = [];
	const feed = (chunk) => {
		buffer.push(chunk);
		let result;
		do {
			result = buffer.drain({ maxLines: 1 << 20, maxMs: 1 << 20 });
			collector.push(...result.lines);
		} while (result.more);
	};
	feed('{"a":');
	feed("1}\n{\"b\":");
	feed("2}\n");
	assert.deepEqual(collector, ['{"a":1}', '{"b":2}']);
	assert.equal(buffer.chunks.length, 0);
});

test("LineBuffer keeps a trailing partial line between pushes", () => {
	const buffer = new LineBuffer();
	buffer.push('{"partial":');
	assert.deepEqual(buffer.drain().lines, []);
	buffer.push("true}\n");
	assert.deepEqual(buffer.drain().lines, ['{"partial":true}']);
	assert.equal(buffer.chunks.length, 0);
});

test("LineBuffer drains a multi-megabyte line fed in many chunks exactly once", () => {
	const buffer = new LineBuffer();
	const payload = JSON.stringify({ type: "response", id: "x", data: { text: "y".repeat(4_000_000) } });
	const wire = `${payload}\n`;
	const chunkSize = 16 * 1024;
	const lines = [];
	for (let offset = 0; offset < wire.length; offset += chunkSize) {
		buffer.push(wire.slice(offset, offset + chunkSize));
		let result;
		do {
			result = buffer.drain({ maxLines: 32, maxMs: 4 });
			lines.push(...result.lines);
		} while (result.more);
	}
	assert.equal(lines.length, 1);
	assert.deepEqual(JSON.parse(lines[0]), JSON.parse(payload));
	assert.equal(buffer.chunks.length, 0);
});

test("LineBuffer reports more when the batch budget leaves complete lines buffered", () => {
	const buffer = new LineBuffer();
	buffer.push("a\nb\nc\n");
	const first = buffer.drain({ maxLines: 1, maxMs: 1 << 20 });
	assert.deepEqual(first.lines, ["a"]);
	assert.equal(first.more, true);
	const rest = [];
	let result = first;
	while (result.more) {
		result = buffer.drain({ maxLines: 10, maxMs: 1 << 20 });
		rest.push(...result.lines);
	}
	assert.deepEqual(rest, ["b", "c"]);
});

test("PiRpc starts a worker whose executable path contains non-ASCII characters", async () => {
	const root = await mkdtemp(join(tmpdir(), "tsukuyomi-rpc-"));
	const directory = join(root, "中文路径");
	await mkdir(directory);
	const executable = join(directory, "fake-pi.mjs");
	await writeFile(executable, "process.stdin.resume();\n", { mode: 0o700 });

	const rpc = new PiRpc(executable, [], {}, root);
	try {
		rpc.start();
		await delay(100);
		assert.ok(rpc.child, "the RPC child should still be running");
	} finally {
		rpc.stop();
		await delay(50);
	}
});
