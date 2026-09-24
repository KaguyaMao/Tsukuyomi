import test from "node:test";
import assert from "node:assert/strict";
import { TeamBroker } from "../app/team-broker.mjs";

function setup(mode = "leader") {
	const jobs = new Map();
	const events = [];
	const broker = new TeamBroker({ getJob: (id) => jobs.get(id), publish: (event) => events.push(event), controllerToken: "controller" });
	const first = { id: "job-a", params: { teamId: "team", memberId: "a", memberName: "A", role: mode === "leader" ? "leader" : "peer", collaborationMode: mode }, capabilityToken: "cap-a", sharedWrite: true };
	const second = { id: "job-b", params: { teamId: "team", memberId: "b", memberName: "B", role: "builder", collaborationMode: mode }, capabilityToken: "cap-b", sharedWrite: true };
	jobs.set(first.id, first); jobs.set(second.id, second);
	broker.registerJob(first); broker.registerJob(second);
	return { broker, first, second, events };
}

const auth = (job) => ({ jobId: job.id, teamId: "team", memberId: job.params.memberId, capabilityToken: job.capabilityToken });

test("team broker routes auditable messages and rejects forged workers", () => {
	const { broker, first } = setup();
	const message = broker.request("team.message", { ...auth(first), text: "Plan is ready", to: "b" });
	assert.equal(broker.request("team.inbox", { ...auth(first), after: 0 }).length, 0);
	assert.equal(message.to, "b");
	assert.throws(() => broker.request("team.message", { ...auth(first), capabilityToken: "wrong", text: "spoof" }), /capability/);
});

test("shared-write lease allows one writer and releases on completion", () => {
	const { broker, first, second } = setup();
	assert.equal(broker.request("team.lease.acquire", auth(first)).acquired, true);
	assert.equal(broker.request("team.lease.acquire", auth(second)).acquired, false);
	assert.equal(broker.request("team.lease.release", auth(first)), true);
	assert.equal(broker.request("team.lease.acquire", auth(second)).acquired, true);
});

test("only leader can assign and controller resolves permission requests", () => {
	const { broker, first, second, events } = setup();
	const report = broker.request("team.report", { ...auth(second), text: "Found the relevant file", status: "done" });
	assert.equal(report.memberId, "b");
	assert.throws(() => broker.request("team.assign", { ...auth(second), to: "a", objective: "Review" }), /leader/);
	const assignment = broker.request("team.assign", { ...auth(first), to: "b", objective: "Implement the fix", profile: "build", isolation: "shared-write" });
	assert.equal(assignment.to, "b");
	const request = broker.request("team.permission.request", { ...auth(second), kind: "shared-write", reason: "Need to update the implementation" });
	assert.equal(broker.request("team.permission.resolve", { teamId: "team", controllerToken: "controller", requestId: request.id, approved: true }).status, "approved");
	assert.ok(events.some((event) => event.type === "team_permission_resolved"));
});

test("peer members may delegate through the same auditable broker", () => {
	const { broker, first } = setup("peer");
	const assignment = broker.request("team.assign", { ...auth(first), to: "b", objective: "Pair on the investigation" });
	assert.equal(assignment.from, "a");
});
