// Data-only extension UI metadata travels over Pi's supported setWidget RPC.
// The nonce in the following select title binds it to one request; no custom
// RPC methods or terminal escape sequences cross the trust boundary.
const MARKER = /^\u2063tsu-ui:([a-f0-9-]{36})\u2063([\s\S]*)$/;
const ALLOWED = new Set(["questionnaire", "plan-review"]);
export const STRUCTURED_WIDGET = "tsukuyomi-structured-ui";

export function structuredTitle(nonce, title) {
	return `\u2063tsu-ui:${nonce}\u2063${title}`;
}

export function decodeStructuredTitle(title, pending) {
	const match = MARKER.exec(String(title || ""));
	if (!match) return { title, structured: undefined };
	const metadata = pending?.get(match[1]);
	pending?.delete(match[1]);
	return { title: match[2], structured: metadata };
}

export function readStructuredWidget(lines) {
	if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== "string" || lines[0].length > 64_000) return undefined;
	try {
		const value = JSON.parse(lines[0]);
		if (value?.version !== 1 || !ALLOWED.has(value.kind) || !/^[a-f0-9-]{36}$/.test(value.nonce) || !value.payload || typeof value.payload !== "object") return undefined;
		return { nonce: value.nonce, kind: value.kind, payload: value.payload };
	} catch { return undefined; }
}

export function structuredPreview(structured, maxWidth = 80) {
	if (!structured) return [];
	const safe = (value) => String(value || "").replace(/[\x00-\x1f\x7f\x1b]/g, " ").slice(0, 16_384);
	if (structured.kind === "questionnaire") {
		const { index, total, question, answers = [] } = structured.payload;
		return [
			`QUESTION ${Math.max(1, Number(index) + 1)}/${Math.max(1, Number(total) || 1)}  ${safe(question?.header)}`,
			safe(question?.question),
			...answers.slice(0, 3).map((answer, i) => `✓ ${i + 1}. ${safe(answer.label || answer.value)}`),
		].filter(Boolean).map((row) => row.slice(0, maxWidth * 3));
	}
	if (structured.kind === "plan-review") {
		return ["PLAN REVIEW · read-only until approved", ...String(structured.payload.body || "").split(/\r?\n/).slice(0, 300).map(safe)];
	}
	return [];
}
