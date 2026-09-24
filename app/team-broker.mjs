import { randomUUID } from "node:crypto";

const MAX_ITEMS = 200;
const LEASE_TTL_MS = 30_000;
const trim = (value, limit = 100_000) => String(value ?? "").trim().slice(0, limit);

/**
 * Broker for worker-to-worker communication. The controller remains the only
 * authority for plans, assignments, permissions and filesystem leases.
 */
export class TeamBroker {
	constructor({ getJob, publish, controllerToken }) {
		this.getJob = getJob;
		this.publish = publish;
		this.controllerToken = controllerToken;
		this.teams = new Map();
	}

	registerJob(job) {
		const { teamId, memberId } = job.params || {};
		if (!teamId || !memberId) return;
		let team = this.teams.get(teamId);
		if (!team) {
			team = { mode: job.params.collaborationMode === "leader" ? "leader" : "peer", messages: [], reports: [], assignments: [], permissions: [], lease: undefined };
			this.teams.set(teamId, team);
		}
		if (job.params.collaborationMode && team.mode !== job.params.collaborationMode) throw new Error("Team collaboration mode cannot change while workers are active");
		team.members ||= new Map();
		team.members.set(memberId, job.id);
	}

	#team(teamId) {
		const team = this.teams.get(teamId);
		if (!team) throw new Error("Unknown agent team");
		return team;
	}

	#worker(params) {
		const job = this.getJob(params.jobId);
		if (!job || job.params?.teamId !== params.teamId || job.params?.memberId !== params.memberId || job.capabilityToken !== params.capabilityToken) {
			throw new Error("Invalid team worker capability");
		}
		return job;
	}

	#controller(params) {
		if (params.controllerToken !== this.controllerToken) throw new Error("Invalid team controller capability");
	}

	#push(collection, value) {
		collection.push(value);
		if (collection.length > MAX_ITEMS) collection.splice(0, collection.length - MAX_ITEMS);
	}

	#emit(event) {
		this.publish({ ...event, at: Date.now() });
	}

	#expireLease(teamId, team) {
		if (!team.lease || Date.now() - team.lease.heartbeatAt <= LEASE_TTL_MS) return false;
		team.lease = undefined;
		this.#emit({ type: "team_lease", teamId, lease: undefined, reason: "expired" });
		return true;
	}

	request(method, params = {}) {
		if (method === "team.snapshot") {
			this.#controller(params);
			const team = this.#team(params.teamId);
			return {
				messages: team.messages.slice(-MAX_ITEMS),
				reports: team.reports.slice(-MAX_ITEMS),
				assignments: team.assignments.slice(-MAX_ITEMS),
				permissions: team.permissions.slice(-MAX_ITEMS),
				lease: team.lease,
			};
		}

		if (method === "team.permission.resolve") {
			this.#controller(params);
			const team = this.#team(params.teamId);
			const request = team.permissions.find((item) => item.id === params.requestId);
			if (!request) throw new Error("Unknown permission request");
			if (request.status !== "pending") throw new Error("Permission request is already resolved");
			request.status = params.approved === true ? "approved" : "denied";
			request.resolvedAt = Date.now();
			this.#emit({ type: "team_permission_resolved", teamId: params.teamId, request });
			return request;
		}

		if (method === "team.lease.status") {
			this.#controller(params);
			const team = this.#team(params.teamId);
			this.#expireLease(params.teamId, team);
			return team.lease;
		}

		const job = this.#worker(params);
		const team = this.#team(params.teamId);
		const sender = { memberId: job.params.memberId, jobId: job.id, name: job.params.memberName || job.params.memberId };

		if (method === "team.message") {
			const message = {
				id: randomUUID(), teamId: params.teamId, from: sender, to: params.to ? String(params.to) : undefined,
				text: trim(params.text, 20_000), createdAt: Date.now(),
			};
			if (!message.text) throw new Error("Team message cannot be empty");
			this.#push(team.messages, message);
			this.#emit({ type: "team_message", teamId: params.teamId, message });
			return message;
		}

		if (method === "team.inbox") {
			const after = Number(params.after) || 0;
			return team.messages.filter((message) => message.createdAt > after && (!message.to || message.to === sender.memberId));
		}

		if (method === "team.report") {
			const report = {
				id: randomUUID(), teamId: params.teamId, memberId: sender.memberId, jobId: job.id,
				taskId: params.taskId ? String(params.taskId) : undefined,
				status: params.status ? String(params.status) : "submitted",
				text: trim(params.text, 100_000), patchPath: params.patchPath ? String(params.patchPath) : undefined,
				createdAt: Date.now(),
			};
			if (!report.text) throw new Error("Team report cannot be empty");
			this.#push(team.reports, report);
			this.#emit({ type: "team_report", teamId: params.teamId, report });
			return report;
		}

		if (method === "team.assign") {
			if (team.mode === "leader" && job.params.role !== "leader") throw new Error("Only the team leader may assign work");
			const assignment = {
				id: randomUUID(), teamId: params.teamId, from: sender.memberId,
				to: String(params.to || ""), taskId: String(params.taskId || randomUUID()),
				objective: trim(params.objective, 20_000), profile: String(params.profile || "research"),
				isolation: String(params.isolation || "current-readonly"), createdAt: Date.now(), status: "assigned",
			};
			if (!assignment.to || !assignment.objective) throw new Error("Team assignment requires a recipient and objective");
			this.#push(team.assignments, assignment);
			this.#emit({ type: "team_assignment", teamId: params.teamId, assignment });
			return assignment;
		}

		if (method === "team.permission.request") {
			const request = {
				id: randomUUID(), teamId: params.teamId, memberId: sender.memberId, jobId: job.id,
				kind: String(params.kind || "build"), reason: trim(params.reason, 20_000), status: "pending", createdAt: Date.now(),
			};
			if (!request.reason) throw new Error("Permission request requires a reason");
			this.#push(team.permissions, request);
			this.#emit({ type: "team_permission_request", teamId: params.teamId, request });
			return request;
		}

		if (method === "team.lease.acquire") {
			if (!job.sharedWrite) throw new Error("This worker has no shared-write permission");
			this.#expireLease(params.teamId, team);
			if (team.lease && team.lease.jobId !== job.id) return { acquired: false, lease: team.lease };
			team.lease ||= { teamId: params.teamId, memberId: sender.memberId, jobId: job.id, acquiredAt: Date.now(), heartbeatAt: Date.now() };
			team.lease.heartbeatAt = Date.now();
			this.#emit({ type: "team_lease", teamId: params.teamId, lease: team.lease });
			return { acquired: true, lease: team.lease };
		}

		if (method === "team.lease.heartbeat") {
			if (team.lease?.jobId !== job.id) throw new Error("Worker does not hold the shared-write lease");
			team.lease.heartbeatAt = Date.now();
			this.#emit({ type: "team_lease", teamId: params.teamId, lease: team.lease });
			return team.lease;
		}

		if (method === "team.lease.release") {
			if (team.lease?.jobId === job.id) {
				team.lease = undefined;
				this.#emit({ type: "team_lease", teamId: params.teamId, lease: undefined });
			}
			return true;
		}

		throw new Error(`Unknown team operation: ${method}`);
	}

	releaseJob(job) {
		const teamId = job.params?.teamId;
		const team = teamId ? this.teams.get(teamId) : undefined;
		if (team?.lease?.jobId === job.id) {
			team.lease = undefined;
			this.#emit({ type: "team_lease", teamId, lease: undefined });
		}
	}
}
