import officialPlan from "./vendor/plan-mode/index.ts";
import { isSafeCommand } from "./vendor/plan-mode/utils.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolPolicyApi } from "./tool-policy.ts";

/** UI adapter around the unmodified Pi 0.84.4 example; no second mode engine. */
export function registerPlanBridge(pi: ExtensionAPI, policy: ToolPolicyApi) {
	let planning = false;
	let context: ExtensionContext | undefined;
	let toggle: any;
	const publish = () => context?.ui.setStatus("tsukuyomi-mode", planning ? "Plan" : "Build");
	const adapter = new Proxy(pi, { get(target, key) {
		if (key === "registerCommand") return (name: string, command: any) => {
			if (name === "plan") toggle = command.handler;
			return target.registerCommand(name, command);
		};
		if (key === "setActiveTools") return (names: string[]) => target.setActiveTools(policy.prune(names));
		if (key === "appendEntry") return (name: string, data: any) => {
			const result = target.appendEntry(name, data);
			if (name === "plan-mode") { planning = !!data.enabled; publish(); if (context) policy.publish(context); }
			return result;
		};
		return Reflect.get(target, key);
	} });
	officialPlan(adapter);
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		const entry = ctx.sessionManager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "plan-mode").at(-1) as any;
		planning = entry?.data?.enabled ?? pi.getFlag("plan") === true;
		publish();
	});
	pi.on("tool_call", (event) => {
		if (!planning) return;
		if (event.toolName === "pty" && !isSafeCommand(String((event.input as any).command || ""))) return { block: true, reason: "Plan mode: PTY command is not read-only." };
		if (event.toolName === "subagent" && !(event.input as any).readonly) return { block: true, reason: "Plan mode permits only read-only subagents." };
		if (event.toolName === "lsp" && ((event.input as any).apply || ["rename", "format", "code_actions"].includes((event.input as any).action))) return { block: true, reason: "Plan mode: use read-only LSP operations." };
	});
	return {
		isPlanning: () => planning,
		async setMode(ctx: ExtensionContext, mode: string) {
			context = ctx;
			if (mode !== "build" && mode !== "plan") throw new Error("Use /mode build|plan");
			if ((mode === "plan") !== planning) await toggle("", ctx);
			publish();
		},
		reapply(ctx: ExtensionContext) { pi.setActiveTools(policy.prune(pi.getActiveTools())); policy.publish(ctx); },
	};
}
