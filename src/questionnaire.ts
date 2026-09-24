import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { structuredSelect } from "./structured-ui.ts";
import { decodeOverlayResult } from "../app/tui/overlay-result.mjs";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short choice label" }),
	description: Type.Optional(Type.String({ description: "Consequence or tradeoff" })),
	value: Type.Optional(Type.String({ description: "Stable returned value; defaults to label" })),
	recommended: Type.Optional(Type.Boolean({ description: "Mark the suggested choice" })),
});
const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable answer key" }),
	header: Type.Optional(Type.String({ description: "Short category, at most 12 characters when practical" })),
	question: Type.String({ description: "One concrete question" }),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Two to four mutually exclusive choices" })),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow a free-form response; defaults to true" })),
});

export function registerQuestionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Ask user / 询问用户",
		description: "Ask the user up to three concise clarification questions. Prefer 2–4 concrete options, put the recommended option first, explain tradeoffs, and allow a custom answer. Use only when the answer materially changes the plan.",
		parameters: Type.Object({ questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 3 }) }),
		async execute(_id, params, signal, _update, ctx) {
			if (!ctx.hasUI) return { content: [{ type: "text" as const, text: "Cannot ask questions: interactive UI is unavailable." }], details: { cancelled: true }, isError: true };
			const questions = params.questions.slice(0, 3);
			if (ctx.mode === "rpc") {
				const encoded = await structuredSelect(ctx, "questionnaire", "Ask", ["Submit"], {
					mode: "batch",
					questions: questions.map((item) => ({ id: item.id, header: item.header, question: item.question, allowOther: item.allowOther, options: (item.options || []).slice(0, 4) })),
				});
				if (signal?.aborted) throw new Error("Questionnaire cancelled");
				const decoded = decodeOverlayResult(encoded, ["Submit"]);
				const answers = Array.isArray(decoded.extra?.answers) ? decoded.extra.answers.filter((answer) => answer && typeof answer.id === "string") : [];
				if (!encoded || decoded.choice !== "Submit" || !answers.length) return { content: [{ type: "text" as const, text: "User cancelled the questionnaire." }], details: { questions: params.questions, answers, cancelled: true } };
				return { content: [{ type: "text" as const, text: answers.map((answer) => `${answer.id}: ${answer.value}`).join("\n") }], details: { questions: params.questions, answers, cancelled: false } };
			}
			const answers: Array<{ id: string; value: string; label: string; custom: boolean }> = [];
			while (true) {
			answers.length = 0;
			for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
				const question = questions[questionIndex];
				if (signal?.aborted) throw new Error("Questionnaire cancelled");
				const options = (question.options || []).slice(0, 4);
				const labels = options.map((option, index) => `${index + 1}. ${option.recommended ? "★ " : ""}${option.label}${option.description ? ` — ${option.description}` : ""}`);
				const allowOther = question.allowOther !== false;
				const other = "Other / 其他（输入自定义回答）";
				if (!labels.length && !allowOther) throw new Error(`Question ${question.id} has no answer options`);
				let selected: string | undefined;
				if (labels.length) selected = await structuredSelect(ctx, "questionnaire", `${question.header ? `${question.header} · ` : ""}${question.question}`, allowOther ? [...labels, other] : labels, {
					index: questionIndex,
					total: questions.length,
					questions: questions.map((item) => ({ id: item.id, header: item.header, question: item.question })),
					question: { header: question.header, question: question.question },
					options: [...options.map((option) => ({ label: option.label, description: option.description, recommended: option.recommended, value: option.value || option.label })), ...(allowOther ? [{ label: other, value: other }] : [])],
					answers,
				});
				else selected = other;
				if (!selected) return { content: [{ type: "text" as const, text: "User cancelled the questionnaire." }], details: { questions: params.questions, answers, cancelled: true } };
				if (selected === other) {
					const custom = await ctx.ui.input(question.question, "Type your answer");
					if (custom === undefined) return { content: [{ type: "text" as const, text: "User cancelled the questionnaire." }], details: { questions: params.questions, answers, cancelled: true } };
					answers.push({ id: question.id, value: custom.trim(), label: custom.trim(), custom: true });
				} else {
					const index = labels.indexOf(selected);
					const option = options[index];
					if (!option) throw new Error("Invalid questionnaire selection");
					answers.push({ id: question.id, value: option.value || option.label, label: option.label, custom: false });
				}
				if (signal?.aborted) throw new Error("Questionnaire cancelled");
			}
			const submit = "Submit answers / 提交回答";
			const edit = "Edit answers / 修改回答";
			const cancel = "Cancel / 取消";
			const decision = await structuredSelect(ctx, "questionnaire", "Review answers / 确认回答", [submit, edit, cancel], {
				index: questions.length, total: questions.length + 1,
				questions: [...questions.map((item) => ({ id: item.id, header: item.header, question: item.question })), { id: "review", header: "Submit", question: "Confirm your answers before submitting." }],
				question: { header: "Submit", question: "Confirm your answers before submitting." },
				options: [{ label: submit }, { label: edit }, { label: cancel }],
				answers,
			});
			if (signal?.aborted) throw new Error("Questionnaire cancelled");
			if (decision === edit) continue; // restart without submitting partial answers
			if (decision !== submit) return { content: [{ type: "text" as const, text: "User cancelled the questionnaire." }], details: { questions: params.questions, answers, cancelled: true } };
			return {
				content: [{ type: "text" as const, text: answers.map((answer) => `${answer.id}: ${answer.value}`).join("\n") }],
				details: { questions: params.questions, answers, cancelled: false },
			};
			}
		},
	});
}
