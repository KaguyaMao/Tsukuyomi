export const MODES = ["build", "plan"] as const;
export type AgentMode = (typeof MODES)[number];

export const MODE_LABEL: Record<AgentMode, string> = {
	build: "Build",
	plan: "Plan",
};

export function nextMode(current: AgentMode): AgentMode {
	return MODES[(MODES.indexOf(current) + 1) % MODES.length]!;
}
