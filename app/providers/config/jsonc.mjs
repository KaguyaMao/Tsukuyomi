/**
 * Minimal JSONC support for Tsukuyomi's own config files.
 *
 * `providers.json` accepts comments and trailing commas so it can carry inline
 * documentation, matching PI's `models.json` (which is parsed as JSONC) and
 * opencode's `opencode.jsonc`. This is deliberately a small, dependency-free
 * scanner: it strips `//` and block comments only outside strings, then removes
 * trailing commas outside strings, then hands the result to `JSON.parse`.
 */

/** Remove `//` and slash-star comments that appear outside string literals. */
export function stripJsonComments(text) {
	let out = "";
	let index = 0;
	const length = text.length;
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;
	while (index < length) {
		const char = text[index];
		const next = text[index + 1];
		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
				out += char;
			}
			index += 1;
			continue;
		}
		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				index += 2;
			} else {
				index += 1;
			}
			continue;
		}
		if (inString) {
			out += char;
			if (char === "\\") {
				out += next ?? "";
				index += 2;
				continue;
			}
			if (char === '"') inString = false;
			index += 1;
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			index += 1;
			continue;
		}
		if (char === "/" && next === "/") {
			inLineComment = true;
			index += 2;
			continue;
		}
		if (char === "/" && next === "*") {
			inBlockComment = true;
			index += 2;
			continue;
		}
		out += char;
		index += 1;
	}
	return out;
}

/** Remove commas that are immediately followed by a closing brace or bracket. */
export function stripTrailingCommas(text) {
	let out = "";
	let index = 0;
	const length = text.length;
	let inString = false;
	while (index < length) {
		const char = text[index];
		if (inString) {
			out += char;
			if (char === "\\") {
				out += text[index + 1] ?? "";
				index += 2;
				continue;
			}
			if (char === '"') inString = false;
			index += 1;
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			index += 1;
			continue;
		}
		if (char === ",") {
			let lookahead = index + 1;
			while (lookahead < length && /\s/.test(text[lookahead])) lookahead += 1;
			if (text[lookahead] === "}" || text[lookahead] === "]") {
				index += 1;
				continue;
			}
		}
		out += char;
		index += 1;
	}
	return out;
}

/**
 * Parse JSONC text.
 * @throws {SyntaxError} when the result is not valid JSON.
 */
export function parseJsonc(text) {
	const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	return JSON.parse(stripTrailingCommas(stripJsonComments(withoutBom)));
}
