export const TUI_KEYBINDING_PRESETS = Object.freeze({
	omp: Object.freeze({
		"model.cycleForward": ["ctrl+p"],
		"model.cycleBackward": ["ctrl+shift+p"],
		"model.select": ["alt+m"],
		"hub.open": ["alt+a"],
		"mode.toggle": ["alt+shift+p"],
		"tools.expand": ["ctrl+o"],
		"thinking.toggle": ["ctrl+t"],
		"thinking.cycle": ["shift+tab"],
		"message.followUp": ["ctrl+q", "ctrl+enter"],
		// Tsukuyomi additions retained alongside the OMP chord set.
		"files.toggle": ["ctrl+b"],
		"sessions.open": ["ctrl+s"],
	}),
	legacy: Object.freeze({
		"palette.open": ["ctrl+p"],
		"sessions.open": ["ctrl+s"],
		"mode.toggle": ["shift+tab"],
		"files.toggle": ["ctrl+b"],
		"workflow.toggle": ["ctrl+o"],
		"todo.toggle": ["ctrl+t"],
		"message.followUp": ["alt+enter"],
		"message.interrupt": ["ctrl+enter"],
		"thinking.expand": ["ctrl+e"],
	}),
});

const CHORD = /^(?:(?:ctrl|alt|shift|meta)\+)*(?:[a-z0-9]|enter|tab|escape|space|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right|f(?:[1-9]|1[0-2])|ctrl\+\])$/i;

function normalizeOverrides(overrides) {
	if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return {};
	const normalized = {};
	for (const [action, value] of Object.entries(overrides)) {
		if (!/^[a-z][a-zA-Z0-9_.-]{0,63}$/.test(action)) continue;
		const chords = Array.isArray(value) ? value : [value];
		if (!chords.every((chord) => typeof chord === "string" && chord.length <= 48 && CHORD.test(chord))) continue;
		normalized[action] = [...new Set(chords.map((chord) => chord.toLowerCase()))];
	}
	return normalized;
}

/** Resolve preset and explicit per-action overrides; [] deliberately unbinds. */
export function resolveTuiKeybindings(preset = "omp", overrides = {}) {
	const base = TUI_KEYBINDING_PRESETS[preset] || TUI_KEYBINDING_PRESETS.omp;
	return Object.freeze({ ...base, ...normalizeOverrides(overrides) });
}

export function matchesTuiAction(data, action, bindings, matchesKey) {
	return (bindings?.[action] || []).some((chord) => matchesKey(data, chord));
}
