import test from "node:test";
import assert from "node:assert/strict";
import { providerListWindow } from "../app/tui/provider-list-window.mjs";

test("provider list viewport keeps the selected last option visible across section headings", () => {
	const options = ["custom", "current", "connected", "popular", "other-a", "other-b", "other-c"];
	const sections = new Map([
		["custom", "Custom"],
		["current", "Current"],
		["connected", "Connected"],
		["popular", "Popular"],
		["other-a", "Other"],
		["other-b", "Other"],
		["other-c", "Other"],
	]);
	const rows = providerListWindow({ options, sections, selectedIndex: options.length - 1, rowCount: 4 });

	assert.ok(rows.some((row) => row.kind === "option" && row.index === options.length - 1));
	assert.ok(rows.length <= 4);
});

test("selected web-search description stays within the viewport with its option", () => {
	const options = ["Auto", "Parallel", "Perplexity"];
	const rows = providerListWindow({
		options,
		sections: new Map(options.map((option) => [option, "Search"])),
		selectedIndex: 1,
		rowCount: 3,
		selectedDescription: "Public search or PARALLEL_API_KEY",
	});

	assert.ok(rows.some((row) => row.kind === "option" && row.index === 1));
	assert.ok(rows.some((row) => row.kind === "description"));
	assert.ok(rows.length <= 3);
});
