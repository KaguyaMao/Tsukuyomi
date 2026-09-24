import { parsePlanSections } from "./plan-review.mjs";
import { encodeOverlayResult } from "./overlay-result.mjs";

function cloneSection(section) {
	return { level: section.level, title: section.title, lines: [...section.lines], annotations: section.annotations.map((item) => ({ ...item })) };
}

export function createPlanSession({ body, options, slider = [] }) {
	const sections = parsePlanSections(body).map((section) => ({ ...section, annotations: [] }));
	return { sections, deleted: [], undo: [], options: [...options], selected: 0, focus: "actions", scroll: 0, toc: 0, slider: [...slider], sliderIndex: 0, annotating: false, draft: "", target: null };
}

function headings(session) {
	return session.sections.map((section, index) => ({ section, index })).filter((item) => item.section.level >= 1);
}

function deletionSpan(sections, index) {
	const level = sections[index]?.level || 0;
	if (level < 1) return [];
	const span = [index];
	for (let cursor = index + 1; cursor < sections.length; cursor++) {
		if (sections[cursor].level >= 1 && sections[cursor].level <= level) break;
		span.push(cursor);
	}
	return span;
}

function snapshot(session) {
	session.undo.push({ sections: session.sections.map(cloneSection), deleted: [...session.deleted] });
	if (session.undo.length > 30) session.undo.shift();
}

export function planFeedback(session) {
	const notes = session.sections.filter((section) => section.annotations.length);
	if (!notes.length && !session.deleted.length) return "";
	const lines = ["Refinement feedback on the plan:"];
	if (session.deleted.length) lines.push("", "Remove these sections:", ...session.deleted.map((title) => `- ${title}`));
	for (const section of notes) {
		lines.push("", `## ${section.title || "Plan"}`);
		for (const note of section.annotations) lines.push(`- ${note.note}`);
	}
	return lines.join("\n");
}

export function joinPlan(session) {
	return session.sections.map((section) => section.lines.join("\n")).join("\n").trim();
}

export function planCommand(session, command, value = "") {
	const list = headings(session);
	const regions = list.length >= 2 ? ["toc", "body", "actions"] : ["body", "actions"];
	if (session.annotating) {
		if (command === "cancel") { session.annotating = false; session.draft = ""; return "annotation-closed"; }
		if (command === "submit") {
			const note = String(value || session.draft || "").trim();
			const section = session.sections[session.target?.index];
			if (note && section) { snapshot(session); section.annotations.push({ note }); }
			session.annotating = false; session.draft = "";
			return "annotated";
		}
		if (command === "type") session.draft += value;
		if (command === "backspace") session.draft = [...session.draft].slice(0, -1).join("");
		return "draft";
	}
	if (command === "tab" || command === "shift-tab") {
		const current = Math.max(0, regions.indexOf(session.focus));
		const delta = command === "tab" ? 1 : -1;
		session.focus = regions[(current + delta + regions.length) % regions.length];
		return "focus";
	}
	if (command === "left" && session.focus === "actions" && session.slider.length) {
		session.sliderIndex = Math.max(0, session.sliderIndex - 1); return "slider";
	}
	if (command === "right" && session.focus === "actions" && session.slider.length) {
		session.sliderIndex = Math.min(session.slider.length - 1, session.sliderIndex + 1); return "slider";
	}
	if (command === "up" && session.focus === "actions") {
		if (session.selected <= 0) session.focus = "body"; else session.selected -= 1;
		return "move";
	}
	if (command === "down" && session.focus === "actions") {
		session.selected = Math.min(session.options.length - 1, session.selected + 1); return "move";
	}
	if (command === "up" && session.focus === "toc") { session.toc = Math.max(0, session.toc - 1); return "toc"; }
	if (command === "down" && session.focus === "toc") {
		if (session.toc >= list.length - 1) session.focus = "actions"; else session.toc += 1;
		return "toc";
	}
	if ((command === "right" || command === "enter") && session.focus === "toc") { session.focus = "body"; return "focus"; }
	if (command === "left" && session.focus === "body" && regions.includes("toc")) { session.focus = "toc"; return "focus"; }
	if (command === "enter" && session.focus === "body") { session.focus = "actions"; return "focus"; }
	if (command === "scroll") { session.scroll += Number(value) || 0; return "scroll"; }
	if (command === "top") { session.scroll = 0; return "scroll"; }
	if (command === "bottom") { session.scroll = Number.MAX_SAFE_INTEGER; return "scroll"; }
	if (command === "delete" && session.focus === "toc") {
		const heading = list[session.toc];
		const span = heading ? deletionSpan(session.sections, heading.index) : [];
		if (!span.length) return "noop";
		snapshot(session);
		for (const index of span) if (session.sections[index].level >= 1) session.deleted.push(session.sections[index].title);
		for (let index = span.length - 1; index >= 0; index--) session.sections.splice(span[index], 1);
		session.toc = Math.min(session.toc, Math.max(0, headings(session).length - 1));
		return "edited";
	}
	if (command === "undo" && session.focus !== "actions") {
		const entry = session.undo.pop();
		if (!entry) return "noop";
		session.sections = entry.sections; session.deleted = entry.deleted;
		return "edited";
	}
	if (command === "annotate" && session.focus !== "actions") {
		const heading = list[session.focus === "toc" ? session.toc : Math.min(session.toc, list.length - 1)];
		session.target = { index: heading?.index ?? 0 };
		session.annotating = true; session.draft = "";
		return "annotate";
	}
	if (command === "copy") return "copy";
	if (command === "editor") return "editor";
	if (command === "enter" && session.focus === "actions") return "confirm";
	if (command === "cancel") return "cancel";
	return "noop";
}

export function planResult(session) {
	return encodeOverlayResult(session.options[session.selected], {
		planText: joinPlan(session),
		feedback: planFeedback(session),
		slider: session.slider[session.sliderIndex] || undefined,
	});
}
