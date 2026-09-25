/** Geometry contract for the compact full-column OMP-style composer. */
export function wideComposerGeometry(width, maxRows) {
	const columns = Math.max(1, Math.floor(Number(width) || 1));
	const minimal = columns < 8 || maxRows < 2;
	const paddingX = 1;
	const chromeWidth = paddingX * 2 + 2;
	const contentWidth = Math.max(1, columns - chromeWidth);
	return {
		columns,
		minimal,
		paddingX,
		chromeWidth,
		contentWidth,
		statusAvailable: Math.max(0, columns - 6),
	};
}
