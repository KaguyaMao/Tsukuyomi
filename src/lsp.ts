import { Type } from "typebox";
import { LspManager } from "../app/lsp.mjs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerLsp(pi: ExtensionAPI) {
	let manager: LspManager;
	const get = (cwd: string) => manager ||= new LspManager(cwd, process.env.PI_CODING_AGENT_DIR || cwd);
	pi.registerTool({ name: "lsp", label: "LSP", description: "Code intelligence: status, diagnostics, definition, references, hover, symbols, workspace_symbols, rename, format, code_actions. Positions are 1-based UTF-16. Mutating operations return a preview token; apply:true with that token applies exactly the preview after checking file versions.",
		parameters: Type.Object({ action: Type.String(), file: Type.Optional(Type.String()), line: Type.Optional(Type.Number()), column: Type.Optional(Type.Number()), query: Type.Optional(Type.String()), newName: Type.Optional(Type.String()), apply: Type.Optional(Type.Boolean()), token: Type.Optional(Type.String()) }),
		async execute(_id, params, signal, _update, ctx) { const result = await get(ctx.cwd).execute(params, signal); return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result }; },
	});
	pi.registerCommand("lsp", { description: "Language server status", handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(await get(ctx.cwd).execute({ action: "status" }), null, 2), "info") });
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || !["edit", "write"].includes(event.toolName)) return;
		const file = (event.input as any)?.path; if (!file) return;
		try {
			const result = await get(ctx.cwd).execute({ action: "diagnostics", file }, AbortSignal.timeout(5000));
			return { content: [...event.content, { type: "text" as const, text: `LSP diagnostics: ${JSON.stringify(result)}` }] };
		} catch { /* Missing/slow LSP never turns a successful write into a failure. */ }
	});
	pi.on("session_shutdown", () => manager?.stop());
}
