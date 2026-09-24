import test from "node:test";
import assert from "node:assert/strict";
import { filterSelectOptions, selectListState } from "../app/tui/select-list.mjs";

test("selectors share search defaults and clamp malformed/empty selections", () => {
	assert.equal(selectListState({ options: ["a", "b"] }).searchable, false);
	assert.equal(selectListState({ options: Array.from({ length: 8 }, (_, i) => String(i)) }).searchable, true);
	assert.equal(selectListState({ options: [], selected: 300 }).selected, 0);
	assert.equal(selectListState({ options: ["a", "b"], selected: 1.8 }).selected, 1);
	assert.equal(selectListState({ options: ["a"], kind: "confirm" }).searchable, false);
});

test("search matches labels or descriptions without mutating the original list", () => {
	const options = ["Claude", "Gemini", "GPT"];
	const descriptions = new Map([["Gemini", "Fast reasoning"]]);
	assert.deepEqual(filterSelectOptions(options, descriptions, "REASON"), ["Gemini"]);
	assert.deepEqual(filterSelectOptions(options, descriptions, " g"), ["Gemini", "GPT"]);
	assert.deepEqual(options, ["Claude", "Gemini", "GPT"]);
	assert.deepEqual(filterSelectOptions(options, descriptions, "nothing"), []);
});
