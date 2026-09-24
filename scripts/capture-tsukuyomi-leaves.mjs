// Deterministic text/ANSI fixtures for render leaves. This is not a PTY or PNG
// capture: VHS is not required, and no live terminal or model session is started.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentHubRows } from "../app/tui/agent-hub.mjs";
import { wideComposerGeometry } from "../app/tui/composer-layout.mjs";
import { renderUserMessageBand } from "../app/tui/message-band.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs/tui-baseline/tsukuyomi-leaves");
mkdirSync(out, { recursive: true });
const strip = (value) => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const files = [];
const write = (name, text) => { writeFileSync(join(out, name), text); files.push(name); };

const band = renderUserMessageBand({
	width: 80,
	prompt: "short prompt",
	locale: "en",
	visibleWidth: (value) => strip(value).length,
	pad: (value, width) => `${value}${" ".repeat(Math.max(0, width - strip(value).length))}`,
	promptPrefix: () => "❯",
	textRows: (_owner, _field, value) => ({ rows: [value], sgr: false }),
	formatTime: () => "",
	bandBackground: (value) => `\x1b[48;2;28;28;28m${value}\x1b[49m`,
	color: { text: (value) => value },
}).map(strip).join("\n");
write("user-band-80.txt", `${band}\n`);
write("composer-geometry.txt", [40, 80, 120, 160].map((width) => JSON.stringify(wideComposerGeometry(width, 5))).join("\n") + "\n");
write("agent-hub.txt", buildAgentHubRows({
	team: { active: true, objective: "Review", phase: "executing", collaborationMode: "leader", members: [{ id: "m", name: "Ada", status: "running", role: "builder", profile: "build", isolation: "git-worktree" }], permissionRequests: [], reports: [] },
	jobs: [{ id: "job", cwd: "/repo", kind: "subagent", command: "npm test", status: "done", patchPath: "/tmp/a.patch" }],
	agents: [{ id: "template", name: "Reviewer", provider: "pi", model: "test" }],
	cwd: "/repo",
}).map((row) => `${row.kind}\t${row.title}\t${row.detail}`).join("\n") + "\n");

const sums = files.sort().map((name) => `${createHash("sha256").update(readFileSync(join(out, name))).digest("hex")}  ${name}`);
writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`wrote ${files.length} leaf fixtures`);
