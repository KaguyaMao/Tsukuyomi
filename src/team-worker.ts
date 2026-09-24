import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TaskClient } from "../app/task-client.mjs";

const env = process.env;
const client = new TaskClient(env);
const identity = () => ({
	jobId: env.TSUKUYOMI_TEAM_JOB_ID,
	teamId: env.TSUKUYOMI_TEAM_ID,
	memberId: env.TSUKUYOMI_TEAM_MEMBER_ID,
	capabilityToken: env.TSUKUYOMI_TEAM_CAPABILITY,
});
const call = (method: string, params: Record<string, unknown> = {}) => client.request(method, { ...identity(), ...params });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });

export default function registerTeamWorker(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "team_message",
		label: "Team message",
		description: "Send an auditable message to the team or one member. Use this for discussion, decisions, blockers, and handoffs.",
		parameters: Type.Object({ text: Type.String(), to: Type.Optional(Type.String()) }),
		async execute(_id, params) { return result(await call("team.message", params)); },
	});
	pi.registerTool({
		name: "team_inbox",
		label: "Team inbox",
		description: "Read new messages addressed to this worker or broadcast to the team.",
		parameters: Type.Object({ after: Type.Optional(Type.Number()) }),
		async execute(_id, params) { return result(await call("team.inbox", params)); },
	});
	pi.registerTool({
		name: "team_report",
		label: "Team report",
		description: "Submit a concise factual report to the team coordinator, including findings, paths, risks, and validation.",
		parameters: Type.Object({ text: Type.String(), taskId: Type.Optional(Type.String()), status: Type.Optional(Type.String()) }),
		async execute(_id, params) { return result(await call("team.report", params)); },
	});
	pi.registerTool({
		name: "team_assign",
		label: "Assign team work",
		description: "Leader-only: assign an objective to an existing team member. This does not grant additional permissions.",
		parameters: Type.Object({ to: Type.String(), objective: Type.String(), taskId: Type.Optional(Type.String()), profile: Type.Optional(Type.String()), isolation: Type.Optional(Type.String()) }),
		async execute(_id, params) { return result(await call("team.assign", params)); },
	});
	pi.registerTool({
		name: "team_request_permission",
		label: "Request team permission",
		description: "Request a user-approved permission change. A request never changes this worker's capabilities by itself.",
		parameters: Type.Object({ kind: Type.String(), reason: Type.String() }),
		async execute(_id, params) { return result(await call("team.permission.request", params)); },
	});
	pi.registerTool({
		name: "team_lease",
		label: "Shared write lease",
		description: "Acquire, heartbeat, or release the single-writer lease when this worker has shared-write permission.",
		parameters: Type.Object({ action: Type.String() }),
		async execute(_id, params) {
			const action = String(params.action || "").toLowerCase();
			if (!["acquire", "heartbeat", "release"].includes(action)) throw new Error("Use acquire, heartbeat, or release");
			return result(await call(`team.lease.${action}`));
		},
	});
	pi.on("session_shutdown", () => client.close());
}
