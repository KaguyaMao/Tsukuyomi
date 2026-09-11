import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

const KNOWN_CUSTOM_TOOLS = ["todo", "web_fetch", "web_search", "pty", "tasks", "lsp", "subagent"];

export interface ToolState {
	disabled: string[];
	subagents?: boolean;
}

export interface ToolPolicyApi {
	isEnabled(name: string): boolean;
	enabled(name: string, on: boolean): boolean;
	prune(names: string[]): string[];
	publish(ctx: ExtensionContext): void;
	installGuard(): void;
}

function stateFile(): string | undefined {
	const root = process.env.PI_CODING_AGENT_DIR;
	if (!root) return undefined;
	return join(root, "tsukuyomi-tools.json");
}

/** Previous state file name, read once so an in-place config dir keeps working. */
function legacyStateFile(): string | undefined {
	const root = process.env.PI_CODING_AGENT_DIR;
	if (!root) return undefined;
	return join(root, "kaguya-tools.json");
}

function readStateFile(path: string): ToolState | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		const disabled = Array.isArray(parsed.disabled) ? parsed.disabled.map(String) : [];
		if (parsed.subagents !== true && !disabled.includes("subagent")) disabled.push("subagent");
		return { disabled, subagents: parsed.subagents === true };
	} catch {
		return undefined;
	}
}

function loadState(): ToolState {
	const legacy = legacyStateFile();
	return readStateFile(stateFile()!) ??
		(legacy ? readStateFile(legacy) : undefined) ??
		{ disabled: ["subagent"], subagents: false };
}

/** Tsukuyomi's long-running /tools policy: which tools the agent may call. */
export function createToolPolicy(pi: ExtensionAPI): ToolPolicyApi {
	const state = loadState();
	const disabled = new Set(state.disabled);

	const persist = (): void => {
		const path = stateFile();
		if (!path) return;
		try {
			mkdirSync(dirname(path), { recursive: true });
			const temp = `${path}.${process.pid}.tmp`;
			writeFileSync(temp, `${JSON.stringify({ disabled: [...disabled], subagents: !disabled.has("subagent") }, null, 2)}\n`, { mode: 0o600 });
			renameSync(temp, path);
		} catch {
			// The tool policy is best-effort persistence; the kernel keeps running.
		}
	};

	const buildPayload = (): { available: string[]; active: string[]; disabled: string[]; labels: Record<string, string> } => {
		const fromKernel = new Set<string>();
		const labels: Record<string, string> = {};
		try {
			for (const tool of pi.getAllTools()) {
				if (!tool?.name) continue;
				fromKernel.add(tool.name);
				labels[tool.name] = tool.description?.split("\n")[0]?.slice(0, 80) ?? tool.name;
			}
		} catch {
			// Some kernels may not expose tool info; fall back to known names.
		}
		for (const name of KNOWN_CUSTOM_TOOLS) {
			fromKernel.add(name);
			labels[name] = labels[name] ?? TOOL_LABELS[name] ?? name;
		}
		const active = pi.getActiveTools().filter((name) => !disabled.has(name));
		return { available: [...fromKernel].sort(), active: [...active].sort(), disabled: [...disabled].sort(), labels };
	};

	return {
		isEnabled(name: string): boolean {
			return !disabled.has(name);
		},
		enabled(name: string, on: boolean): boolean {
			const latest = loadState(); disabled.clear(); for (const value of latest.disabled) disabled.add(value);
			if (on ? !disabled.has(name) : disabled.has(name)) return false;
			if (on) disabled.delete(name);
			else disabled.add(name);
			persist();
			return true;
		},
		prune(names: string[]): string[] {
			return names.filter((name) => !disabled.has(name));
		},
		publish(ctx: ExtensionContext): void {
			try {
				ctx.ui.setWidget("tsukuyomi-tools-payload", [JSON.stringify(buildPayload())]);
			} catch {
				// Widget publishing is best-effort.
			}
		},
		installGuard(): void {
			pi.on("tool_call", (event: ToolCallEvent): ToolCallEventResult | void => {
				// Another workspace may have changed the user-wide policy.
				const latest = loadState(); disabled.clear(); for (const name of latest.disabled) disabled.add(name);
				if (disabled.has(event.toolName)) {
					return {
						block: true,
						reason: `Tool "${event.toolName}" is disabled. Enable it with /tools (or /ktools on ${event.toolName}).`,
					};
				}
			});
		},
	};
}

const TOOL_LABELS: Record<string, string> = {
	read: "Read files",
	edit: "Edit file",
	write: "Write file",
	bash: "Shell command",
	powershell: "PowerShell command",
	glob: "Find files",
	grep: "Search file contents",
	list: "List directory",
	ls: "List directory",
	find: "Search files",
	todo: "Todo list",
	web_fetch: "Fetch web page",
	web_search: "Web search",
	apply_patch: "Apply patch",
};
