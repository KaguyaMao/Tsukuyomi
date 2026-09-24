/** Geometry contract for the Grok Build-style full-column composer. */
export function wideComposerGeometry(width, maxRows) {
	const columns = Math.max(1, Math.floor(Number(width) || 1));
	const minimal = columns < 8 || maxRows < 2;
	const paddingX = 2;
	const chromeWidth = paddingX + 1;
	const contentWidth = Math.max(1, columns - chromeWidth * 2);
	return {
		columns,
		minimal,
		paddingX,
		chromeWidth,
		contentWidth,
		statusAvailable: Math.max(0, columns - chromeWidth * 2),
	};
}
