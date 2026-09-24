import { encodeOverlayResult } from "./overlay-result.mjs";

export function createAskSession(questions) {
	const items = (Array.isArray(questions) ? questions : []).slice(0, 3).map((question) => ({
		id: String(question.id || "question"),
		header: question.header || "",
		question: String(question.question || ""),
		options: (question.options || []).slice(0, 4).map((option) => ({
			label: String(option.label || ""),
			description: option.description ? String(option.description) : "",
			recommended: Boolean(option.recommended),
			value: option.value || option.label,
		})),
		allowOther: question.allowOther !== false,
		multi: question.multi === true,
		selected: new Set(),
		custom: undefined,
		note: undefined,
		cursor: 0,
	}));
	return { questions: items, tab: 0, prompt: null };
}

function rows(question) {
	return [...question.options.map((option) => ({ kind: "option", option })), ...(question.allowOther ? [{ kind: "other" }] : [])];
}

export function askCommand(session, command, value = "") {
	const submitTab = session.questions.length;
	const question = session.questions[session.tab];
	if (session.prompt) {
		if (command === "cancel") { session.prompt = null; return "closed"; }
		if (command === "submit") {
			const text = String(value || "").trim();
			if (session.prompt === "other") question.custom = text || undefined;
			if (session.prompt === "note") question.note = text || undefined;
			session.prompt = null;
			return "noted";
		}
		return "draft";
	}
	if (command === "tab" || command === "right") { session.tab = (session.tab + 1) % (submitTab + 1); return "tab"; }
	if (command === "shift-tab" || command === "left") { session.tab = (session.tab - 1 + submitTab + 1) % (submitTab + 1); return "tab"; }
	if (session.tab === submitTab) {
		if (command === "enter") return "submit";
		return "noop";
	}
	const list = rows(question);
	if (command === "up") { question.cursor = Math.max(0, question.cursor - 1); return "move"; }
	if (command === "down") { question.cursor = Math.min(list.length - 1, question.cursor + 1); return "move"; }
	if (command === "note") { session.prompt = "note"; return "prompt"; }
	if (command === "enter" || command === "space") {
		const row = list[question.cursor];
		if (!row) return "noop";
		if (row.kind === "other") { session.prompt = "other"; return "prompt"; }
		if (question.multi && command === "space") {
			if (question.selected.has(row.option.value)) question.selected.delete(row.option.value); else question.selected.add(row.option.value);
			return "toggle";
		}
		if (!question.multi) question.selected = new Set([row.option.value]);
		else if (!question.selected.has(row.option.value)) question.selected.add(row.option.value);
		session.tab = Math.min(submitTab, session.tab + 1);
		return "advance";
	}
	if (command === "cancel") return "cancel";
	return "noop";
}

export function askAnswers(session) {
	return session.questions.map((question) => {
		const selected = question.options.filter((option) => question.selected.has(option.value));
		const custom = question.custom?.trim();
		return { id: question.id, value: custom || selected[0]?.value || "", label: custom || selected.map((option) => option.label).join(", "), custom: Boolean(custom), note: question.note || "" };
	});
}

export function askResult(session) {
	return encodeOverlayResult("Submit", { answers: askAnswers(session) });
}
