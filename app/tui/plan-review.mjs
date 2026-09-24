/** OMP Plan Review geometry: one fullscreen box, scrolling plan body, optional
 * contents sidebar, and approval actions in the same surface. Colors stay with
 * the caller; this module only decides structure and focus. */

export function parsePlanSections(text) {
	const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
	const sections = [];
	let current = { level: 0, title: "Plan", lines: [] };
	const push = () => { if (current.lines.some((line) => line.trim()) || current.level) sections.push(current); };
	for (const line of lines) {
		const heading = /^(#{1,6})\s+(\S.*)$/.exec(line);
		if (heading) {
			push();
			current = { level: heading[1].length, title: heading[2].trim().slice(0, 120), lines: [line] };
		} else current.lines.push(line);
	}
	push();
	return sections.length ? sections : [{ level: 0, title: "Plan", lines: ["(empty plan)"] }];
}

function wrapLine(line, width, visibleWidth) {
	const text = String(line ?? "");
	if (visibleWidth(text) <= width) return [text];
	const rows = [];
	let row = "";
	for (const char of text) {
		if (visibleWidth(row + char) > width && row) { rows.push(row); row = char.trim() ? char : ""; }
		else row += char;
	}
	if (row) rows.push(row);
	return rows.length ? rows : [""];
}

export function layoutPlanReview({
	width,
	height,
	body,
	options,
	selected = 0,
	focus = "actions",
	scroll = 0,
	tocCursor = 0,
	slider = [],
	sliderIndex = 0,
	visibleWidth = (value) => String(value).length,
}) {
	const columns = Math.max(20, Math.floor(Number(width) || 80));
	const rows = Math.max(8, Math.floor(Number(height) || 24));
	const choices = Array.isArray(options) && options.length ? options.map(String) : ["Stay in plan mode"];
	const selectedIndex = Math.max(0, Math.min(choices.length - 1, Math.floor(Number(selected) || 0)));
	const sections = parsePlanSections(body);
	const headings = sections.map((section, index) => ({ ...section, index })).filter((section) => section.level >= 1);
	const sidebar = columns >= 72 && headings.length >= 2;
	const sidebarWidth = sidebar ? Math.max(18, Math.min(28, Math.round(columns * 0.24))) : 0;
	const inner = Math.max(8, columns - 4);
	const bodyWidth = Math.max(8, sidebar ? inner - sidebarWidth - 3 : inner);
	const chrome = 6 + choices.length + (slider.length ? 1 : 0);
	const bodyRows = Math.max(3, rows - chrome);
	const flat = [];
	const sectionStarts = [];
	for (const section of sections) {
		sectionStarts.push(flat.length);
		for (const line of section.lines) flat.push(...wrapLine(line, bodyWidth, visibleWidth));
	}
	if (!flat.length) flat.push("(empty plan)");
	const maxScroll = Math.max(0, flat.length - bodyRows);
	const start = Math.max(0, Math.min(maxScroll, Math.floor(Number(scroll) || 0)));
	const toc = Math.max(0, Math.min(Math.max(0, headings.length - 1), Math.floor(Number(tocCursor) || 0)));
	const view = flat.slice(start, start + bodyRows);
	while (view.length < bodyRows) view.push("");
	const regions = [];
	regions.push({ type: "top", title: "Plan Review", sidebar, sidebarWidth });
	for (let index = 0; index < bodyRows; index++) {
		const heading = headings[toc];
		const side = sidebar ? (index < headings.length ? `${index === toc ? "›" : " "} ${headings[index].title}` : "") : "";
		regions.push({ type: "body", text: view[index], side, sectionIndex: heading?.index, row: start + index, sidebar, sidebarWidth, focused: focus === "body" || focus === "toc" });
	}
	regions.push({ type: "divider", sidebar, sidebarWidth });
	if (slider.length) regions.push({ type: "slider", label: slider[Math.max(0, Math.min(slider.length - 1, sliderIndex))] || "", index: sliderIndex, count: slider.length });
	regions.push({ type: "prompt", text: "Plan mode — what next?" });
	choices.forEach((label, index) => regions.push({ type: "option", label, index, selected: index === selectedIndex, focused: focus === "actions" }));
	regions.push({ type: "divider" });
	const help = focus === "toc"
		? "↑↓ section · → body · Tab regions · Esc cancel"
		: focus === "body"
			? "↑↓ scroll · PgUp/PgDn · g/G · Tab actions · Esc cancel"
			: `↑↓ select · Enter confirm · ${slider.length ? "←→ thinking · " : ""}Tab body · a note · d delete · u undo · Esc cancel`;
	regions.push({ type: "help", text: help });
	regions.push({ type: "bottom" });
	return {
		sidebar,
		sidebarWidth,
		bodyWidth,
		bodyRows,
		sections,
		headings,
		selected: selectedIndex,
		focus: ["actions", "body", "toc"].includes(focus) ? focus : "actions",
		scroll: start,
		maxScroll,
		toc,
		sectionStarts,
		regions,
	};
}
