import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { structuredTitle, STRUCTURED_WIDGET } from "../app/tui/structured-ui.mjs";

/** Pi RPC only supports select/confirm/input/editor. Attach bounded data to a
 * select using setWidget, retaining Pi's own dialog/cancellation protocol. */
export async function structuredSelect(
	ctx: ExtensionContext,
	kind: "questionnaire" | "plan-review",
	title: string,
	options: string[],
	payload: object,
): Promise<string | undefined> {
	if (ctx.mode !== "rpc") return ctx.ui.select(title, options);
	const nonce = randomUUID();
	ctx.ui.setWidget(STRUCTURED_WIDGET, [JSON.stringify({ version: 1, nonce, kind, payload })]);
	try { return await ctx.ui.select(structuredTitle(nonce, title), options); }
	finally { ctx.ui.setWidget(STRUCTURED_WIDGET, undefined); }
}
