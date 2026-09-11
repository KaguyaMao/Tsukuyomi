import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonc, stripJsonComments, stripTrailingCommas } from "../../app/providers/config/jsonc.mjs";

test("stripJsonComments removes line and block comments", () => {
	const input = '{\n  // line\n  "a": 1, /* block */\n  "b": 2\n}\n';
	assert.deepEqual(JSON.parse(stripJsonComments(input)), { a: 1, b: 2 });
});

test("stripJsonComments keeps comment markers inside strings", () => {
	const input = '{ "url": "https://example.com//v1", "glob": "/*" }';
	assert.deepEqual(JSON.parse(stripJsonComments(input)), { url: "https://example.com//v1", glob: "/*" });
});

test("stripTrailingCommas removes trailing commas outside strings", () => {
	const input = '{ "a": [1,2,], "b": { "c": 3, }, "d": "x,]" }';
	assert.deepEqual(JSON.parse(stripTrailingCommas(input)), { a: [1, 2], b: { c: 3 }, d: "x,]" });
});

test("parseJsonc handles a full JSONC document", () => {
	const input = `{
		// schema is optional
		"provider": {
			"myprovider": {
				"name": "My Provider", // display name
				"models": { "m1": { "name": "M1" }, },
			},
		},
	}`;
	assert.deepEqual(parseJsonc(input), { provider: { myprovider: { name: "My Provider", models: { m1: { name: "M1" } } } } });
});

test("parseJsonc strips a BOM", () => {
	assert.deepEqual(parseJsonc('\uFEFF{ "a": 1 }'), { a: 1 });
});

test("parseJsonc rejects genuinely invalid JSON", () => {
	assert.throws(() => parseJsonc("{ a: 1 }"));
});
