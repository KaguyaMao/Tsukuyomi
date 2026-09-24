import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const storeFile = (dir) => join(dir, "agents.json");
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MODES = new Set(["build", "plan"]);

function readStore(dir) {
	try {
		const value = JSON.parse(readFileSync(storeFile(dir), "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agents.json must contain an object");
		return { version: 1, agents: {}, ...value };
	} catch (error) {
		if (error?.code === "ENOENT") return { version: 1, agents: {} };
		throw error;
	}
}

function writeStore(dir, value) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = storeFile(dir);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

export function agentId(value) {
	const id = String(value || "").trim().toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 64);
	return id || "agent";
}

export function normalizeAgent(input, existing = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Agent must be an object");
	const id = agentId(input.id || existing.id || input.name);
	const name = String(input.name || existing.name || id).trim().slice(0, 120);
	if (!name) throw new TypeError("Agent name is required");
	const provider = String(input.provider ?? existing.provider ?? "").trim().slice(0, 120);
	const model = String(input.model ?? existing.model ?? "").trim().slice(0, 180);
	const thinking = String(input.thinking ?? existing.thinking ?? "medium").trim().toLowerCase();
	if (!THINKING_LEVELS.has(thinking)) throw new TypeError(`Unsupported thinking level: ${thinking}`);
	const mode = String(input.mode ?? existing.mode ?? "build").trim().toLowerCase();
	if (!MODES.has(mode)) throw new TypeError(`Unsupported agent mode: ${mode}`);
	const systemPrompt = String(input.systemPrompt ?? existing.systemPrompt ?? "").trim().slice(0, 100_000);
	const description = String(input.description ?? existing.description ?? "").trim().slice(0, 500);
	const accountRef = input.accountRef ?? existing.accountRef;
	if (accountRef !== undefined && typeof accountRef !== "string" && (!accountRef || typeof accountRef !== "object")) throw new TypeError("Invalid account reference");
	const tools = input.tools ?? existing.tools;
	if (tools !== undefined && (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string"))) throw new TypeError("Agent tools must be an array of names");
	const now = new Date().toISOString();
	return {
		id,
		name,
		description,
		provider,
		model,
		accountRef,
		thinking,
		mode,
		systemPrompt,
		tools: tools ? [...new Set(tools.map((tool) => tool.trim()).filter(Boolean))].slice(0, 100) : undefined,
		createdAt: existing.createdAt || input.createdAt || now,
		updatedAt: now,
	};
}

export function listAgents(dir) {
	const store = readStore(dir);
	return Object.values(store.agents || {}).map((agent) => normalizeAgent(agent, agent)).sort((a, b) => a.name.localeCompare(b.name));
}

export function getAgent(dir, id) {
	const raw = readStore(dir).agents?.[agentId(id)];
	return raw ? normalizeAgent(raw, raw) : undefined;
}

export function saveAgent(dir, input) {
	const store = readStore(dir);
	const key = agentId(input?.id || input?.name);
	const saved = normalizeAgent(input, store.agents?.[key]);
	store.agents = { ...(store.agents || {}), [saved.id]: saved };
	store.version = 1;
	writeStore(dir, store);
	return saved;
}

export function deleteAgent(dir, id) {
	const store = readStore(dir);
	const key = agentId(id);
	if (!store.agents?.[key]) return false;
	delete store.agents[key];
	writeStore(dir, store);
	return true;
}

export function exportAgents(dir) {
	return listAgents(dir).map(({ systemPrompt: _systemPrompt, ...agent }) => agent);
}

export { THINKING_LEVELS };
