export const TEAM_PROFILES = Object.freeze(["plan", "research", "review", "build"]);
export const TEAM_ISOLATIONS = Object.freeze(["current-readonly", "git-worktree", "shared-write"]);

const READONLY_PROFILES = new Set(["plan", "research", "review"]);

/** Resolve permissions and filesystem isolation independently. */
export function resolveWorkerPolicy({ gitRoot, profile, isolation, readonly = false } = {}) {
	const selectedProfile = TEAM_PROFILES.includes(profile) ? profile : readonly ? "research" : "build";
	if (READONLY_PROFILES.has(selectedProfile)) {
		return {
			profile: selectedProfile,
			isolation: "current-readonly",
			readonly: true,
			isolated: false,
			sharedWrite: false,
			fallback: false,
		};
	}

	const selectedIsolation = TEAM_ISOLATIONS.includes(isolation) ? isolation : "git-worktree";
	if (selectedIsolation === "shared-write") {
		// Shared-write is intentionally usable outside Git: the broker's lease,
		// rather than a worktree, serializes team writers in the current workspace.
		return {
			profile: selectedProfile,
			isolation: selectedIsolation,
			readonly: false,
			isolated: false,
			sharedWrite: true,
			fallback: false,
		};
	}
	if (selectedIsolation === "git-worktree" && gitRoot) {
		return { profile: selectedProfile, isolation: selectedIsolation, readonly: false, isolated: true, sharedWrite: false, fallback: false };
	}
	return {
		profile: selectedProfile,
		isolation: "current-readonly",
		readonly: true,
		isolated: false,
		sharedWrite: false,
		fallback: selectedIsolation === "git-worktree",
	};
}

/** Legacy adapter retained for existing direct subagent callers. */
export function workerMode({ gitRoot, readonly = false } = {}) {
	const policy = resolveWorkerPolicy({ gitRoot, readonly });
	return { isolated: policy.isolated, readonly: policy.readonly };
}
