import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findPi, findPiRoot, resolvePiTui } from "../app/pi-runtime.mjs";

function writeFile(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/** Build a fake PI package tree: dist/index.js plus a nested pi-tui. */
function fakePiPackage(root) {
	const pkg = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	writeFile(pkg + "/dist/index.js", "export {};\n");
	writeFile(pkg + "/node_modules/@earendil-works/pi-tui/dist/index.js", "export {};\n");
	return pkg;
}

test("findPiRoot resolves through the app's own node_modules (wrapper piBin)", () => {
	const appRoot = mkdtempSync(join(tmpdir(), "tsukuyomi-app-"));
	const pkg = fakePiPackage(appRoot);
	// A shell wrapper in $HOME: realpath cannot lead to the package.
	const wrapper = join(appRoot, "bin", "pi");
	writeFile(wrapper, "#!/usr/bin/env bash\nexec /usr/bin/pi \"$@\"\n");
	assert.equal(findPiRoot(wrapper, { appRoot }), pkg);
});

test("findPiRoot resolves by walking up from the real binary", () => {
	const root = mkdtempSync(join(tmpdir(), "tsukuyomi-global-"));
	const pkg = fakePiPackage(root);
	const cli = join(pkg, "dist", "bundle", "cli.js");
	writeFile(cli, "// cli\n");
	assert.equal(findPiRoot(cli), pkg);
});

test("findPiRoot falls back to a well-known global install, else throws", () => {
	const empty = mkdtempSync(join(tmpdir(), "tsukuyomi-empty-"));
	const stray = join(empty, "pi");
	writeFile(stray, "#!/bin/sh\n");
	const globalRoot = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
	if (existsSync(join(globalRoot, "dist", "index.js"))) {
		assert.equal(findPiRoot(stray, { appRoot: empty }), globalRoot);
	} else {
		assert.throws(() => findPiRoot(stray, { appRoot: empty }), /could not locate @earendil-works\/pi-coding-agent/);
	}
});

test("resolvePiTui prefers the app's own pi-tui", () => {
	const appRoot = mkdtempSync(join(tmpdir(), "tsukuyomi-app-"));
	const own = join(appRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js");
	writeFile(own, "export {};\n");
	assert.equal(resolvePiTui({ appRoot, piRoot: "/nonexistent" }), realpathSync(own));
});

test("findPi prefers an explicit TSUKUYOMI_PI over PATH", () => {
	const dir = mkdtempSync(join(tmpdir(), "tsukuyomi-pi-"));
	const explicit = join(dir, "pi");
	writeFile(explicit, "#!/bin/sh\n");
	const previous = process.env.TSUKUYOMI_PI;
	process.env.TSUKUYOMI_PI = explicit;
	try {
		assert.equal(findPi({ root: dir, home: dir }), explicit);
	} finally {
		if (previous === undefined) delete process.env.TSUKUYOMI_PI;
		else process.env.TSUKUYOMI_PI = previous;
	}
});
