/** Build a viewport over a selectable list where section headings use rows. */
export function providerListWindow({ options, sections, selectedIndex, rowCount, selectedDescription }) {
	const entries = [];
	let previousSection;
	let selectedRow = 0;
	for (let index = 0; index < options.length; index++) {
		const value = options[index];
		const section = sections?.get(value);
		if (section && section !== previousSection) {
			entries.push({ kind: "section", section });
			previousSection = section;
		}
		if (index === selectedIndex) selectedRow = entries.length;
		entries.push({ kind: "option", index, value });
		if (index === selectedIndex && selectedDescription) entries.push({ kind: "description", text: selectedDescription });
	}
	const capacity = Math.max(1, Math.floor(rowCount) || 1);
	const firstRow = Math.max(0, Math.min(Math.max(0, entries.length - capacity), selectedRow - Math.floor(capacity / 2)));
	return entries.slice(firstRow, firstRow + capacity);
}
