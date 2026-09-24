import { ModelRuntime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { registerCompactPlugin, type CompactState } from "./compact.ts";
import { registerPlanBridge } from "./plan-bridge.ts";
import { registerLsp } from "./lsp.ts";
import { registerTasks } from "./tasks.ts";
import { registerAgentTeams } from "./agent-team.ts";
import { TaskClient } from "../app/task-client.mjs";
import { TodoStore } from "./todos.ts";
import { createToolPolicy, type ToolPolicyApi } from "./tool-policy.ts";
import type { AgentMode } from "./utils.ts";
import { MODE_LABEL } from "./utils.ts";
import { registerWebFetch } from "./web_fetch.ts";
import { registerWebSearch } from "./web_search.ts";
import { registerQuestionnaire } from "./questionnaire.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { removeProviderConfig, saveProviderConfig } from "../app/providers/config/opencode.mjs";
import { buildCustomProvider } from "../app/providers/config/discovery.mjs";
import { removeProviderFromModelsJson, syncProviderToModelsJson, toProviderConfigInput } from "../app/providers/config/sync.mjs";
import { writeStoredCredential } from "../app/providers/store.mjs";
import { getAgent, listAgents, deleteAgent } from "../app/agents.mjs";
import { activateAccount } from "../app/providers/accounts.mjs";

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

const ModeParams = new Set<AgentMode>(["build", "plan"]);

/**
 * Tsukuyomi's PI-side plugin. It intentionally contains no terminal rendering:
 * the independent Tsukuyomi process owns the entire TUI and PI runs as an RPC
 * kernel. Keeping this as a normal PI extension preserves the user's existing
 * extension/tool ecosystem.
 */
export default function tsukuyomiBackend(pi: ExtensionAPI): void {
	const compact: CompactState = { compactionStatus: "idle" };
	const todos = new TodoStore();
	const policy: ToolPolicyApi = createToolPolicy(pi);
	let mode: AgentMode = "build";

	const publishCompact = (ctx: ExtensionContext) => {
		const value = compact.compactionStatus === "idle"
			? undefined
			: `${compact.compactionStatus}${compact.compactionMessage ? ` · ${compact.compactionMessage}` : ""}`;
		ctx.ui.setStatus("tsukuyomi-compact", value);
	};

	registerCompactPlugin(pi, compact, publishCompact);

	const modes = registerPlanBridge(pi, policy);
	const agentDir = process.env.TSUKUYOMI_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".tsukuyomi", "agent");
	let activeAgent: any;
	const publishAgent = (ctx: ExtensionContext) => {
		ctx.ui.setStatus("tsukuyomi-agent", activeAgent?.name);
		ctx.ui.setWidget("tsukuyomi-agent-payload", activeAgent ? [JSON.stringify({
			id: activeAgent.id, name: activeAgent.name, description: activeAgent.description,
			provider: activeAgent.provider, model: activeAgent.model, thinking: activeAgent.thinking, mode: activeAgent.mode,
		})] : undefined);
	};
	const activateCustomAgent = async (agent: any, ctx: ExtensionContext, persist = true) => {
		if (!agent) throw new Error("Agent not found");
		if (agent.accountRef) {
			const providerId = typeof agent.accountRef === "object" ? agent.accountRef.providerId : agent.provider;
			const accountId = typeof agent.accountRef === "object" ? agent.accountRef.id : agent.accountRef;
			if (!providerId || !accountId || !activateAccount(agentDir, providerId, accountId)) throw new Error(`Unknown account for agent ${agent.id}`);
			await ctx.modelRegistry.refresh();
		}
		if (agent.provider && agent.model) {
			const model = ctx.modelRegistry.find(agent.provider, agent.model);
			if (!model) throw new Error(`Model not found: ${agent.provider}/${agent.model}`);
			if (!await pi.setModel(model)) throw new Error(`No configured credentials for ${agent.provider}`);
		}
		pi.setThinkingLevel(agent.thinking as any);
		if (Array.isArray(agent.tools)) pi.setActiveTools(policy.prune(agent.tools));
		if (agent.mode) {
			mode = agent.mode;
			await modes.setMode(ctx, agent.mode);
		}
		activeAgent = agent;
		if (persist) pi.appendEntry("tsukuyomi-agent", { id: agent.id, name: agent.name });
		publishAgent(ctx);
	};

	policy.installGuard();
	registerLsp(pi);
	registerQuestionnaire(pi);
	registerTasks(pi);
	registerAgentTeams(pi, agentDir, policy);
	registerWebFetch(pi);
	registerWebSearch(pi);

	pi.registerCommand("kagent", {
		description: "Manage saved agents: /kagent list | use <id> | delete <id>",
		handler: async (args, ctx) => {
			const [verb = "list", id] = args.trim().split(/\s+/);
			if (verb === "list") {
				const agents = listAgents(agentDir);
				ctx.ui.setWidget("tsukuyomi-agents-payload", [JSON.stringify({ agents: agents.map(({ systemPrompt: _prompt, ...item }) => item) })]);
				ctx.ui.notify(agents.length ? `Agents: ${agents.map((item) => `${item.id} (${item.name})`).join(", ")}` : "No saved agents", "info");
				return;
			}
			if (verb === "use" && id) {
				try { await activateCustomAgent(getAgent(agentDir, id), ctx); ctx.ui.notify(`Agent ${id} activated.`, "info"); }
				catch (error) { ctx.ui.notify(`Agent not activated: ${error instanceof Error ? error.message : String(error)}`, "error"); }
				return;
			}
			if (verb === "delete" && id) {
				ctx.ui.notify(deleteAgent(agentDir, id) ? `Agent ${id} deleted.` : `Agent ${id} not found.`, "info");
				return;
			}
			ctx.ui.notify("Usage: /kagent list | use <id> | delete <id>", "warning");
		},
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Maintain Tsukuyomi's visible Todo list. Keep it synchronized for multi-step work with add, toggle, list, and clear.",
		parameters: TodoParams,
		async execute(_toolCallId, params) {
			if (params.action === "add") {
				if (!params.text?.trim()) {
					return {
						content: [{ type: "text" as const, text: "Error: text is required for add" }],
						details: { action: "add", ...todos.snapshot(), error: "text required" },
					};
				}
				const item = todos.add(params.text.trim());
				return {
					content: [{ type: "text" as const, text: `Added todo #${item.id}: ${item.text}` }],
					details: { action: "add", ...todos.snapshot() },
				};
			}

			if (params.action === "toggle") {
				const item = params.id === undefined ? undefined : todos.toggle(params.id);
				return {
					content: [{
						type: "text" as const,
						text: item
							? `Todo #${item.id} ${item.done ? "completed" : "reopened"}: ${item.text}`
							: `Todo #${params.id ?? "?"} not found`,
					}],
					details: { action: "toggle", ...todos.snapshot(), ...(item ? {} : { error: "not found" }) },
				};
			}

			if (params.action === "clear") {
				const count = todos.clear();
				return {
					content: [{ type: "text" as const, text: `Cleared ${count} todos` }],
					details: { action: "clear", ...todos.snapshot() },
				};
			}

			const items = todos.list();
			return {
				content: [{
					type: "text" as const,
					text: items.length
						? items.map((item) => `[${item.done ? "x" : " "}] #${item.id}: ${item.text}`).join("\n")
						: "No todos",
				}],
				details: { action: "list", ...todos.snapshot() },
			};
		},
	});

	pi.registerCommand("kmode", {
		description: "Set the official Pi plan extension: /kmode build|plan",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase() as AgentMode;
			if (!ModeParams.has(requested)) {
				ctx.ui.notify("Usage: /kmode build|plan", "warning");
				return;
			}
			await modes.setMode(ctx, requested);
			mode = requested;
		},
	});

	pi.registerCommand("ktools", {
		description: "Enable or disable tools: /ktools list | on|off|toggle <tool>",
		handler: async (args, ctx) => {
			const [verb, ...rest] = args.trim().split(/\s+/);
			const name = rest.join(" ").trim();
			if (verb === "list") {
				const available = pi.getAllTools().map((tool) => tool.name);
				const active = pi.getActiveTools();
				const lines = available.map((tool) =>
					`${pi.getActiveTools().includes(tool) ? "on " : "off"} ${tool} ${policy.isEnabled(tool) ? "" : "(disabled by /tools)"}`,
				);
				ctx.ui.notify(
					`Tools:\n${lines.join("\n")}${lines.length ? "" : "\n(no tools reported)"}\nActive: ${active.join(", ")}`,
					"info",
				);
				return;
			}
			if (!name) {
				ctx.ui.notify("Usage: /ktools list | on <tool> | off <tool> | toggle <tool>", "warning");
				return;
			}
			if (!["on", "off", "toggle"].includes(verb)) {
				ctx.ui.notify("Usage: /ktools list | on <tool> | off <tool> | toggle <tool>", "warning");
				return;
			}
			const requested = verb === "toggle" ? !policy.isEnabled(name) : verb === "on";
			const changed = policy.enabled(name, requested);
			if (requested) pi.setActiveTools([...new Set([...pi.getActiveTools(), name])]);
			if (name === "subagent" && (process.env.TSUKUYOMI_TASK_SOCKET || process.env.KAGUYAPI_TASK_SOCKET)) {
				const client = new TaskClient();
				try { await client.request("policy"); } finally { client.close(); }
			}
			if (!changed) {
				ctx.ui.notify(`Tool "${name}" is already ${policy.isEnabled(name) ? "enabled" : "disabled"}.`, "info");
			} else {
				modes.reapply(ctx);
				ctx.ui.notify(`Tool "${name}" ${policy.isEnabled(name) ? "enabled" : "disabled"}.`, "info");
			}
		},
	});

	// JSON keeps this command scriptable while the TUI can layer a form on top of
	// it.  registerProvider is immediate; models.json preserves it for restarts.
	pi.registerCommand("kprovider", {
		description: "Manage providers: /kprovider list | add <json> | remove <id> | login-key <id> <key>",
		handler: async (args, ctx) => {
			const [verb = "list", ...rest] = args.trim().split(/\s+/);
			const agentDir = process.env.TSUKUYOMI_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".tsukuyomi", "agent");
			if (verb === "list") {
				try {
					// providers.json is the source of truth; models.json is derived.
					const providers = Object.keys(JSON.parse(readFileSync(join(agentDir, "providers.json"), "utf8"))?.provider || {});
					const names = providers.length ? providers : Object.keys(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"))?.providers || {});
					ctx.ui.setWidget("tsukuyomi-providers-payload", [JSON.stringify({ providers: names })]);
					ctx.ui.notify(names.length ? `Providers: ${names.join(", ")}` : "No custom providers", "info");
				} catch {
					ctx.ui.notify("No custom providers", "info");
				}
				return;
			}
			if (verb === "add") {
				try {
					const input = JSON.parse(rest.join(" "));
					const config = await buildCustomProvider(input);
					const id = config.id;
					saveProviderConfig(agentDir, id, config);
					syncProviderToModelsJson(agentDir, id, config);
					if (input.apiKey) {
						const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false, signal: AbortSignal.timeout(15_000) });
						await runtime.login(id, "api_key", { signal: AbortSignal.timeout(15_000), prompt: async () => input.apiKey, notify() {} });
					}
					pi.registerProvider(id, toProviderConfigInput(config));
					ctx.ui.setWidget("tsukuyomi-providers-payload", [JSON.stringify({ changed: id, action: "add" })]);
					ctx.ui.notify(`Provider ${id} added. Restart the Tsukuyomi frontend to refresh its RPC snapshot.`, "info");
				} catch (error) { ctx.ui.notify(`Provider not added: ${error instanceof Error ? error.message : String(error)}`, "error"); }
				return;
			}
			if (verb === "remove" && rest[0]) {
				try {
					pi.unregisterProvider(rest[0]);
					removeProviderConfig(agentDir, rest[0]);
					try { removeProviderFromModelsJson(agentDir, rest[0]); } catch {}
					ctx.ui.setWidget("tsukuyomi-providers-payload", [JSON.stringify({ changed: rest[0], action: "remove" })]);
					ctx.ui.notify(`Provider ${rest[0]} removed.`, "info");
				} catch (error) { ctx.ui.notify(`Provider not removed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
				return;
			}
			if (verb === "login-key" && rest.length >= 2) {
				const [id, ...keyParts] = rest; const key = keyParts.join(" ");
				try {
					writeStoredCredential(agentDir, id, { type: "api_key", key });
					ctx.ui.notify(`API key saved for ${id}. Restart the Tsukuyomi frontend to refresh its RPC snapshot.`, "info");
				} catch { ctx.ui.notify("Could not save provider API key.", "error"); }
				return;
			}
			ctx.ui.notify("Usage: /kprovider list | add <json> | remove <id> | login-key <id> <key>", "warning");
		},
	});

	const restoreTodos = (ctx: ExtensionContext) => {
		todos.restore([], 1);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message as {
				role?: string;
				toolName?: string;
				details?: { todos?: Array<{ id: number; text: string; done: boolean }>; nextId?: number };
			};
			if (message.role !== "toolResult" || message.toolName !== "todo" || !message.details?.todos) continue;
			todos.restore(message.details.todos, message.details.nextId ?? 1);
		}
	};

	pi.on("before_agent_start", (event) => {
		if (!activeAgent?.systemPrompt) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Active Tsukuyomi agent: ${activeAgent.name}\n${activeAgent.systemPrompt}`,
		};
	});

	pi.on("session_start", (_event, ctx) => {
		restoreTodos(ctx);
		const entry = ctx.sessionManager.getBranch().filter((item: any) => item.type === "custom" && item.customType === "tsukuyomi-agent").at(-1) as any;
		const restored = entry?.data?.id ? getAgent(agentDir, entry.data.id) : undefined;
		activeAgent = undefined;
		publishAgent(ctx);
		if (restored) void activateCustomAgent(restored, ctx, false).catch((error) => ctx.ui.notify(`Saved agent unavailable: ${error.message}`, "warning"));
		modes.reapply(ctx);
		setTimeout(() => policy.publish(ctx), 0);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreTodos(ctx);
		const entry = ctx.sessionManager.getBranch().filter((item: any) => item.type === "custom" && item.customType === "tsukuyomi-agent").at(-1) as any;
		const restored = entry?.data?.id ? getAgent(agentDir, entry.data.id) : undefined;
		activeAgent = undefined;
		publishAgent(ctx);
		if (restored) void activateCustomAgent(restored, ctx, false).catch(() => {});
	});
}
