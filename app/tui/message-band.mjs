/** Render the full-column Grok-style user prompt band. Dependencies are
 * injected from the active TUI so this leaf stays independent of terminal,
 * locale and theme singletons. */
export function renderUserMessageBand({
	width,
	prompt,
	timestamp,
	owner,
	locale,
	visibleWidth,
	pad,
	promptPrefix,
	textRows,
	formatTime,
	bandBackground,
	color,
}) {
	const bandWidth = Math.max(1, width - 2);
	const prefix = promptPrefix(Math.max(1, Math.floor(bandWidth * 0.45)));
	const prefixWidth = visibleWidth(prefix);
	const timeText = timestamp != null ? ` ${formatTime(timestamp, locale)}` : "";
	const timeWidth = visibleWidth(timeText);
	const promptWidth = Math.max(1, bandWidth - prefixWidth - 1 - timeWidth);
	const rows = [];
	const { rows: lines, sgr } = textRows(owner, "band", prompt, promptWidth);
	for (let index = 0; index < lines.length; index++) {
		let row = index > 0
			? `${" ".repeat(prefixWidth + 1)}${sgr ? lines[index] : color.text(lines[index])}`
			: `${prefix} ${sgr ? (lines[0] || " ") : color.text(lines[0] || " ")}`;
		if (index === 0 && timeWidth > 0) {
			row = pad(row, Math.max(2, bandWidth - timeWidth - 1)) + timeText;
		}
		rows.push(bandBackground(pad(row, bandWidth)));
	}
	const blank = bandBackground(" ".repeat(bandWidth));
	const content = rows.length ? rows : [bandBackground(pad(`${prefix} `, bandWidth))];
	// Preserve Grok Build's breathing room above and below even a one-line prompt.
	return [blank, ...content, blank];
}
