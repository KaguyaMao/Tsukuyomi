import test from "node:test";
import assert from "node:assert/strict";
import { formatAgo, formatDuration, formatTime, TOOL_LABEL_KEYS, toolLabel } from "../app/tui/formatters.mjs";

test("extracted timestamp helpers keep English and Chinese output", () => {
	const now = Date.UTC(2026, 0, 1);
	assert.equal(formatTime("invalid"), "");
	assert.equal(formatTime(now, "en"), new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(now));
	assert.equal(formatAgo(now - 30_000, "en", now), "now");
	assert.equal(formatAgo(now - 61_000, "en", now), "1m ago");
	assert.equal(formatAgo(now - 61_000, "zh", now), "1 分钟前");
	assert.equal(formatAgo(now - 86_400_000, "zh", now), "1 天前");
});

test("extracted duration formatter keeps boundary and invalid-value behavior", () => {
	assert.equal(formatDuration(Number.NaN), "");
	assert.equal(formatDuration(-1), "");
	assert.equal(formatDuration(1.5), "1.5s");
	assert.equal(formatDuration(61), "1m1s");
	assert.equal(formatDuration(61, "zh"), "1分1秒");
});

test("tool labels select the same translated and fallback arguments", () => {
	const t = (key) => `<${key}>`;
	assert.equal(toolLabel("read", { path: "src/a.ts" }, t), "<toolVerb.read> src/a.ts");
	assert.equal(toolLabel("read", {}, t), "<tools.read>");
	assert.equal(toolLabel("bash", { cmd: "ls" }, t), "<toolVerb.run> ls");
	assert.equal(toolLabel("web_search", { query: "example" }, t), "<toolVerb.search> example");
	assert.equal(toolLabel("unknown", { action: "inspect" }, t), "<unknown> inspect");
	assert.equal(TOOL_LABEL_KEYS.apply_patch, "tools.applyPatch");
});
