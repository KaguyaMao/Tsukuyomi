import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAgentLayout } from "../app/tui-layout.mjs";

test("composer box can absorb the detached status row", () => {
	const layout = computeAgentLayout({
		width: 100,
		height: 30,
		promptHeight: 4,
		statusHeight: 0,
	});
	assert.equal(layout.statusBar.height, 0);
	assert.equal(layout.prompt.height, 4);
	assert.ok(layout.scrollback.height > 0);
});
