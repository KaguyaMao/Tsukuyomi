export function filterSelectOptions(options, descriptions, query) {
	const needle = String(query || "").trim().toLocaleLowerCase();
	if (!needle) return [...options];
	return options.filter((option) => `${option} ${descriptions?.get?.(option) || ""}`.toLocaleLowerCase().includes(needle));
}

export function selectListState({ options, kind = "select", selected = 0, searchable, descriptions }) {
	const allOptions = Array.isArray(options) ? options.filter((option) => typeof option === "string") : [];
	return {
		options: [...allOptions],
		allOptions,
		descriptions,
		searchable: searchable ?? (kind === "select" && allOptions.length >= 8),
		query: "",
		selected: Math.max(0, Math.min(allOptions.length - 1, Math.floor(Number(selected) || 0))),
	};
}
