import test from "node:test";
import assert from "node:assert/strict";
import { matchesTuiAction, resolveTuiKeybindings, TUI_KEYBINDING_PRESETS } from "../app/tui/keybindings.mjs";

const matches = (data, chord) => data.toLowerCase() === chord.toLowerCase();

test("OMP preset adopts documented model, plan, tool, thinking, and follow-up chords", () => {
	const bindings = resolveTuiKeybindings("omp");
	assert.deepEqual(bindings["model.cycleForward"], ["ctrl+p"]);
	assert.deepEqual(bindings["model.cycleBackward"], ["ctrl+shift+p"]);
	assert.deepEqual(bindings["mode.toggle"], ["alt+shift+p"]);
	assert.deepEqual(bindings["tools.expand"], ["ctrl+o"]);
	assert.deepEqual(bindings["thinking.toggle"], ["ctrl+t"]);
	assert.deepEqual(bindings["thinking.cycle"], ["shift+tab"]);
	assert.deepEqual(bindings["message.followUp"], ["ctrl+q", "ctrl+enter"]);
	assert.equal(bindings["palette.open"], undefined, "Ctrl+P is reserved for OMP model cycling");
	assert.deepEqual(bindings["hub.open"], ["alt+a"]);
	assert.deepEqual(bindings["sessions.open"], ["ctrl+s"], "Ctrl+S stays the session browser, not an OMP Hub alias");
});

test("legacy preset retains Tsukuyomi's prior primary shortcuts", () => {
	const bindings = resolveTuiKeybindings("legacy");
	assert.deepEqual(bindings["palette.open"], ["ctrl+p"]);
	assert.deepEqual(bindings["mode.toggle"], ["shift+tab"]);
	assert.deepEqual(bindings["workflow.toggle"], ["ctrl+o"]);
	assert.deepEqual(bindings["todo.toggle"], ["ctrl+t"]);
	assert.deepEqual(bindings["message.followUp"], ["alt+enter"]);
	assert.deepEqual(bindings["message.interrupt"], ["ctrl+enter"]);
	assert.deepEqual(TUI_KEYBINDING_PRESETS.legacy["sessions.open"], ["ctrl+s"]);
});

test("overrides are per action, validated, immutable and can explicitly unbind", () => {
	const overrides = { "mode.toggle": ["f2", "F3"], "thinking.toggle": [], "evil;bash": ["ctrl+c"], "tools.expand": ["not a chord"] };
	const bindings = resolveTuiKeybindings("omp", overrides);
	assert.deepEqual(bindings["mode.toggle"], ["f2", "f3"]);
	assert.deepEqual(bindings["thinking.toggle"], []);
	assert.deepEqual(bindings["tools.expand"], ["ctrl+o"]);
	assert.equal(bindings["evil;bash"], undefined);
	assert.equal(Object.isFrozen(bindings), true);
	assert.equal(matchesTuiAction("f3", "mode.toggle", bindings, matches), true);
	assert.equal(matchesTuiAction("ctrl+t", "thinking.toggle", bindings, matches), false);
});
