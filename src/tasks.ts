import { Type } from "typebox";
import { TaskClient } from "../app/task-client.mjs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerTasks(pi: ExtensionAPI) {
	const client = new TaskClient();
	const wait = async (job: any, signal: AbortSignal | undefined, update: any) => {
		const cancel = () => { void client.request("cancel", { id: job.id }).catch(() => {}); };
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			while (!job.endedAt) {
				if (signal?.aborted) { cancel(); throw new Error("Task cancelled"); }
				await new Promise((resolve) => setTimeout(resolve, 150)); job = await client.request("get", { id: job.id });
				update?.({ content: [{ type: "text", text: job.output }], details: { ...job, jobId: job.id } });
			}
			return { content: [{ type: "text" as const, text: job.output || `Exit ${job.exitCode}` }], details: { ...job, jobId: job.id }, isError: job.status === "error" || job.status === "cancelled" };
		} finally { signal?.removeEventListener("abort", cancel); }
	};
	pi.registerTool({ name: "pty", label: "Interactive terminal", description: "Run a command in a real PTY. Live output appears inline; the user can type into its terminal. Set background:true for a long-running service and use tasks to inspect/cancel it.",
		parameters: Type.Object({ command: Type.String(), background: Type.Optional(Type.Boolean()) }),
		async execute(id, params, signal, update, ctx) { const job = await client.request("pty.start", { ...params, cwd: ctx.cwd, toolCallId: id }); return params.background ? { content: [{ type: "text", text: `Background task ${job.id}` }], details: { ...job, jobId: job.id } } : wait(job, signal, update); },
	});
	pi.registerTool({ name: "subagent", label: "Subagents / 子代理", description: "Optional user-controlled subagents. Disabled by default; only the user may enable them in /tools. Start isolated work with task and readonly; inspect the returned patch, then action:apply to integrate and validate. Maximum 3 workers, no recursive delegation. action:get/cancel/steer use id.",
		parameters: Type.Object({ action: Type.Optional(Type.String()), task: Type.Optional(Type.String()), readonly: Type.Optional(Type.Boolean()), id: Type.Optional(Type.String()), message: Type.Optional(Type.String()) }),
		async execute(id, params, signal, update, ctx) {
			if (params.action && params.action !== "start") { const result = await client.request(params.action, params); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; }
			if (!params.task?.trim()) throw new Error("task is required");
			const job = await client.request("subagent.start", { ...params, cwd: ctx.cwd, toolCallId: id, depth: Number(process.env.TSUKUYOMI_SUBAGENT || 0), provider: ctx.model?.provider, model: ctx.model?.id });
			return wait(job, signal, update);
		},
	});
	pi.registerTool({ name: "tasks", label: "Background tasks", description: "List/get/cancel background jobs; use id for get/cancel. This tool cannot enable or create subagents.", parameters: Type.Object({ action: Type.String(), id: Type.Optional(Type.String()) }),
		async execute(_id, params) { if (!["list", "get", "cancel"].includes(params.action)) throw new Error("Use list/get/cancel"); const result = await client.request(params.action, params); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; },
	});
	pi.registerCommand("review", { description: "Review working changes, a commit, or branch: /review [target]", handler: async (args, ctx) => {
		const prompt = `Review ${args.trim() || "the uncommitted changes"} in this workspace. Do not modify files. Report actionable issues with P0–P3 priority, file:line, evidence and a final verdict. Only use review subagents if the user has enabled subagent in /tools, and all reviewers must be read-only.`;
		pi.sendUserMessage(prompt, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
	} });
	pi.on("session_shutdown", () => client.close());
}
