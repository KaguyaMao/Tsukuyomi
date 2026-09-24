import { sanitizeTerminalText } from "../ui-utils.mjs";

const safe = (value, length = 200) => sanitizeTerminalText(String(value ?? "")).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\r\n\t]/g, " ").slice(0, length);
const unavailable = "usage — · revive — · parked — · advisor —";
/** Project only capabilities actually present in the TaskService / team snapshot. */
export function buildAgentHubRows({ team, jobs = [], agents = [], cwd, locale = "en" }) {
	const zh = locale === "zh";
	const rows = [];
	const add = (kind, id, title, detail, data) => rows.push({ kind, id, title: safe(title), detail: safe(detail, 500), data });
	if (team?.active) {
		add("summary", "team", zh ? "团队目标" : "Team objective", `${safe(team.objective, 260)} · ${safe(team.phase)} · ${safe(team.collaborationMode)} · ${unavailable}`, team);
		for (const member of team.members || []) add("member", member.id, `${member.status === "running" ? "●" : "○"} ${member.name || member.id}`, `${safe(member.role)} · ${safe(member.profile)} · ${safe(member.isolation)} · ${safe(member.status)} · ${unavailable}`, member);
		for (const request of team.permissionRequests || []) if (request.status === "pending") add("permission", request.id, `${zh ? "等待权限" : "Permission pending"} · ${safe(request.memberId)}`, `${safe(request.kind)} · ${safe(request.reason || request.description, 260)} · ${unavailable}`, request);
		for (const report of (team.reports || []).slice(-8)) add("report", report.id, `${zh ? "报告" : "Report"} · ${safe(report.memberId)}`, `${safe(report.status)} · ${report.patchPath ? (zh ? "补丁待检查" : "Patch available") : "—"} · ${safe(report.text, 120)} · ${unavailable}`, report);
	} else add("summary", "inactive", zh ? "未运行团队" : "No active team", `${zh ? "可选择 Agent 模板启动团队" : "Select agent templates to start a team"} · ${unavailable}`, undefined);
	for (const job of jobs.filter((item) => item?.cwd === cwd).slice(-30)) add("task", job.id, `${job.status === "running" ? "●" : "○"} ${job.kind || "task"} · ${safe(job.command, 65)}`, `${safe(job.status)} · ${safe(job.profile || (job.readonly ? "read-only" : "—"))} · ${job.patchPath ? (zh ? "补丁可检查" : "Patch available") : "—"} · ${unavailable}`, job);
	for (const agent of agents) add("agent", agent.id, agent.name || agent.id, `${safe(agent.provider)}/${safe(agent.model)} · ${safe(agent.description, 110)}`, agent);
	return rows;
}
