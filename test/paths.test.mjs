import test from "node:test";
import assert from "node:assert/strict";
import { legacyAgentDirs, resolveAgentDir } from "../app/paths.mjs";

test("Tsukuyomi resolves one active agent root and expands tildes", () => {
	assert.equal(resolveAgentDir({ env: {}, home: "/home/test" }), "/home/test/.tsukuyomi/agent");
	assert.equal(resolveAgentDir({ env: { TSUKUYOMI_DIR: "~/custom-agent" }, home: "/home/test" }), "/home/test/custom-agent");
});

test("Pi and Kaguya roots are migration sources, never the active root", () => {
	const target = "/home/test/.tsukuyomi/agent";
	const sources = legacyAgentDirs({ env: { PI_CODING_AGENT_DIR: target, KAGUYAPI_DIR: "/home/test/.kaguyapi/agent" }, home: "/home/test", target });
	assert.deepEqual(sources, ["/home/test/.kaguyapi/agent", "/home/test/.pi/agent"]);
	assert.equal(legacyAgentDirs({ env: { PI_CODING_AGENT_DIR: "~/.pi/agent" }, home: "/home/test", target })[0], "/home/test/.pi/agent");
});
