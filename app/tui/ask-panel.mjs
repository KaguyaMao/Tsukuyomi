/** OMP Ask panel structure: tab chips, question, separate option descriptions,
 * and a stable bottom panel. Tsukuyomi still answers one Pi select at a time. */

export function askPanelModel({ width, height, questions = [], index = 0, options = [], selected = 0, answers = [] }) {
	const columns = Math.max(24, Math.floor(Number(width) || 80));
	const rows = Math.max(10, Math.floor(Number(height) || 24));
	const boxHeight = Math.max(10, Math.min(rows - 1, Math.floor(rows * 0.7)));
	const boxWidth = Math.max(24, Math.min(columns - 2, Math.floor(columns * 0.92)));
	const list = Array.isArray(questions) && questions.length ? questions : [{ header: "Question", question: "" }];
	const current = Math.max(0, Math.min(list.length - 1, Math.floor(Number(index) || 0)));
	const choices = Array.isArray(options) ? options : [];
	return {
		title: "Ask",
		boxWidth,
		boxHeight,
		top: Math.max(0, rows - boxHeight),
		left: Math.max(0, Math.floor((columns - boxWidth) / 2)),
		tabs: list.map((question, tab) => ({
			label: String(question.header || `Q${tab + 1}`).slice(0, 12),
			active: tab === current,
			done: tab < current || Boolean(answers[tab]),
		})),
		question: String(list[current]?.question || ""),
		options: choices.map((option, optionIndex) => ({
			label: String(option.label || option),
			description: option.description ? String(option.description) : "",
			recommended: Boolean(option.recommended),
			selected: optionIndex === selected,
			value: option.value,
		})),
		selected: Math.max(0, Math.min(Math.max(0, choices.length - 1), Math.floor(Number(selected) || 0))),
		help: "↑↓ move · Enter select · Esc cancel · answered tabs stay visible",
	};
}
