import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, FileOperations } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

const AUTO_COMPACT_PERCENT = 82;
const MIN_AUTO_COMPACT_TOKENS = 24_000;
const SUMMARY_TRANSCRIPT_CHARS = 14_000;
const PREVIOUS_SUMMARY_CHARS = 5_000;

export interface CompactState {
	compactionStatus: "idle" | "running" | "complete" | "failed";
	compactionMessage?: string;
}

function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const marker = `\n\n[… ${text.length - limit} characters omitted by Tsukuyomi compact …]\n\n`;
	const remaining = Math.max(0, limit - marker.length);
	const head = Math.floor(remaining * 0.35);
	return `${text.slice(0, head)}${marker}${text.slice(text.length - (remaining - head))}`;
}

function list(values: string[]): string {
	return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- None recorded";
}

function fileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.written, ...fileOps.edited]);
	return {
		readFiles: [...fileOps.read].filter((path) => !modified.has(path)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

/**
 * Build a provider-independent continuity checkpoint. PI persists this exactly like
 * a native compaction entry, so it remains usable when the provider's summarizer
 * endpoint rejects or stalls the normal compaction request.
 */
function buildContinuitySummary(event: {
	preparation: {
		messagesToSummarize: AgentMessage[];
		turnPrefixMessages: AgentMessage[];
		previousSummary?: string;
		fileOps: FileOperations;
	};
	customInstructions?: string;
}): string {
	const preparation = event.preparation;
	const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
	const transcript = clip(serializeConversation(convertToLlm(messages)), SUMMARY_TRANSCRIPT_CHARS);
	const files = fileLists(preparation.fileOps);
	const previous = preparation.previousSummary
		? clip(preparation.previousSummary, PREVIOUS_SUMMARY_CHARS)
		: "No earlier compaction checkpoint.";
	const instructions = event.customInstructions?.trim()
		? clip(event.customInstructions.trim(), 1_000)
		: "Preserve the user's goal, constraints, decisions, completed work, blockers, and exact next actions.";

	return `# Tsukuyomi continuity checkpoint

This checkpoint was produced by the Tsukuyomi PI extension. Treat it as authoritative session history and continue from the retained messages after it.

## Compaction focus
${instructions}

## Previous checkpoint
${previous}

## Compacted conversation
${transcript || "No textual messages were available."}

## Files read
${list(files.readFiles)}

## Files modified
${list(files.modifiedFiles)}

## Resume rule
Continue the latest unfinished user request from the retained context. Do not repeat completed work, and verify current workspace state before making further edits.`;
}

export function registerCompactPlugin(
	pi: ExtensionAPI,
	state: CompactState,
	onChange: (ctx: ExtensionContext) => void,
): void {
	let inFlight = false;
	let lastAttemptTokens = 0;

	const setStatus = (
		ctx: ExtensionContext,
		status: CompactState["compactionStatus"],
		message?: string,
	) => {
		state.compactionStatus = status;
		state.compactionMessage = message;
		onChange(ctx);
	};

	const trigger = (ctx: ExtensionContext, customInstructions?: string, automatic = false) => {
		if (inFlight) return;
		inFlight = true;
		setStatus(ctx, "running", automatic ? "automatic threshold fallback" : "manual request");
		ctx.compact({
			customInstructions,
			onComplete: () => {
				inFlight = false;
				setStatus(ctx, "complete", "context checkpoint saved");
			},
			onError: (error) => {
				inFlight = false;
				setStatus(ctx, "failed", error.message);
			},
		});
	};

	pi.on("session_before_compact", (event, ctx) => {
		inFlight = true;
		setStatus(ctx, "running", `${event.reason} · ${Math.round(event.preparation.tokensBefore).toLocaleString()} tokens`);
		const files = fileLists(event.preparation.fileOps);
		return {
			compaction: {
				summary: buildContinuitySummary(event),
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {
					readFiles: files.readFiles,
					modifiedFiles: files.modifiedFiles,
					repairedBy: "tsukuyomi",
					schemaVersion: 1,
				},
			},
		};
	});

	pi.on("session_compact", (event, ctx) => {
		inFlight = false;
		lastAttemptTokens = event.compactionEntry.tokensBefore;
		setStatus(ctx, "complete", `${event.reason} · checkpoint saved`);
	});

	pi.on("session_compact_failed", (event, ctx) => {
		inFlight = false;
		const message = event.aborted ? "compaction cancelled" : (event.errorMessage ?? "unknown compact error");
		setStatus(ctx, "failed", message.replace(/^Compaction failed:\s*/i, ""));
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (inFlight || !ctx.isIdle()) return;
		const usage = ctx.getContextUsage();
		if (usage?.tokens == null || usage.percent == null) return;
		if (usage.tokens < MIN_AUTO_COMPACT_TOKENS || usage.percent < AUTO_COMPACT_PERCENT) return;
		if (usage.tokens <= lastAttemptTokens + 2_000) return;
		lastAttemptTokens = usage.tokens;
		trigger(
			ctx,
			"Create a continuity checkpoint before the context limit. Preserve exact goals, constraints, decisions, file state, and next actions.",
			true,
		);
	});

	pi.on("input", (_event, ctx) => {
		if (!inFlight && state.compactionStatus !== "idle") setStatus(ctx, "idle");
	});

	pi.on("session_start", (_event, ctx) => {
		inFlight = false;
		lastAttemptTokens = 0;
		setStatus(ctx, "idle");
	});

	pi.registerCommand("kcompact", {
		description: "Compact context through Tsukuyomi's provider-independent PI plugin",
		handler: async (args, ctx) => {
			trigger(ctx, args.trim() || undefined);
		},
	});
}
