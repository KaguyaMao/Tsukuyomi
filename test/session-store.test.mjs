import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessionCatalog } from "../app/session-store.mjs";

const line = (value) => `${JSON.stringify(value)}\n`;

async function makeSession(dir, name, cwd = "/work/project") {
	const path = join(dir, `${name}.jsonl`);
	const body = [
		line({ type: "session", version: 3, id: name, cwd, timestamp: new Date().toISOString() }),
		line({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: `prompt for ${name}` }] },
		}),
	].join("");
	await writeFile(path, body);
	return path;
}

test("scanSessionCatalog reads cwd and first prompt", async () => {
	const root = await mkdtemp(join(tmpdir(), "tsukuyomi-sessions-"));
	await makeSession(root, "alpha", "/work/alpha");
	await makeSession(root, "beta", "/work/beta");
	const items = await scanSessionCatalog(root, { cwd: "/fallback", limit: 10 });
	assert.equal(items.length, 2);
	const byId = new Map(items.map((item) => [item.name, item]));
	assert.equal(byId.get("prompt for alpha").cwd, "/work/alpha");
	assert.equal(byId.get("prompt for beta").cwd, "/work/beta");
});

test("scanSessionCatalog prefers a session_info display name over the first prompt", async () => {
	const root = await mkdtemp(join(tmpdir(), "tsukuyomi-sessions-"));
	const path = join(root, "named.jsonl");
	await writeFile(path, [
		line({ type: "session", version: 3, id: "named", cwd: "/work/named", timestamp: new Date().toISOString() }),
		line({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "first prompt" } }),
		line({ type: "session_info", id: "i1", parentId: "m1", timestamp: new Date().toISOString(), name: "Renamed session" }),
	].join(""));
	const [item] = await scanSessionCatalog(root, { cwd: "/fallback", limit: 10 });
	assert.equal(item.name, "Renamed session");
});

test("scanSessionCatalog bounds large session reads while keeping head metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "tsukuyomi-sessions-"));
	const path = join(root, "big.jsonl");
	const filler = line({ type: "custom", id: "c1", parentId: null, timestamp: new Date().toISOString(), data: "x".repeat(4096) });
	await writeFile(path, [
		line({ type: "session", version: 3, id: "big", cwd: "/work/big", timestamp: new Date().toISOString() }),
		line({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "first prompt" } }),
		filler.repeat(700),
		line({ type: "session_info", id: "i1", parentId: "m1", timestamp: new Date().toISOString(), name: "Big session" }),
	].join(""));
	const [item] = await scanSessionCatalog(root, { cwd: "/fallback", limit: 10 });
	assert.equal(item.cwd, "/work/big");
	assert.equal(item.name, "Big session");
});
