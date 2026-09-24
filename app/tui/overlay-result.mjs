const MARK = "\u2063";

export function encodeOverlayResult(choice, extra) {
	const label = String(choice || "");
	if (!extra) return label;
	return `${label}${MARK}${JSON.stringify(extra).slice(0, 100_000)}`;
}

export function decodeOverlayResult(value, choices = []) {
	const text = String(value || "");
	const split = text.indexOf(MARK);
	const choice = split < 0 ? text : text.slice(0, split);
	if (choices.length && !choices.includes(choice)) return { choice: text, extra: undefined };
	if (split < 0) return { choice, extra: undefined };
	try {
		const extra = JSON.parse(text.slice(split + MARK.length));
		return { choice, extra: extra && typeof extra === "object" ? extra : undefined };
	} catch {
		return { choice, extra: undefined };
	}
}
