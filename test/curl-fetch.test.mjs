import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { curlFetch } = require("../app/curl-fetch.cjs");

async function withFakeCurl(script, run) {
	const directory = await mkdtemp(join(tmpdir(), "tsukuyomi-curl-"));
	const executable = join(directory, "curl");
	await writeFile(executable, script, { mode: 0o755 });
	await chmod(executable, 0o755);
	const previous = process.env.PATH;
	process.env.PATH = `${directory}:${previous}`;
	try {
		return await run();
	} finally {
		process.env.PATH = previous;
	}
}

test("curlFetch returns a promise and resolves a Response asynchronously", async () => {
	await withFakeCurl(`#!/bin/sh
cat >/dev/null 2>&1 || true
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
printf '{"ok":true}' > "$out"
printf '200'
`, async () => {
		const pending = curlFetch("https://example.test/resource");
		assert.ok(pending instanceof Promise, "curlFetch must not block synchronously");
		const response = await pending;
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true });
	});
});

test("curlFetch surfaces a non-zero exit as a network error", async () => {
	await withFakeCurl(`#!/bin/sh
cat >/dev/null 2>&1 || true
printf '000'
exit 7
`, async () => {
		await assert.rejects(curlFetch("https://example.test/resource"), /could not reach/);
	});
});

test("curlFetch rejects promptly when the caller aborts", async () => {
	await withFakeCurl(`#!/bin/sh
cat >/dev/null 2>&1 || true
sleep 5
`, async () => {
		const controller = new AbortController();
		const pending = curlFetch("https://example.test/resource", { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		const startedAt = Date.now();
		await assert.rejects(pending, (error) => error.name === "AbortError");
		assert.ok(Date.now() - startedAt < 2_000, "abort must not wait for curl to finish");
	});
});
