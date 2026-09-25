import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { readFileSync, readdirSync, realpathSync, statSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePiTui } from "./pi-runtime.mjs";
import { createProviderRuntime } from "./providers/runtime.mjs";
import { runAuthFlow } from "./providers/auth-flow.mjs";
import { AuthErrorCode } from "./providers/errors.mjs";
import { loadProviderCatalog } from "./providers/registry.mjs";
import { openUrl } from "./open-url.mjs";
import { redactText } from "./redact.mjs";
import { WorkspaceTree } from "./files.mjs";
import { PiRpc } from "./rpc.mjs";
import { LiveTool } from "./live-tools.mjs";
import { TaskClient } from "./task-client.mjs";
import { PointerCapture, parseSgrMouse } from "./pointer-state.mjs";
import {
	FULL_RAIL_MIN_COLUMNS,
	computeAgentLayout,
	computeTimelineRail,
	computeWorkspaceLayout,
	panelWindow,
} from "./tui-layout.mjs";
import {
	buildDockRows,
	collapseToolOutput,
	semanticDiffLines,
	todoStatuses,
	toolResultText,
} from "./tui-panels.mjs";
import {
	IncrementalText,
	adaptiveFrameDelay,
	assistantErrorMessage,
	compositeTuiOverlayLine,
	createLruCache,
	paintBackground,
	paintScreenRowClears,
	preserveScrollOffset,
	sanitizeTerminalText,
	scrollbarMetrics,
	scrollbarOffsetFromPointer,
	stripEditorCursorHighlight,
} from "./ui-utils.mjs";
import {
	createHistoryCache,
	historyLayoutKey,
	sliceFlow,
	syncHistoryCache,
} from "./transcript-cache.mjs";
import {
	createTranslator,
	detectLocale,
	formatCompactNumber,
	formatDateTime,
	formatNumber,
	formatPercent,
	formatRelativeReset,
	normalizeLocale,
} from "./i18n.mjs";
import { loadPreferences, savePreferences } from "./preferences.mjs";
import { applySourceUpdate, checkForUpdates, formatUpdateDetails } from "./updater.mjs";
import { filterSessionCatalog, scanSessionCatalog, trashSession } from "./session-store.mjs";
import { listProviderConfigs, removeProviderConfig, saveProviderConfig } from "./providers/config/opencode.mjs";
import { parseClaudeImport, parseCodexImport } from "./providers/config/native-import.mjs";
import { removeProviderFromModelsJson, syncAllToModelsJson, syncProviderToModelsJson, toProviderConfigInput } from "./providers/config/sync.mjs";
import { ProviderUsageClient } from "./providers/usage.mjs";
import { activeAccount, activateAccount, listAccounts, listAllAccounts, migrateAllCurrentCredentials, migrateCurrentCredential, saveAccount } from "./providers/accounts.mjs";
import { syncCodexCredential } from "./providers/codex-auth.mjs";
import { getStoredCredential } from "./providers/store.mjs";
import { renderMarkdown, renderOutputBlock, renderStreamingCodeBlock, inlineAnsi, highlight, langFromPath } from "./markdown.mjs";
import { createTsukuyomiDesignSystem } from "./design-system.mjs";
import { formatTime, formatAgo, formatDuration, TOOL_LABEL_KEYS, toolLabel } from "./tui/formatters.mjs";
import { wideComposerGeometry } from "./tui/composer-layout.mjs";
import { renderUserMessageBand } from "./tui/message-band.mjs";
import { providerListWindow } from "./tui/provider-list-window.mjs";
import { matchesTuiAction, resolveTuiKeybindings } from "./tui/keybindings.mjs";
import { HOME_AVATAR_HEIGHT, HOME_AVATAR_RGBA, HOME_AVATAR_WIDTH } from "./home-avatar.mjs";
import { createExtensionDialogQueue } from "./tui/dialog-requests.mjs";
import { decodeStructuredTitle, readStructuredWidget, structuredPreview, STRUCTURED_WIDGET } from "./tui/structured-ui.mjs";
import { createToolCallStream } from "./tui/toolcall-stream.mjs";
import { filterSelectOptions, selectListState } from "./tui/select-list.mjs";
import { layoutPlanReview } from "./tui/plan-review.mjs";
import { askPanelModel } from "./tui/ask-panel.mjs";
import { createPlanSession, joinPlan, planCommand, planResult } from "./tui/plan-session.mjs";
import { askCommand, askResult, createAskSession } from "./tui/ask-session.mjs";
import { buildAgentHubRows } from "./tui/agent-hub.mjs";
import { deleteAgent, getAgent, listAgents, saveAgent } from "./agents.mjs";
import { discoverSkills, loadSkillSettings, saveSkillSettings } from "./skills.mjs";

const design = createTsukuyomiDesignSystem();
const ESC = "\x1b[";
// Zero-width APC marker the bundled Editor emits at the hardware-cursor cell.
// Must match `CURSOR_MARKER` in the pi-tui runtime that owns the final frame.
const CURSOR_MARKER = "\x1b_pi:c\x07";
const FOCUS_OUT = "\x1b[O";
const FOCUS_IN = "\x1b[I";
const CURSOR_BLOCK = "\x1b[2 q";
const CURSOR_RESET = "\x1b[0 q";
const rgb = (r, g, b) => (value) => `${ESC}38;2;${r};${g};${b}m${value}${ESC}39m`;
// Grok Build's canvas is a warm charcoal rather than terminal black. Keep the
// explicit background on every composed row so terminal themes cannot tint it.
const BLACK_BACKGROUND = design.backgrounds.canvas;
const blackBackground = (value) => `${paintBackground(value, BLACK_BACKGROUND)}${ESC}49m`;
const bold = (value) => `${ESC}1m${value}${ESC}22m`;
const dim = (value) => `${ESC}2m${value}${ESC}22m`;
const modalGrayDim = rgb(88, 88, 88);
const modalPrimary = rgb(225, 225, 225);

const color = {
	text: design.fg.text,
	muted: design.fg.muted,
	dim: design.fg.dim,
	accent: design.fg.accent,
	secondary: design.fg.secondary,
	title: design.fg.brand,
	success: design.fg.success,
	warning: design.fg.warning,
	error: design.fg.error,
	border: design.fg.border,
	borderMuted: design.fg.borderMuted,
	thinkingMinimal: design.fg.thinkingMinimal,
	thinkingLow: design.fg.thinkingLow,
	thinkingMedium: design.fg.thinkingMedium,
	thinkingHigh: design.fg.thinkingHigh,
	thinkingXhigh: design.fg.thinkingXhigh,
	thinkingMax: design.fg.thinkingMax,
};
const AGENT_COLORS = [rgb(137, 180, 250), rgb(166, 227, 161), rgb(249, 226, 175), rgb(203, 166, 247), rgb(148, 226, 213), rgb(250, 179, 135)];
const agentColor = (id) => AGENT_COLORS[[...String(id || "")].reduce((sum, character) => sum + character.codePointAt(0), 0) % AGENT_COLORS.length];
const DIM_OPEN = `${ESC}38;2;${design.palette.dim}m`;

const BAND_BACKGROUND = design.backgrounds.band;
const bandBackground = (value) => paintBackground(value, BAND_BACKGROUND);
const LIST_SELECTION_BACKGROUND = design.backgrounds.selection;
const listSelection = (value) => paintBackground(value, LIST_SELECTION_BACKGROUND);
const PANEL_BACKGROUND = design.backgrounds.panel;
const PANEL_HOVER_BACKGROUND = design.backgrounds.panelHover;
const TOOL_BACKGROUND = design.backgrounds.tool;
const MENU_BACKGROUND = design.backgrounds.menu;
const MENU_SELECTION_BACKGROUND = design.backgrounds.menuSelection;
const menuBackground = (value) => `${paintBackground(value, MENU_BACKGROUND)}${BLACK_BACKGROUND}`;
const menuSelection = (value) => `${paintBackground(color.text(value), MENU_SELECTION_BACKGROUND)}${MENU_BACKGROUND}`;
const DIFF_ADD_BACKGROUND = `${ESC}48;2;0;58;20m`;
const DIFF_REMOVE_BACKGROUND = `${ESC}48;2;76;18;26m`;
// Panel rows are concatenated with the black session surface in wide layouts.
// End on an explicit black background so the outer row painter cannot carry a
// panel background through the separator and into the center column.
const panelBackground = (value) => `${paintBackground(value, PANEL_BACKGROUND)}${BLACK_BACKGROUND}`;
const panelHoverBackground = (value) => `${paintBackground(value, PANEL_HOVER_BACKGROUND)}${BLACK_BACKGROUND}`;
const toolBackground = (value) => `${paintBackground(value, TOOL_BACKGROUND)}${BLACK_BACKGROUND}`;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// The compact, case-sensitive Ti mark mirrors the proportions of OMP's pi mark.
const TSUKUYOMI_LOGO = [
	"████████      ██",
	"   ██           ",
	"   ██        ██",
	"   ██        ██",
	"   ██        ██",
];

function renderHomeAvatarRows(maxWidth, maxRows) {
	const scale = Math.min(1, Math.floor(maxWidth) / HOME_AVATAR_WIDTH, (Math.floor(maxRows) * 2) / HOME_AVATAR_HEIGHT);
	const pixelWidth = Math.floor(HOME_AVATAR_WIDTH * scale);
	const pixelHeight = Math.floor(HOME_AVATAR_HEIGHT * scale / 2) * 2;
	const cellRows = pixelHeight / 2;
	if (pixelWidth < 1 || cellRows < 1 || HOME_AVATAR_RGBA.length < HOME_AVATAR_WIDTH * HOME_AVATAR_HEIGHT * 4) return [];
	// Half-block cells keep the supplied pixel art's colors and sharp edges while
	// preserving square pixels in terminals with taller-than-wide character cells.
	const canvasRgb = design.palette.canvas.split(";").map(Number);
	const sample = (x, y) => {
		const sx = Math.min(HOME_AVATAR_WIDTH - 1, Math.floor(x * HOME_AVATAR_WIDTH / pixelWidth));
		const sy = Math.min(HOME_AVATAR_HEIGHT - 1, Math.floor(y * HOME_AVATAR_HEIGHT / pixelHeight));
		const offset = (sy * HOME_AVATAR_WIDTH + sx) * 4;
		const alpha = HOME_AVATAR_RGBA[offset + 3] / 255;
		return [0, 1, 2].map((channel) => Math.round(
			HOME_AVATAR_RGBA[offset + channel] * alpha + canvasRgb[channel] * (1 - alpha),
		)).join(";");
	};
	return Array.from({ length: cellRows }, (_unused, row) => {
		let line = "";
		for (let x = 0; x < pixelWidth; x++) {
			line += `${ESC}38;2;${sample(x, row * 2)}m${ESC}48;2;${sample(x, row * 2 + 1)}m▀`;
		}
		return `${line}${ESC}0m${BLACK_BACKGROUND}`;
	});
}

const logoGradient = ["255;244;153", "255;231;112", "241;203;71", "220;169;48", "179;126;32"];
const paintLogoRow = (row, index) => `${ESC}1;38;2;${logoGradient[index % logoGradient.length]}m${row}${ESC}0m`;
const greetingGradient = [[255, 246, 112], [255, 226, 46], [238, 190, 24], [185, 128, 18], [238, 190, 24], [255, 226, 46], [255, 246, 112]];
// FIGlet Big ("Kaguya Daiyou ~", horizontalLayout: full), trimmed of trailing
// spaces — GREETING_ASCII_ART_ALIGNED re-pads to a common width at load.
const GREETING_ASCII_ART = [
	"  _  __                                            _____            _                             /\\/|",
	" | |/ /                                           |  __ \\          (_)                           |/\\/",
	" | ' /    __ _    __ _   _   _   _   _    __ _    | |  | |   __ _   _   _   _    ___    _   _",
	" |  <    / _` |  / _` | | | | | | | | |  / _` |   | |  | |  / _` | | | | | | |  / _ \\  | | | |",
	" | . \\  | (_| | | (_| | | |_| | | |_| | | (_| |   | |__| | | (_| | | | | |_| | | (_) | | |_| |",
	" |_|\\_\\  \\__,_|  \\__, |  \\__,_|  \\__, |  \\__,_|   |_____/   \\__,_| |_|  \\__, |  \\___/   \\__,_|",
	"                  __/ |           __/ |                                  __/ |",
	"                 |___/           |___/                                  |___/",
];
const GREETING_ASCII_ART_WIDTH = Math.max(...GREETING_ASCII_ART.map((row) => row.length));
const GREETING_ASCII_ART_ALIGNED = GREETING_ASCII_ART.map((row) => row.padEnd(GREETING_ASCII_ART_WIDTH));
function paintHomeGreeting(value) {
	const chars = [...value];
	return chars.map((char, index) => {
		if (char === " ") return char;
		const position = chars.length <= 1 ? 0 : index / (chars.length - 1) * (greetingGradient.length - 1);
		const start = Math.floor(position);
		const end = Math.min(greetingGradient.length - 1, start + 1);
		const fraction = position - start;
		const color = greetingGradient[start].map((channel, channelIndex) => Math.round(channel + (greetingGradient[end][channelIndex] - channel) * fraction)).join(";");
		return `${ESC}1;38;2;${color}m${char}${ESC}0m`;
	}).join("");
}

const LOGO = [
	"██╗  ██╗ █████╗  ██████╗ ██╗   ██╗██╗   ██╗ █████╗ ██████╗ ██╗",
	"██║ ██╔╝██╔══██╗██╔════╝ ██║   ██║╚██╗ ██╔╝██╔══██╗██╔══██╗██║",
	"█████╔╝ ███████║██║  ███╗██║   ██║ ╚████╔╝ ███████║██████╔╝██║",
	"██╔═██╗ ██╔══██║██║   ██║██║   ██║  ╚██╔╝  ██╔══██║██╔═══╝ ██║",
	"██║  ██╗██║  ██║╚██████╔╝╚██████╔╝   ██║   ██║  ██║██║     ██║",
	"╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═╝     ╚═╝",
];

const MODES = ["build", "plan"];

/** Keep text safe for the cell renderer: SGR is allowed, cursor/erase control is not. */
function clean(value) {
	return sanitizeTerminalText(value);
}

function compactPath(path) {
	const home = process.env.HOME;
	const roots = home ? [home] : [];
	if (home) {
		try {
			const realHome = realpathSync(home);
			if (!roots.includes(realHome)) roots.push(realHome);
		} catch {
			// Keep the lexical HOME fallback for unusual or transient mounts.
		}
	}
	for (const root of roots) {
		if (path === root) return "~";
		if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`;
	}
	return path;
}

function formatTokens(value, locale = "en") {
	return formatCompactNumber(value, locale);
}

function readBranch(cwd) {
	try {
		let gitDir = join(cwd, ".git");
		try {
			const marker = readFileSync(gitDir, "utf8");
			if (marker.startsWith("gitdir:")) gitDir = resolve(cwd, marker.slice(7).trim());
		} catch {
			// A normal repository uses .git as a directory.
		}
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		return head.startsWith("ref:") ? head.split("/").at(-1) : head.slice(0, 8);
	} catch {
		return "";
	}
}

function textOfContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
}

function latestTodos(messages) {
	let todos = [];
	for (const message of messages) {
		if (message?.role !== "toolResult" || message.toolName !== "todo") continue;
		if (Array.isArray(message.details?.todos)) todos = message.details.todos.map((item) => ({ ...item }));
	}
	return todos;
}

function execText(command, args) {
	return new Promise((resolve, reject) => {
		execFile(command, args, { encoding: "utf8", timeout: 1_500, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

async function readPrimarySelection() {
	if (process.platform !== "linux" || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) {
		throw new Error("PRIMARY selection paste is only available in a Linux graphical session");
	}
	const readers = [];
	if (process.env.WAYLAND_DISPLAY) readers.push(["wl-paste", ["--primary", "--no-newline", "--type", "text"]]);
	if (process.env.DISPLAY) {
		readers.push(["xclip", ["-selection", "primary", "-out", "-target", "UTF8_STRING"]]);
		readers.push(["xsel", ["--primary", "--output"]]);
	}
	let lastError;
	for (const [command, args] of readers) {
		try {
			const value = await execText(command, args);
			return value
				.replace(/\r\n?/g, "\n")
				.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError || new Error("No PRIMARY selection reader is installed");
}

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function runTsukuyomi({ piBin, piRoot, args, env, cwd, workspaceExplicit = false, version, workspacePool }) {
	const tuiPath = resolvePiTui({ appRoot: APP_ROOT, piRoot });
	const {
		CombinedAutocompleteProvider,
		Container,
		Editor,
		ProcessTerminal,
		TuiAltScreen,
		compositeTuiLine,
		matchesKey,
		isKeyRelease,
		decodeKittyPrintable,
		truncateToWidth,
		visibleWidth,
		wrapTextWithAnsi,
	} = await import(pathToFileURL(tuiPath).href);

	const terminal = new ProcessTerminal();
	const writeTerminal = terminal.write.bind(terminal);
	const perf = { frames: 0, costTotal: 0, costMax: 0, assembles: 0, segments: 0, reused: 0, writeBytes: 0, draws: 0 };
	terminal.write = (value) => {
		perf.writeBytes += String(value).length;
		writeTerminal(paintScreenRowClears(value, BLACK_BACKGROUND));
	};
	// Keep the real terminal cursor at the editor marker. The bundled Editor
	// still emits its legacy reverse-video cursor, which renderEditor strips
	// below; use the solid block cursor shown by OMP.
	const tui = new TuiAltScreen(terminal, true, undefined, { mouse: true, wheelScrollLines: 3 });
	// Frame timing for adaptive backpressure. The installed pi-tui collapses its
	// cadence delay to zero once a frame overruns the interval, so a heavy frame
	// (long transcript, slow terminal write) turns the render loop into a busy
	// loop that starves keyboard input. Measuring each frame lets the scheduler
	// idle by the previous frame's cost instead.
	let lastFrameCostMs = 0;
	let lastFrameEndAt = 0;
	const baseDoRender = tui.doRender.bind(tui);
	tui.doRender = () => {
		const startedAt = performance.now();
		try {
			baseDoRender();
		} finally {
			const endedAt = performance.now();
			lastFrameCostMs = endedAt - startedAt;
			lastFrameEndAt = endedAt;
			perf.frames += 1;
			perf.costTotal += lastFrameCostMs;
			if (lastFrameCostMs > perf.costMax) perf.costMax = lastFrameCostMs;
		}
	};
	let perfTimer;
	let perfLogFile;
	const perfSnapshot = () => {
		const avg = perf.frames ? perf.costTotal / perf.frames : 0;
		const tailRows = state.stream.reduce((sum, phase) => sum + (phase.inc?.rowCount ?? 0), 0);
		return `[perf] frames=${perf.frames}/s avg=${avg.toFixed(1)}ms max=${perf.costMax.toFixed(1)}ms ` +
			`assembles=${perf.assembles} segments=${perf.segments} reused=${perf.reused} tailRows=${tailRows} ` +
			`messages=${state.messages.length} tools=${state.liveTools.size} writeBytes=${perf.writeBytes}`;
	};
	const startPerfLog = (file) => {
		if (perfTimer) return perfLogFile;
		perfLogFile = file || process.env.TSUKUYOMI_PERF_FILE || process.env.KAGUYAPI_PERF_FILE ||
			join(process.env.TSUKUYOMI_DIR || process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || "", ".tsukuyomi", "agent"), "perf.log");
		try { mkdirSync(dirname(perfLogFile), { recursive: true }); } catch {}
		perfTimer = setInterval(() => {
			try { appendFileSync(perfLogFile, `${perfSnapshot()}\n`); } catch {}
			perf.frames = 0; perf.costTotal = 0; perf.costMax = 0; perf.assembles = 0; perf.segments = 0; perf.reused = 0; perf.writeBytes = 0;
		}, 1000);
		perfTimer.unref?.();
		return perfLogFile;
	};
	// pi-tui keeps selection coordinates separately from the rendered frame. A
	// dialog or refreshed catalog replaces those rows, so never carry selection
	// state into a different surface.
	const clearTerminalSelection = () => {
		tui.stopSelectionAutoScroll?.();
		tui.stopScrollbarDrag?.();
		tui.selectionPressActive = false;
		tui.selectionAnchor = undefined;
		tui.selectionFocus = undefined;
		tui.selectionInitialRange = undefined;
		tui.pressedUrl = undefined;
		tui.selectionDragged = false;
	};
	const workspaceEntry = workspacePool?.acquire({ cwd, piBin, args, env });
	const rpc = workspaceEntry?.rpc || new PiRpc(piBin, args, env, cwd);
	const taskClient = new TaskClient(env);
	const tree = new WorkspaceTree(cwd);
	// Re-reading the workspace tree on every edit/write/bash tool blocks the main
	// thread even when the Files rail is hidden. Track staleness and refresh only
	// when the tree is actually visible (or explicitly reopened).
	let treeStale = false;
	const refreshTree = () => {
		if (!state.showFiles) { treeStale = true; return; }
		treeStale = false;
		tree.refresh();
	};
	const gitBranch = readBranch(cwd);
	// Single agent directory owns auth.json / providers.json / models.json.
	const agentDir = env?.TSUKUYOMI_DIR || env?.PI_CODING_AGENT_DIR;
	if (agentDir) {
		try { syncAllToModelsJson(agentDir); } catch { /* The provider picker reports malformed user config. */ }
	}
	const preferences = loadPreferences(agentDir);
	const initialKeybindingPreset = preferences.keybindingPreset === "legacy" ? "legacy" : "omp";
	let activeKeybindings = resolveTuiKeybindings(initialKeybindingPreset, preferences.keybindingOverrides);
	const discoveredSkills = discoverSkills(agentDir);
	const skillDiagnostics = discoveredSkills.diagnostics;
	let managedSkills = discoveredSkills.skills;
	let disabledSkills = new Set(loadSkillSettings(agentDir).disabled);
	const configuredLocale = normalizeLocale(env?.TSUKUYOMI_LANG || env?.KAGUYAPI_LANG) || normalizeLocale(preferences.language);
	let locale = configuredLocale || detectLocale({ ...process.env, ...env });
	let t = createTranslator(locale);
	const usageClient = new ProviderUsageClient({ agentDir, env, resolveAuth: (model) => providers().getAuth(model) });
	let providerRuntime;
	const providers = () => providerRuntime ||= createProviderRuntime({ piRoot, agentDir });

	const state = {
		active: false,
		ready: false,
		working: false,
		compacting: false,
		compactStatus: "",
		messages: [],
		messageRevision: 0,
		assistantCount: 0,
		streamingText: "",
		streamingThinking: "",
		stream: [],
		streamRevision: 0,
		streamAssistantBaseline: 0,
		streamStartedAt: undefined,
		runStartText: undefined,
		runStartAt: undefined,
		runStartIndex: undefined,
		runPromptPersisted: false,
		runWorkSince: undefined,
		runThoughtMs: 0,
		thinkingPhaseStart: undefined,
		lastThoughtMs: undefined,
		lastWorkMs: undefined,
		model: undefined,
		thinking: "off",
		locale,
		sessionTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
		usageStatus: undefined,
		sessionName: "",
		sessionFile: undefined,
		contextPercent: undefined,
		contextTokens: undefined,
		mode: args.includes("--plan") ? "plan" : "build",
		keybindingPreset: initialKeybindingPreset,
		workspaceDeclared: workspaceExplicit,
		showFiles: false,
		showWorkflow: preferences.rightSidebarDefault === true || (initialKeybindingPreset === "legacy" && preferences.rightSidebarDefault !== false),
		showTodos: preferences.rightSidebarDefault === true || (initialKeybindingPreset === "legacy" && preferences.rightSidebarDefault !== false),
		thinkingAutoCollapse: preferences.thinkingAutoCollapse !== false,
		markdown: preferences.markdown !== false,
		fileScroll: 0,
		workflowScroll: 0,
		todoScroll: 0,
		workflowFollowTail: true,
		workflowExpanded: new Set(),
		thinkingExpanded: new Set(),
		inlineDiffExpanded: new Set(),
		liveTools: new Map(),
		terminalJob: undefined,
		dockTasksExpanded: true,
		panelOverlay: undefined,
		panelScrollbars: new Map(),
		panelScrollbarDrag: undefined,
		hoveredZoneKey: undefined,
		workflow: [],
		workflowRevision: 0,
		todos: [],
		commands: [],
		statuses: new Map(),
		widgets: new Map(),
		tools: { available: [], active: [], disabled: [], labels: {} },
		team: undefined,
		teamJobs: new Map(),
		activeAgent: undefined,
		toast: t("toast.starting"),
		toastType: "info",
		toastUntil: Date.now() + 10_000,
		dialog: undefined,
		updating: false,
		touchMode: (process.env.TSUKUYOMI_TOUCH_MODE ?? process.env.KAGUYAPI_TOUCH_MODE) === "1" || (process.env.TSUKUYOMI_TOUCH_MODE ?? process.env.KAGUYAPI_TOUCH_MODE) === "true" || preferences.touchMode === true,
		pointer: new PointerCapture(),
		lastTerminalWidth: 0,
		lastTerminalHeight: 0,
		transcriptOffset: 0,
		transcriptMaxOffset: 0,
		transcriptFollowTail: true,
		transcriptAnchor: undefined,
		transcriptContentLength: 0,
		transcriptViewportLength: 0,
		transcriptScrollbar: undefined,
		transcriptScrollbarDrag: undefined,
		queued: 0,
		queueItems: { steering: [], followUp: [] },
		queueScroll: 0,
		queueMaxScroll: 0,
		userTurnCount: 0,
		dirtyToolIds: new Set(),
		mouseZones: [],
		primaryPastePending: false,
		stopped: false,
	};
	const keyMatches = (data, action) => matchesTuiAction(data, action, activeKeybindings, matchesKey);
	if ((process.env.TSUKUYOMI_PERF ?? process.env.KAGUYAPI_PERF) === "1") startPerfLog();

	const editorTheme = {
		borderColor: color.borderMuted,
		selectList: {
			selectedPrefix: color.accent,
			selectedText: (value) => bold(color.text(value)),
			description: color.muted,
			scrollInfo: color.dim,
			noMatch: color.warning,
		},
	};
	const editor = new Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
	const pendingStructured = new Map();
	const extensionDialogs = createExtensionDialogQueue({
		isBusy: () => Boolean(state.dialog),
		respond: (response) => rpc.respond(response),
		onExpired: (id) => {
			if (state.dialog?.source !== "pi" || state.dialog.id !== id) return;
			if (state.dialog.kind === "input" || state.dialog.kind === "editor") editor.setText(state.dialog.savedText || "");
			state.dialog = undefined;
			state.pointer.cancel();
			tui.requestRender();
		},
		present: (event) => {
			const kind = event.method;
			const metadata = decodeStructuredTitle(event.title, pendingStructured);
			const options = kind === "confirm" ? [t("action.yes"), t("action.no")] : (event.options || []);
			const visualKind = metadata.structured?.kind === "plan-review" ? "plan-review" : metadata.structured?.kind === "questionnaire" ? "ask" : kind;
			clearTerminalSelection();
			state.dialog = {
				source: "pi",
				id: event.id,
				kind: visualKind,
				rpcKind: kind,
				title: metadata.title || t("dialog.plugin"),
				structured: metadata.structured,
				planSession: visualKind === "plan-review" ? createPlanSession({ body: metadata.structured?.payload?.body || "", options }) : undefined,
				askSession: visualKind === "ask" && metadata.structured?.payload?.mode === "batch" ? createAskSession(metadata.structured.payload.questions) : undefined,
				message: event.message || (kind === "input" ? event.placeholder : undefined),
				...selectListState({ options, kind }),
				savedText: editor.getText(),
			};
			if (kind === "input") editor.setText("");
			if (kind === "editor") editor.setText(event.prefill || "");
			if (visualKind === "plan-review") {
				void availableThinkingLevels().then((levels) => {
					if (state.dialog?.planSession && levels.length) {
						state.dialog.planSession.slider = levels;
						const current = levels.indexOf(state.thinking);
						state.dialog.planSession.sliderIndex = current >= 0 ? current : 0;
						tui.requestRender();
					}
				}).catch(() => {});
			}
			tui.requestRender();
		},
	});
	const replaceDialog = (dialog) => {
		const previous = state.dialog;
		if (previous?.source === "pi") extensionDialogs.cancelActive();
		if (previous && (previous.kind === "input" || previous.kind === "editor")) editor.setText(previous.savedText || "");
		state.dialog = dialog;
		// Async local flows may open a new modal while another owns the focus.
		// Cancel the displaced owner exactly once rather than leaving its promise
		// unresolved or silently returning the new modal's input as its answer.
		if (previous && previous !== dialog && previous.source !== "pi" && previous.onResolve) {
			queueMicrotask(() => {
				try { const task = previous.onResolve({ cancelled: true }); task?.catch?.((error) => toast(error.message || String(error), "error")); }
				catch (error) { toast(error.message || String(error), "error"); }
			});
		}
	};
	const clearDialog = () => {
		if (state.dialog?.source === "pi") extensionDialogs.cancelActive();
		state.dialog = undefined;
		extensionDialogs.available();
	};
	if (workspaceEntry?.state) Object.assign(state, workspaceEntry.state, { pointer: new PointerCapture(), stopped: false });
	if (workspaceEntry?.draft) editor.setText(workspaceEntry.draft);
	const editorInputFocused = () => editor.focused &&
		(!state.dialog || state.dialog.kind === "input" || state.dialog.kind === "editor");
	// The editor is stateful: render() mutates its scrollOffset and emits the cursor
	// marker. Rendering it more than once per frame (or on every unrelated repaint)
	// both wastes layout work and makes the hardware cursor jump between two frames.
	// A revision bumped by input/onChange lets a frame reuse one exact editor image.
	let editorRevision = 0;
	let editorCacheKey;
	let editorCacheLines;
	const resetCursorBlink = () => { editorRevision += 1; requestDraw(true); };
	const renderEditor = (width) => {
		// Keep the current reasoning level visible even while idle. This makes the
		// composer a persistent affordance instead of only coloring during a run.
		const thinkingBorder = {
			off: color.borderMuted,
			minimal: color.thinkingMinimal,
			low: color.thinkingLow,
			medium: color.thinkingMedium,
			high: color.thinkingHigh,
			xhigh: color.thinkingXhigh,
			max: color.thinkingMax,
		};
		editorTheme.borderColor = state.mode === "plan" && state.thinking === "off"
			? color.warning
			: thinkingBorder[state.thinking] || color.borderMuted;
		editor.borderColor = editorTheme.borderColor;
		if (state.dialog?.secret) return ["•".repeat(Math.min(Math.max(0, width - 1), [...editor.getText()].length))];
		const wasFocused = editor.focused;
		// Keep focus true for every render while the editor owns input. This keeps
		// CURSOR_MARKER stable for IME candidate placement; blinking is delegated
		// to the terminal's hardware cursor instead of hiding the typed grapheme.
		editor.focused = editorInputFocused();
		const lines = stripEditorCursorHighlight(editor.render(width));
		editor.focused = wasFocused;
		return lines;
	};
	const editorLinesFor = (width) => {
		const key = `${width}|${editorRevision}|${editorInputFocused() ? 1 : 0}|${state.dialog?.secret ? 1 : 0}|${state.mode}|${state.working ? 1 : 0}|${state.thinking}|${editor.getText().length}`;
		if (editorCacheKey === key) return editorCacheLines;
		editorCacheLines = renderEditor(width);
		editorCacheKey = key;
		return editorCacheLines;
	};

	const pad = (value, width, align = "left") => {
		if (width <= 0) return "";
		const shortened = truncateToWidth(value, width, "…");
		const missing = Math.max(0, width - visibleWidth(shortened));
		if (align === "center") {
			const left = Math.floor(missing / 2);
			return `${" ".repeat(left)}${shortened}${" ".repeat(missing - left)}`;
		}
		if (align === "right") return `${" ".repeat(missing)}${shortened}`;
		return `${shortened}${" ".repeat(missing)}`;
	};

	const wrap = (value, width) => {
		if (width <= 0) return [];
		const lines = [];
		for (const raw of clean(value).split("\n")) {
			const wrapped = wrapTextWithAnsi(raw || " ", width);
			lines.push(...(wrapped.length ? wrapped : [""]));
		}
		return lines;
	};
	// Per-owner wrap memo. Tool output changes bump the workflow revision and force
	// the transcript to rebuild; without this, every unrelated assistant message and
	// its thinking trace would be re-cleaned and re-wrapped on every tool chunk.
	const wrapMemo = new WeakMap();
	const wrapCached = (owner, field, value, width) => {
		if (!owner || (typeof value !== "string" && typeof value !== "number")) return wrap(value, width);
		let slots = wrapMemo.get(owner);
		if (!slots) { slots = new Map(); wrapMemo.set(owner, slots); }
		const cached = slots.get(field);
		if (cached && cached.width === width && cached.value === value) return cached.lines;
		const lines = wrap(value, width);
		slots.set(field, { width, value, lines });
		return lines;
	};

	// Markdown rendering is idempotent for a given (owner, value, width), so it
	// can be memoized the same way as plain wrapping. The history cache rebuild
	// already forces re-rendering on workflow changes; this avoids re-parsing
	// large assistant messages on every unrelated render frame.
	const markdownMemo = new WeakMap();
	const markdownCached = (owner, field, value, width) => {
		if (!owner || typeof value !== "string") return renderMarkdown(value, { width });
		let slots = markdownMemo.get(owner);
		if (!slots) { slots = new Map(); markdownMemo.set(owner, slots); }
		const cached = slots.get(field);
		if (cached && cached.width === width && cached.value === value) return cached.lines;
		const lines = renderMarkdown(value, { width });
		slots.set(field, { width, value, lines });
		return lines;
	};

	// Respect the Markdown preference. When enabled, chat text is returned as
	// SGR-decorated rows (sgr: true) that must NOT be re-colored. When disabled,
	// fall back to the plain wrapper the rest of the UI re-colors with color.text.
	const textRows = (owner, field, value, width) => {
		if (state.markdown) {
			return { rows: owner ? markdownCached(owner, field, value, width) : renderMarkdown(value, { width }), sgr: true };
		}
		return { rows: owner ? wrapCached(owner, field, value, width) : wrap(value, width), sgr: false };
	};

	// Markdown for tool output rows. Block-level Markdown does not fit the
	// line-oriented tool renderer, so plain `text` rows get inline styling
	// (links, inline code, emphasis) and, for file-read tools, per-line syntax
	// highlighting chosen by the file extension. Other row kinds (diff add/remove,
	// headers, metadata) keep their existing coloring. Disabled when Markdown is off.
	const isReadLike = (name) => /^(read|view|cat|open|show|preview)$/i.test(name || "");
	const toolRowContent = (row, tool, name) => {
		const raw = String(row.text ?? "").replace(/[\r\n\t]/g, " ");
		if (!state.markdown || row.kind !== "text") return clean(raw);
		const path = tool?.args?.path || tool?.args?.file;
		const lang = path ? langFromPath(path) : undefined;
		const decorated = lang && isReadLike(name) ? highlight(raw, lang) : inlineAnsi(raw);
		return clean(decorated);
	};
	// Markdown-decorated rows already carry their own SGR, so they must not be
	// re-wrapped by the per-kind color (which would reset their base color).
	const toolRowPaint = (row) =>
		(state.markdown && row.kind === "text")
			? (value) => value
			: (row.kind === "add" ? color.success : row.kind === "remove" ? color.error : row.kind === "header" ? color.accent : row.kind === "footer" ? color.secondary : color.muted);
	const renderToolRows = (tool, name, width) => {
		const source = tool.rows(locale, tui.terminal.rows);
		const header = source.find((row) => row.kind === "header");
		const footer = source.findLast((row) => row.kind === "footer");
		const body = source.filter((row) => row !== header && row !== footer).map((row) => {
			const content = toolRowContent(row, tool, name);
			return toolRowPaint(row)(content || " ");
		});
		const sections = [{ lines: body }];
		if (footer) sections.push({ lines: [toolRowPaint(footer)(toolRowContent(footer, tool, name))] });
		return renderOutputBlock({
			header: header ? toolRowContent(header, tool, name) : name || "tool",
			state: tool.status,
			sections,
			width: Math.max(8, width - 2),
		}).map((line) => `  ${line}`);
	};

	let toastExpiryRendered = false;
	const toast = (message, type = "info", duration = 4_000) => {
		state.toast = clean(redactText(message));
		state.toastType = type;
		state.toastUntil = Date.now() + duration;
		toastExpiryRendered = false;
		tui.requestRender();
	};

	// Auto-surface a failed assistant turn. Provider/model errors used to exist
	// only as an (empty) transcript block, so a failed request looked like a
	// silent stop. Dedupe by message identity so replays and the agent_settled
	// safety net never bounce the same error twice.
	let lastTurnErrorKey;
	const notifyTurnError = (message) => {
		const reason = assistantErrorMessage(message);
		if (!reason) return false;
		const key = `${message.timestamp ?? 0}|${message.provider ?? ""}|${message.model ?? ""}|${reason}`;
		if (key === lastTurnErrorKey) return false;
		lastTurnErrorKey = key;
		const model = [message.provider, message.model].filter(Boolean).join("/") || state.model?.id || t("status.noModel");
		const summary = reason.length > 300 ? `${reason.slice(0, 299)}…` : reason;
		const time = formatTime(message.timestamp ?? Date.now(), locale);
		toast(t("toast.turnError", { model, reason: summary, time }), "error", 12_000);
		return true;
	};

	const request = async (command, options = {}) => {
		try {
			return await rpc.request(command, options.timeoutMs);
		} catch (error) {
			toast(redactText(error instanceof Error ? error.message : String(error)), "error", 7_000);
			throw error;
		}
	};

	let messagesGeneration = 0;
	let messagesRefreshPromise;
	let pendingMessagesSettle = false;
	let pendingMessagesForceSettle = false;
	// The live path mirrors `message_end` appends, so a full snapshot is only a
	// safety net: run it when reconciliation was requested or periodically to
	// self-heal, instead of paying O(history) at the end of every single turn.
	let messageLogNeedsReconcile = true;
	let settledTurns = 0;
	const RECONCILE_EVERY_TURNS = 10;
	const rebuildWorkflowHistory = (messages) => {
		const previous = new Map(state.workflow.map((item) => [item.id, item]));
		const next = new Map();
		for (const message of Array.isArray(messages) ? messages : []) {
			if (message?.role === "assistant") {
				for (const part of Array.isArray(message.content) ? message.content : []) {
					if (part?.type !== "toolCall" || part.name === "todo") continue;
					const id = part.id || part.toolCallId;
					if (!id) continue;
					const old = previous.get(id);
					const args = part.arguments || {};
					next.set(id, {
						...old,
						id,
						name: part.name || old?.name || "tool",
						args,
						label: toolLabel(part.name || old?.name || "tool", args, t),
						summary: clean(args.command || args.path || args.filePath || args.action || args.query || args.pattern || old?.summary || ""),
						status: old?.status === "running" ? "running" : (old?.status || "done"),
						startedAt: old?.startedAt || message.timestamp,
					});
				}
				continue;
			}
			if (message?.role !== "toolResult" || message.toolName === "todo") continue;
			const id = message.toolCallId;
			if (!id) continue;
			const old = next.get(id) || previous.get(id) || {
				id,
				name: message.toolName || "tool",
				label: toolLabel(message.toolName || "tool", {}, t),
				summary: "",
			};
			const output = clean(toolResultText(message));
			next.set(id, {
				...old,
				status: message.isError ? "error" : "done",
				output: output || old.output || "",
				error: message.isError ? (output || old.error || t("status.compactionFailed")) : undefined,
				endedAt: message.timestamp || old.endedAt,
			});
		}
		for (const item of previous.values()) {
			if (item.status === "running" && !next.has(item.id)) next.set(item.id, item);
		}
		state.workflow = [...next.values()].slice(-80);
		for (const item of state.workflow) {
			item.visualCache = undefined;
			item.collapsedCache = undefined;
			item.revision = (item.revision || 0) + 1;
		}
		state.workflowRevision += 1;
	};
	// Incremental counterpart to rebuildWorkflowHistory for the common case: PI
	// appends one finalized message per `message_end`, so folding only that
	// message keeps derivation O(new message) instead of O(entire history).
	const applyMessageToWorkflow = (message) => {
		if (!message) return;
		let changed = false;
		if (message.role === "assistant") {
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part?.type !== "toolCall" || part.name === "todo") continue;
				const id = part.id || part.toolCallId;
				if (!id) continue;
				const args = part.arguments || {};
				const name = part.name || "tool";
				const existing = state.workflow.find((item) => item.id === id);
				if (existing) {
					existing.name = name;
					existing.args = args;
					existing.label = toolLabel(name, args, t);
					existing.summary = clean(args.command || args.path || args.filePath || args.action || args.query || args.pattern || existing.summary || "");
					existing.startedAt ??= message.timestamp;
					changed = true;
				} else {
					state.workflow.push({
						id,
						name,
						args,
						label: toolLabel(name, args, t),
						summary: clean(args.command || args.path || args.filePath || args.action || args.query || args.pattern || ""),
						status: "done",
						startedAt: message.timestamp,
					});
					changed = true;
				}
			}
		} else if (message.role === "toolResult" && message.toolName !== "todo") {
			const id = message.toolCallId;
			if (id) {
				let item = state.workflow.find((entry) => entry.id === id);
				if (!item) {
					item = { id, name: message.toolName || "tool", label: toolLabel(message.toolName || "tool", {}, t), summary: "" };
					state.workflow.push(item);
				}
				const output = clean(toolResultText(message));
				item.status = message.isError ? "error" : "done";
				item.output = output || item.output || "";
				item.error = message.isError ? (output || item.error || t("status.compactionFailed")) : undefined;
				item.endedAt = message.timestamp || item.endedAt;
				changed = true;
			}
		}
		if (changed) {
			if (state.workflow.length > 80) {
				const removed = state.workflow.splice(0, state.workflow.length - 80);
				for (const entry of removed) state.workflowExpanded.delete(entry.id);
			}
			for (const item of state.workflow) {
				item.visualCache = undefined;
				item.collapsedCache = undefined;
				item.revision = (item.revision || 0) + 1;
			}
			state.workflowRevision += 1;
		}
	};
	const resolveRunStartIndex = () => {
		if (!state.messages.length) return undefined;
		if (state.runStartText != null) {
			const target = state.runStartText;
			for (let index = state.messages.length - 1; index >= 0; index--) {
				const message = state.messages[index];
				if (message?.role === "user" && clean(textOfContent(message.content)).trim() === target) return index;
			}
		}
		if (state.runStartAt != null) {
			let candidate;
			for (let index = 0; index < state.messages.length; index++) {
				const message = state.messages[index];
				if (!message) continue;
				if (message.role === "assistant" && message.timestamp != null && message.timestamp >= state.runStartAt) break;
				if (message.role === "user") candidate = index;
			}
			if (candidate != null) return candidate;
		}
		for (let index = state.messages.length - 1; index >= 0; index--) {
			if (state.messages[index]?.role !== "assistant") continue;
			for (let earlier = index - 1; earlier >= 0; earlier--) {
				if (state.messages[earlier]?.role === "user") return earlier;
			}
		}
		return undefined;
	};
	const replaceMessages = (messages) => {
		clearTerminalSelection();
		state.messages = Array.isArray(messages) ? messages : [];
		state.messageRevision = (state.messageRevision || 0) + 1;
		let userTurns = 0;
		let assistants = 0;
		for (const message of state.messages) {
			if (message?.role === "user") userTurns += 1;
			else if (message?.role === "assistant") assistants += 1;
		}
		state.userTurnCount = userTurns;
		state.assistantCount = assistants;
		state.todos = latestTodos(state.messages);
		rebuildWorkflowHistory(state.messages);
	};

	// Mirror the PI kernel's own message log incrementally. PI pushes exactly one
	// finalized message per `message_end`, so appending here keeps `state.messages`
	// identical to `get_messages` without an O(history) serialization round-trip on
	// every message. A full refresh still runs at turn settle as a safety net.
	const appendFinalMessage = (message) => {
		if (!message || typeof message.role !== "string") return;
		// Invalidate any in-flight snapshot: its result predates this append and
		// would otherwise replace the live message with a stale transcript.
		messagesGeneration += 1;
		state.messages.push(message);
		state.messageRevision = (state.messageRevision || 0) + 1;
		if (message.role === "user") {
			state.userTurnCount = (state.userTurnCount || 0) + 1;
			if (state.runStartText != null && clean(textOfContent(message.content)).trim() === state.runStartText) {
				state.runPromptPersisted = true;
				state.runStartIndex = state.messages.length - 1;
			}
		} else if (message.role === "assistant") {
			state.assistantCount = (state.assistantCount || 0) + 1;
		} else if (message.role === "toolResult" && message.toolName === "todo" && Array.isArray(message.details?.todos)) {
			state.todos = message.details.todos.map((todo) => ({ ...todo }));
		}
		applyMessageToWorkflow(message);
	};

	const toolCallStream = createToolCallStream();
	const clearStream = () => {
		toolCallStream.reset();
		if (!state.stream.length && !state.streamingText && !state.streamingThinking && state.streamStartedAt == null) return;
		state.stream = [];
		state.streamingText = "";
		state.streamingThinking = "";
		state.streamStartedAt = undefined;
		state.streamRevision += 1;
	};

	const streamIsCommitted = () => {
		if ((state.assistantCount || 0) > state.streamAssistantBaseline) return true;
		const streamedText = state.stream
			.filter((phase) => phase.kind === "text")
			.map((phase) => phase.text || "")
			.join("")
			.trim();
		if (!streamedText) return false;
		const latestAssistant = [...state.messages].reverse().find((message) => message?.role === "assistant");
		return textOfContent(latestAssistant?.content).includes(streamedText);
	};

	const refreshMessages = ({ settleStream = false, forceSettle = false } = {}) => {
		pendingMessagesSettle ||= settleStream;
		pendingMessagesForceSettle ||= forceSettle;
		if (messagesRefreshPromise) return messagesRefreshPromise;
		messagesRefreshPromise = (async () => {
			do {
				const shouldSettle = pendingMessagesSettle;
				const shouldForceSettle = pendingMessagesForceSettle;
				pendingMessagesSettle = false;
				pendingMessagesForceSettle = false;
				const generation = ++messagesGeneration;
				try {
					const data = await rpc.request({ type: "get_messages" }, 30_000);
					if (generation === messagesGeneration) {
						replaceMessages(data?.messages);
						messageLogNeedsReconcile = false;
						if (state.runStartText) {
							state.runPromptPersisted = state.messages.some((message) =>
								message?.role === "user" && clean(textOfContent(message.content)).trim() === state.runStartText,
							);
						}
						state.streamingText = "";
						state.runStartIndex = resolveRunStartIndex();
						if (shouldSettle && (shouldForceSettle || streamIsCommitted())) clearStream();
						requestDraw(false);
					}
				} catch {
					// The kernel exit path reports the actionable error.
				}
			} while (pendingMessagesSettle || pendingMessagesForceSettle);
		})().finally(() => {
			messagesRefreshPromise = undefined;
			if (pendingMessagesSettle || pendingMessagesForceSettle) void refreshMessages();
		});
		return messagesRefreshPromise;
	};

	const setTranscriptOffset = (offset) => {
		const next = Math.max(0, Math.min(state.transcriptMaxOffset, Math.floor(Number(offset) || 0)));
		state.transcriptOffset = next;
		state.transcriptFollowTail = next === 0;
		// This helper is called only for an explicit user position change. The
		// next render will establish a fresh anchor at that new location.
		state.transcriptAnchor = undefined;
	};

	const resetTranscript = () => {
		state.transcriptOffset = 0;
		state.transcriptMaxOffset = 0;
		state.transcriptFollowTail = true;
		state.transcriptAnchor = undefined;
		state.transcriptContentLength = 0;
		state.transcriptViewportLength = 0;
	};

	let statsRefreshPromise;
	const refreshStats = () => {
		if (statsRefreshPromise) return statsRefreshPromise;
		statsRefreshPromise = (async () => {
		try {
			const stats = await rpc.request({ type: "get_session_stats" }, 30_000);
			const contextPercent = stats?.contextUsage?.percent;
			const contextTokens = stats?.contextUsage?.tokens;
			// The status bar is outside the transcript scroll view. A selection made
			// before these values change would otherwise be painted at stale screen
			// coordinates, which appears as a colored block beside the usage text.
			if (state.contextPercent !== contextPercent || state.contextTokens !== contextTokens) clearTerminalSelection();
			state.contextPercent = contextPercent;
			state.contextTokens = contextTokens;
			state.sessionTokens = {
				input: Number(stats?.tokens?.input) || 0,
				output: Number(stats?.tokens?.output) || 0,
				cacheRead: Number(stats?.tokens?.cacheRead) || 0,
				cacheWrite: Number(stats?.tokens?.cacheWrite) || 0,
				total: Number(stats?.tokens?.total) || 0,
				cost: Number(stats?.cost) || 0,
			};
			requestDraw(false);
		} catch {
			// A model-less empty session has no context stats.
		}
		})().finally(() => { statsRefreshPromise = undefined; });
		return statsRefreshPromise;
	};

	const pushStream = (kind, text) => {
		if (!text) return;
		const previous = state.stream[state.stream.length - 1];
		if (previous?.kind === kind) {
			previous.text += text;
			previous.inc?.append(text);
		} else {
			const phase = { kind, text, startAt: Date.now(), inc: new IncrementalText(wrap) };
			phase.inc.append(text);
			state.stream.push(phase);
		}
		state.streamRevision += 1;
	};

	const pushToolPhase = (event) => {
		const name = event.toolName || t("toolVerb.tool");
		if (name === "todo") return;
		const label = toolLabel(name, event.args || {}, t);
		state.stream.push({ kind: "tool", id: event.toolCallId, label: truncateToWidth(label, 60, "…") });
		state.streamRevision += 1;
	};

	const markToolPhase = (id, failed) => {
		const phase = state.stream.find((item) => item.kind === "tool" && item.id === id);
		if (phase && phase.failed !== Boolean(failed)) {
			phase.failed = Boolean(failed);
			state.streamRevision += 1;
		}
	};

	const builtinNames = [
		"new", "compact", "mode", "workspace", "files", "workflow", "todo", "sidebar", "model", "provider", "providers", "setup", "web-search", "queue",
		"thinking", "tools", "skill", "sessions", "language", "status", "update", "accounts", "agents", "team", "touch", "help", "perf", "quit", "interrupt", "steer", "followup", "settings", "config",
	];
	const builtinDescriptions = {
		providers: "Open provider setup and sign-in",
		setup: "Set up providers",
		"web-search": "Choose the web_search provider",
		queue: "Inspect queued steering and follow-up messages",
	};
	const makeBuiltins = () => builtinNames.map((name) => ({
		name,
		description: builtinDescriptions[name] || t(`command.${name}`),
	}));
	let builtins = makeBuiltins();

	const updateAutocomplete = () => {
		const unique = new Map();
		for (const command of [...builtins, ...state.commands]) {
			if (!command?.name) continue;
			unique.set(command.name, { name: command.name, description: command.description || command.source || "" });
		}
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...unique.values()], cwd));
	};

	const setMode = async (mode) => {
		if (!MODES.includes(mode)) {
			toast(t("toast.modeUsage"), "warning");
			return;
		}
		state.pointer.cancel();
		tui.requestRender();
		try {
			await request({ type: "prompt", message: `/kmode ${mode}` }, { timeoutMs: 30_000 });
		} catch {
			// request() already displayed the error
		}
	};

	const nextMode = () => setMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]);

	const languageName = (value = locale) => t(`language.${value}`);
	const setLocale = (value) => {
		const next = normalizeLocale(value);
		if (!next) {
			toast(t("language.usage"), "warning");
			return false;
		}
		locale = next;
		state.locale = next;
		t = createTranslator(next);
		builtins = makeBuiltins();
		updateAutocomplete();
		rebuildWorkflowHistory(state.messages);
		savePreferences(agentDir, { language: next });
		toast(t("language.changed", { language: languageName(next) }), "info");
		tui.requestRender();
		return true;
	};

	const formatStatusWindowLabel = (window) => {
		const seconds = Number(window?.windowSeconds);
		let label;
		if (Number.isFinite(seconds) && seconds > 0) {
			const minutes = Math.max(1, Math.round(seconds / 60));
			if (minutes % (24 * 60) === 0) label = t("status.windowDays", { days: minutes / (24 * 60) });
			else if (minutes % 60 === 0) label = t("status.windowHours", { hours: minutes / 60 });
			else label = t("status.windowMinutes", { minutes });
		}
		if (!label) label = window?.kind === "secondary" ? t("status.windowSecondary") : t("status.windowPrimary");
		const bucketName = String(window?.bucketName || "");
		const bucket = bucketName && bucketName.toLowerCase() !== "codex" ? `${bucketName} ` : "";
		return `${bucket}${label}`;
	};

	const quotaProgress = (remaining) => {
		const value = Math.max(0, Math.min(100, Number(remaining) || 0));
		const segments = 16;
		const filled = Math.round(value / 100 * segments);
		return `[${"█".repeat(filled)}${"░".repeat(segments - filled)}]`;
	};

	const statusErrorText = (result) => {
		switch (result?.code) {
			case "model": return t("status.notSupportedModel");
			case "no-auth": return t("status.noAuth");
			case "expired-auth": return t("status.expiredAuth");
			case "api-key": return t("status.apiKey");
			case "http": return t("status.requestFailed", { reason: t("status.httpFailed", { status: result.status || "?" }) });
			case "malformed": return t("status.requestFailed", { reason: t("status.malformed") });
			case "timeout": return t("status.requestFailed", { reason: t("status.timeout", {}) });
			case "endpoint": return t("status.requestFailed", { reason: t("status.endpoint", {}) });
			case "no-endpoint": return t("status.noEndpoint");
			case "rate-limited": return t("status.rateLimited");
			case "network": return t("status.requestFailed", { reason: t("status.network") });
			case "fetch-unavailable": return t("status.requestFailed", { reason: t("status.fetchUnavailable", {}) });
			default: return t("status.requestFailed", { reason: result?.reason || t("status.notAvailable") });
		}
	};

	const statusMessage = (result, model = state.model) => {
		const modelId = model?.id || model?.name || t("status.noModel");
		const modelText = model?.provider ? `${model.provider}/${modelId}` : modelId;
		const session = state.sessionTokens || {};
		const input = formatTokens(session.input || 0, locale);
		const output = formatTokens(session.output || 0, locale);
		const cacheRead = formatTokens(session.cacheRead || 0, locale);
		const cacheWrite = formatTokens(session.cacheWrite || 0, locale);
		const cacheDetail = (session.cacheRead || session.cacheWrite)
			? ` + ${cacheRead} ${t("status.cacheRead")} + ${cacheWrite} ${t("status.cacheWrite")}` : "";
		const cost = Number(session.cost);
		const costDetail = Number.isFinite(cost) && cost > 0 ? ` · ${t("status.cost")} $${cost.toFixed(4)}` : "";
		const total = formatTokens(session.total || (session.input || 0) + (session.output || 0), locale);
		const lines = [
			`${t("status.currentModel")}: ${modelText}`,
			`${t("status.provider")}: ${model?.provider || t("status.notAvailable")}`,
			...(model?.provider && activeAccount(agentDir, model.provider) ? [`Account: ${listAccounts(agentDir, model.provider).find((item) => item.id === activeAccount(agentDir, model.provider))?.name || activeAccount(agentDir, model.provider)}`] : []),
			"",
			`${t("status.sessionUsage")}: ${total} ${t("status.total")} (${input} ${t("status.input")} + ${output} ${t("status.output")}${cacheDetail})${costDetail}`,
		];
		if (state.contextPercent != null) {
			lines.push(`${t("status.contextWindow")}: ${formatPercent(state.contextPercent, locale)}% ${t("status.used")}${state.contextTokens != null ? ` · ${formatTokens(state.contextTokens, locale)}` : ""}`);
		}
		lines.push("", `${t("status.quota")}:`);
		if (result?.kind !== "available") {
			lines.push(statusErrorText(result), t("status.sessionOnly"));
			return lines.join("\n");
		}
		if (result.planType) lines.push(`${t("status.plan")}: ${result.planType}`);
		if (result.plan) {
			const parts = [result.plan.tier].filter(Boolean);
			if (result.plan.status) parts.push(result.plan.status);
			if (parts.length > 0) lines.push(`${t("status.plan")}: ${parts.join(" · ")}`);
			if (result.plan.periodEnd) {
				lines.push(`${t("status.planPeriodEnd", { time: formatDateTime(result.plan.periodEnd, locale) })}`);
			}
			if (result.note === "xai-usage-pool-web-only") lines.push(t("status.xaiPoolWebOnly"));
		}
		if (!result.windows?.length && !result.credits && !result.monthly) {
			lines.push(t("status.notAvailable"));
		} else {
			for (const window of result.windows || []) {
				const remaining = window.remainingPercent ?? (100 - (window.usedPercent || 0));
				const reset = window.resetAt ? ` · ${t("status.reset", { time: formatRelativeReset(window.resetAt, locale) })}` : "";
				lines.push(`${formatStatusWindowLabel(window)}: ${quotaProgress(remaining)} ${t("status.percentLeft", { percent: formatPercent(remaining, locale) })}${reset}`);
			}
			if (result.credits) {
				const value = result.credits.unlimited
					? t("status.unlimited")
					: result.credits.balance != null && result.credits.balance !== ""
						? String(result.credits.balance)
						: result.credits.hasCredits ? t("status.available") : t("status.notAvailable");
				lines.push(`${t("status.credits")}: ${value}`);
			}
			if (result.monthly) {
				const remaining = result.monthly.remainingPercent == null ? "—" : `${formatPercent(result.monthly.remainingPercent, locale)}%`;
				const detail = result.monthly.used != null && result.monthly.limit != null
					? ` · ${t("status.creditsUsed", { used: result.monthly.used, limit: result.monthly.limit })}` : "";
				const reset = result.monthly.resetAt ? ` · ${t("status.reset", { time: formatRelativeReset(result.monthly.resetAt, locale) })}` : "";
				lines.push(`${t("status.monthly")}: ${remaining} ${t("status.remaining")}${detail}${reset}`);
			}
		}
		const updated = result.capturedAt ? formatDateTime(result.capturedAt, locale) : t("status.notAvailable");
		lines.push("", `${t("status.fetched", { time: updated })}${result.cached ? ` · ${t("status.cached")}` : ""}`, t("status.refreshHint"), result.pageUrl || "");
		return lines.join("\n");
	};

	const openStatus = async (force = false) => {
		clearTerminalSelection();
		state.pointer.cancel();
		replaceDialog({
			source: "status",
			kind: "status",
			title: t("status.title"),
			message: t("status.loading"),
		});
		tui.requestRender();
		const queryModel = state.model;
		try {
			await refreshStats();
			const result = await usageClient.get(queryModel, { force });
			state.usageStatus = result;
			if (state.dialog?.source === "status") {
				state.dialog.title = t("status.title");
				state.dialog.message = statusMessage(result, queryModel);
			}
		} catch (error) {
			const result = { kind: "error", code: "network", reason: error instanceof Error ? error.message : String(error) };
			state.usageStatus = result;
			if (state.dialog?.source === "status") state.dialog.message = statusMessage(result, queryModel);
		}
		tui.requestRender();
	};

	let exitResolve;
	let removeSignalHandlers = () => {};
	const finished = new Promise((resolve) => { exitResolve = resolve; });
	const shutdown = (code = 0, restart) => {
		if (state.stopped) return;
		state.stopped = true;
		state.authAbort?.abort();
		extensionDialogs.close();
		removeSignalHandlers();
		clearInterval(spinner);
		if (drawTimer) clearTimeout(drawTimer);
		taskClient.close();
		if (workspacePool && restart) workspacePool.park(workspaceEntry, state, editor.getText());
		else rpc.stop();
		// Restore the terminal cursor shape before handing the terminal back to the shell.
		try { terminal.write(CURSOR_RESET); } catch {}
		try { tui.stop({ preserveScreen: true }); } catch {}
		exitResolve(restart ? { code, ...restart } : code);
	};

	const finishDialog = (result) => {
		const dialog = state.dialog;
		if (!dialog) return;
		clearTerminalSelection();
		state.dialog = undefined;
		extensionDialogs.available();
		state.pointer.cancel();
		if (dialog.kind === "input" || dialog.kind === "editor") {
			editor.setText(dialog.savedText || "");
		}
		resetCursorBlink();
		if (dialog.source === "palette") {
			if (typeof result?.value === "string") editor.setText(`/${result.value} `);
			tui.requestRender();
			return;
		}
		if (dialog.source === "tools" || dialog.source === "status") {
			tui.requestRender();
			return;
		}
		if (dialog.source === "local" || dialog.source === "auth") {
			try {
				const task = dialog.onResolve?.(result);
				if (task && typeof task.catch === "function") task.catch((error) => toast(error.message || String(error), "error"));
			} catch (error) {
				toast(error.message || String(error), "error");
			}
			tui.requestRender();
			return;
		}
		if (dialog.source === "pi") {
			if (result?.cancelled) extensionDialogs.complete(dialog.id, { cancelled: true });
			else if (dialog.kind === "confirm") extensionDialogs.complete(dialog.id, { confirmed: Boolean(result?.confirmed) });
			else extensionDialogs.complete(dialog.id, { value: result?.value });
		}
		tui.requestRender();
	};

	const openPalette = () => {
		clearTerminalSelection();
		state.pointer.cancel();
		const items = [...builtins, ...state.commands]
			.filter((item, index, list) => list.findIndex((other) => other.name === item.name) === index)
			.slice(0, 30);
		replaceDialog({
			source: "palette",
			kind: "select",
			title: t("dialog.commands"),
			options: items.map((item) => item.name),
			descriptions: new Map(items.map((item) => [item.name, item.description || ""])),
			selected: 0,
		});
		resetCursorBlink();
		tui.requestRender();
	};

	const openLocalSelect = ({ title, message, options, descriptions, selected = 0, kind = "select", onResolve, searchable, wide = false, sections, checked, onToggle, applyOption, onApply, setupWizard = false, setupTabs }) => {
		clearTerminalSelection();
		state.pointer.cancel();
		replaceDialog({
			source: "local",
			kind,
			title,
			message,
			...selectListState({ options, descriptions, selected, kind, searchable }),
			sections,
			wide,
			setupWizard,
			setupTabs,
			setupTab: 0,
			onResolve,
			checked,
			onToggle,
			applyOption,
			onApply,
		});
		resetCursorBlink();
		tui.requestRender();
	};
	const openLocalInput = ({ title, message, prefill = "", secret = false, onResolve }) => {
		clearTerminalSelection();
		state.pointer.cancel();
		replaceDialog({ source: "local", kind: "input", title, message, options: [], selected: 0, savedText: state.dialog && (state.dialog.kind === "input" || state.dialog.kind === "editor") ? (state.dialog.savedText || "") : editor.getText(), secret, onResolve });
		editor.setText(prefill); tui.setFocus(editor); resetCursorBlink(); tui.requestRender();
	};

	let updateCheckPromise;
	let updatePrompted = false;
	const openUpdatePrompt = (details) => {
		if (state.stopped || state.updating || state.dialog) return;
		const yes = t("action.yes");
		const no = t("action.no");
		openLocalSelect({
			title: t("update.title"),
			message: formatUpdateDetails(details, { locale }),
			kind: "confirm",
			options: [yes, no],
			descriptions: new Map([[yes, t("update.confirmHint")], [no, t("update.skipHint")]]),
			onResolve: async (result) => {
				if (!result?.confirmed) {
					toast(t("update.skipped"), "info");
					return;
				}
				state.updating = true;
				replaceDialog({ source: "update", kind: "status", title: t("update.title"), message: t("update.applying"), statusOffset: 0 });
				tui.requestRender();
				try {
					const outcome = await applySourceUpdate({ root: APP_ROOT, update: details, env });
					if (!outcome.updated) {
						state.updating = false;
						clearDialog();
						toast(t("update.noLongerAvailable"), "info");
						return;
					}
					toast(t("update.updated"), "info", 10_000);
					setTimeout(() => shutdown(0, { restart: "update" }), 120);
				} catch (error) {
					state.updating = false;
					clearDialog();
					toast(t("update.failed", { reason: redactText(error?.message || String(error)) }), "error", 10_000);
				}
			},
		});
	};

	const promptForUpdate = ({ automatic = false } = {}) => {
		if (automatic && updatePrompted) return Promise.resolve(undefined);
		if (updateCheckPromise) return updateCheckPromise;
		const promise = (async () => {
			try {
				const details = await checkForUpdates({ root: APP_ROOT, env });
				if (!details?.available || state.stopped) {
					if (!automatic && details?.supported === false && !details?.disabled) toast(t("update.unsupported"), "info");
					return details;
				}
				const waitForIdle = () => {
					if (state.stopped || state.updating) return;
					if (state.dialog || state.working || state.compacting) {
						setTimeout(waitForIdle, 250);
						return;
					}
					updatePrompted = true;
					openUpdatePrompt(details);
				};
				waitForIdle();
				return details;
			} catch (error) {
				if (!automatic) toast(t("update.checkFailed", { reason: redactText(error?.message || String(error)) }), "warning", 8_000);
				return undefined;
			}
		})();
		const tracked = promise.finally(() => {
			if (updateCheckPromise === tracked) updateCheckPromise = undefined;
		});
		updateCheckPromise = tracked;
		return tracked;
	};

	const openLanguageSelector = () => {
		const options = [t("language.en"), t("language.zh")];
		openLocalSelect({
			title: t("language.title"),
			message: t("language.message"),
			options,
			descriptions: new Map(options.map((option, index) => [option, index === 0 ? "en" : "zh"])),
			selected: locale === "zh" ? 1 : 0,
			onResolve: (result) => {
				const index = options.indexOf(result?.value);
				if (index >= 0) setLocale(index === 1 ? "zh" : "en");
			},
		});
	};

	const sessionsRoot = () => {
		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			const value = arg === "--session-dir" ? args[index + 1] : arg.startsWith("--session-dir=") ? arg.slice("--session-dir=".length) : undefined;
			if (!value || value.startsWith("-")) continue;
			const home = process.env.HOME || "";
			const expanded = value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
			return resolve(cwd, expanded);
		}
		if (env.PI_CODING_AGENT_SESSION_DIR) return resolve(cwd, env.PI_CODING_AGENT_SESSION_DIR);
		const agentDir = env.TSUKUYOMI_DIR || env.PI_CODING_AGENT_DIR || join(process.env.HOME || "", ".tsukuyomi/agent");
		return join(agentDir, "sessions");
	};

	const openToolsDialog = () => {
		const fallback = Object.keys(TOOL_LABEL_KEYS);
		const options = state.tools.available.length ? [...state.tools.available] : fallback;
		clearTerminalSelection();
		state.pointer.cancel();
		replaceDialog({
			source: "tools",
			kind: "multi",
			title: t("dialog.tools"),
			message: t("dialog.toolsMessage"),
			options,
			descriptions: new Map(options.map((name) => [name, state.tools.labels[name] || t(TOOL_LABEL_KEYS[name] || name)])),
			selected: 0,
			toggled: new Map(),
		});
		resetCursorBlink();
		tui.requestRender();
	};

	const toolEnabled = (name) => {
		const dialog = state.dialog;
		if (!dialog || dialog.kind !== "multi" || dialog.source !== "tools") return false;
		const base = state.tools.available.length
			? !state.tools.disabled.includes(name)
			: !dialog.toggled.has(name);
		const flipped = Boolean(dialog.toggled.get(name));
		return flipped ? !base : base;
	};

	const toggleDialogTool = (name) => {
		const dialog = state.dialog;
		if (!dialog || dialog.kind !== "multi" || !dialog.options.includes(name)) return;
		dialog.toggled.set(name, !dialog.toggled.get(name));
		const enabled = toolEnabled(name);
		void request({ type: "prompt", message: `/ktools ${enabled ? "on" : "off"} ${name}` }, { timeoutMs: 30_000 })
			.catch(() => {});
		resetCursorBlink();
		tui.requestRender();
	};

	const toggleDialogOption = (option) => {
		const dialog = state.dialog;
		if (!dialog || dialog.kind !== "multi" || !dialog.options.includes(option)) return;
		if (dialog.applyOption === option) {
			try {
				const task = dialog.onApply?.();
				if (task && typeof task.catch === "function") task.catch((error) => toast(error.message || String(error), "error"));
			} catch (error) {
				toast(error.message || String(error), "error");
			}
			return;
		}
		if (dialog.onToggle) dialog.onToggle(option);
		else toggleDialogTool(option);
		resetCursorBlink();
		tui.requestRender();
	};

	const openSessionsDialog = async () => {
		toast(t("session.loading"), "info", 2_000);
		const items = await scanSessionCatalog(sessionsRoot(), { cwd, limit: 500 });
		if (!items.length) {
			toast(t("toast.noSessions"), "info");
			return;
		}
		const currentIndex = items.findIndex((item) => item.path === state.sessionFile);
		clearTerminalSelection();
		state.pointer.cancel();
		replaceDialog({
			source: "local",
			kind: "sessions",
			title: t("dialog.sessions"),
			query: "",
			currentOnly: false,
			selected: Math.max(0, currentIndex),
			items,
		});
		resetCursorBlink();
		tui.requestRender();
	};

	const askShowFiles = () => {
		state.workspaceDeclared = true;
		state.active = true;
		openLocalSelect({
			title: t("dialog.workspace"),
			message: t("dialog.workspaceQuestion", { path: compactPath(cwd) }),
			kind: "confirm",
			options: [t("action.yes"), t("action.no")],
			selected: 0,
			onResolve: (result) => {
				state.showFiles = Boolean(result?.confirmed);
				state.fileScroll = 0;
				if (state.showFiles) {
					tree.refresh();
					if ((state.lastTerminalWidth || 0) < FULL_RAIL_MIN_COLUMNS) state.panelOverlay = "files";
				}
			},
		});
	};

	const openModeSelector = () => {
		const labels = MODES.map((mode) => t(`mode.${mode}`));
		openLocalSelect({
			title: t("dialog.mode"),
			message: t("dialog.modeMessage"),
			options: labels,
			descriptions: new Map([
				[labels[0], t("mode.buildDescription")],
				[labels[1], t("mode.planDescription")],
			]),
			selected: MODES.indexOf(state.mode),
			onResolve: (result) => {
				const index = labels.indexOf(result?.value);
				if (index >= 0) return setMode(MODES[index]);
			},
		});
	};

	const availableModels = async () => {
		const data = await request({ type: "get_available_models" }, { timeoutMs: 30_000 });
		return Array.isArray(data?.models) ? data.models : [];
	};

	const applyModel = async (model) => {
		if (!model?.provider || !model?.id) return;
		const selected = await request({
			type: "set_model",
			provider: model.provider,
			modelId: model.id,
		}, { timeoutMs: 30_000 });
		const session = await rpc.request({ type: "get_state" }, 30_000).catch(() => undefined);
		state.model = session?.model || selected || model;
		state.thinking = session?.thinkingLevel || state.thinking;
		toast(t("toast.model", { model: `${state.model.provider}/${state.model.id}` }), "info");
		tui.requestRender();
	};

	const cycleModel = async (direction = 1) => {
		const models = await availableModels();
		if (!models.length) { toast(t("toast.noModels"), "warning"); return; }
		const current = models.findIndex((model) => model.provider === state.model?.provider && model.id === state.model?.id);
		const next = (current + direction + models.length) % models.length;
		await applyModel(models[next]);
	};

	const openModelSelector = async () => {
		toast(t("toast.loadingModels"), "info", 2_000);
		const models = await availableModels();
		if (!models.length) {
			toast(t("toast.noModels"), "warning");
			return;
		}
		migrateAllCurrentCredentials(agentDir);
		const configuredProviders = await providers().providers().catch(() => []);
		const providerById = new Map(configuredProviders.map((provider) => [provider.id, provider]));
		const grouped = new Map();
		for (const model of models) {
			if (!model?.provider || !model?.id) continue;
			let group = grouped.get(model.provider);
			if (!group) {
				const provider = providerById.get(model.provider);
				group = { id: model.provider, name: provider?.name || model.provider, models: [] };
				grouped.set(model.provider, group);
			}
			group.models.push(model);
		}
		const groups = [...grouped.values()];
		if (!groups.length) { toast(t("toast.noModels"), "warning"); return; }
		const providerLabels = groups.map((provider) => `${provider.name} · ${provider.id}`);
		const providerDescriptions = new Map(groups.map((provider, index) => [
			providerLabels[index], t("dialog.modelProviderDescription", {
				models: formatNumber(provider.models.length, locale),
				accounts: formatNumber(Math.max(1, listAccounts(agentDir, provider.id).length), locale),
			}),
		]));
		const showProviderModels = (provider, account) => {
			const labels = provider.models.map((model) => model.name && model.name !== model.id
				? `${model.name} · ${model.id}`
				: model.id);
			const descriptions = new Map(provider.models.map((model, index) => [
				labels[index], `${provider.id}/${model.id}${model.contextWindow ? ` · ${formatTokens(model.contextWindow, locale)} ${t("status.contextWindow").toLowerCase()}` : ""}`,
			]));
			const current = provider.models.findIndex((model) => model.provider === state.model?.provider && model.id === state.model?.id);
			openLocalSelect({
				title: provider.name,
				message: account ? `${account.name || account.id} · ${t("dialog.modelMessage", { count: formatNumber(provider.models.length, locale) })}` : t("dialog.modelMessage", { count: formatNumber(provider.models.length, locale) }),
				options: labels,
				descriptions,
				selected: current >= 0 ? current : 0,
				searchable: true,
				wide: true,
				onResolve: (result) => {
					const model = provider.models[labels.indexOf(result?.value)];
					if (!model) return;
					const currentAccount = account && (account.currentCredential || activeAccount(agentDir, provider.id) === account.id);
					if (account && !currentAccount) {
						if (!activateAccount(agentDir, provider.id, account.id)) {
							toast(`Unknown account: ${provider.id}:${account.id}`, "error");
							return;
						}
						shutdown(0, {
							restart: "provider",
							providerId: provider.id,
							modelId: model.id,
							...(state.sessionFile ? { session: state.sessionFile } : {}),
						});
						return;
					}
					return applyModel(model);
				},
			});
		};
		const openProviderAccounts = (provider) => {
			const savedAccounts = listAccounts(agentDir, provider.id);
			const accounts = savedAccounts.length
				? savedAccounts
				: [{ id: "current", name: t("dialog.currentCredential"), currentCredential: true }];
			const current = activeAccount(agentDir, provider.id);
			const labels = accounts.map((account) => `${account.currentCredential || account.id === current ? "●" : "○"} ${account.name || account.id} · ${account.id}`);
			openLocalSelect({
				title: provider.name,
				message: t("dialog.modelAccountMessage"),
				options: labels,
				descriptions: new Map(accounts.map((account, index) => [labels[index], account.currentCredential || account.id === current ? t("provider.current") : account.id])),
				selected: Math.max(0, accounts.findIndex((account) => account.currentCredential || account.id === current)),
				searchable: true,
				wide: true,
				onResolve: (result) => {
					const account = accounts[labels.indexOf(result?.value)];
					if (account) showProviderModels(provider, account);
				},
			});
		};
		openLocalSelect({
			title: t("dialog.provider"),
			message: t("dialog.providerMessage"),
			options: providerLabels,
			descriptions: providerDescriptions,
			selected: Math.max(0, groups.findIndex((provider) => provider.id === state.model?.provider)),
			searchable: true,
			wide: true,
			onResolve: (result) => {
				const provider = groups[providerLabels.indexOf(result?.value)];
				if (provider) openProviderAccounts(provider);
			},
		});
	};
	const authPrompt = (prompt) => new Promise((resolve, reject) => {
		if (prompt?.signal?.aborted) { reject(prompt.signal.reason || new Error("Cancelled")); return; }
		let ownedDialog;
		const signal = prompt.signal || state.authAbort?.signal;
		const abort = () => {
			if (state.dialog === ownedDialog) {
				if (ownedDialog?.kind === "input") editor.setText(ownedDialog.savedText || "");
				clearDialog(); tui.requestRender();
			}
			reject(new Error("Cancelled"));
		};
		const done = (result) => {
			signal?.removeEventListener("abort", abort);
			if (result?.cancelled) { state.authAbort?.abort(); reject(new Error("Cancelled")); }
			else resolve(result?.value || "");
		};
		if (prompt.type === "select") {
			const labels = prompt.options.map((option) => option.label);
			openLocalSelect({ title: t("dialog.loginMethod"), message: prompt.message, options: labels,
				descriptions: new Map(prompt.options.map((option) => [option.label, option.description || ""])),
				onResolve: (result) => done({ ...result, value: prompt.options[labels.indexOf(result?.value)]?.id || "" }) });
		} else openLocalInput({ title: `${locale === "zh" ? "登录" : "Signing in to"} ${prompt.providerName || "provider"}`, message: prompt.message, secret: prompt.type === "secret" || prompt.type === "manual_code", onResolve: done });
		ownedDialog = state.dialog;
		ownedDialog.authPrompt = true;
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
	const loginProvider = async (provider, method) => {
		if (state.working || state.compacting || state.authAbort) return;
		const controller = new AbortController(); state.authAbort = controller;
		const closeAuthDialog = () => {
			if (state.dialog?.authPrompt) editor.setText(state.dialog.savedText || "");
			if (state.dialog?.source === "auth" || state.dialog?.authPrompt) clearDialog();
		};
		const showAuthProgress = ({ url, code, instructions }) => {
			if (url) openUrl(url);
			const lines = [
				url ? `${t("auth.openUrl")} ${url}` : "",
				code ? t("auth.deviceCode", { code, url: url || "" }) : "",
				instructions || t("auth.waiting"),
			].filter(Boolean);
			replaceDialog({
				kind: "select",
				source: "auth",
				title: `${locale === "zh" ? "登录" : "Signing in to"} ${provider.name}`,
				message: lines.join("\n"),
				options: [t("action.cancel")],
				wide: true,
				selected: 0,
				onResolve: (result) => {
					if (result?.cancelled || result?.value) controller.abort();
				},
			});
			tui.requestRender();
		};
		try {
			const result = await runAuthFlow({
				providerId: method.providerId || provider.id,
				providerName: provider.name,
				method: method.type,
				signal: controller.signal,
				login: (id, type, interaction) => providers().login(id, type, interaction),
				ui: {
					prompt: (prompt) => authPrompt({ ...prompt, providerName: provider.name }),
					notify: (event) => {
						if (event.type === "auth_url") showAuthProgress({ url: event.url, instructions: event.instructions });
						else if (event.type === "device_code") showAuthProgress({ url: event.verificationUri, code: event.userCode });
						else if (event.type === "info") showAuthProgress({ instructions: event.message });
						else toast(event.message || t("auth.waiting"), "info", 15_000);
					},
				},
			});
			closeAuthDialog();
			if (!result.ok) {
				if (!result.error?.silent) {
					// A network failure usually happens before any dialog appears, so
					// explain the cause instead of showing a bare reason string.
					const hasApiKey = (provider.authMethods || []).some((item) => item.type === "api_key");
					if (result.error?.code === AuthErrorCode.NETWORK) {
						toast(t("toast.providerAuthNetwork", { provider: provider.name, hint: hasApiKey ? t("auth.tryApiKey") : "" }), "error", 10_000);
					} else {
						toast(t("toast.providerAuthFailed", { reason: result.error?.message || String(result.error) }), "error", 8_000);
					}
				}
				return;
			}
			// A sync warning means the credential was saved but the kernel
			// snapshot lagged; the restart below repairs it, so keep going.
			if (result.warning) toast(t("auth.syncWarning"), "warning", 8_000);
			else toast(t("toast.providerSignedIn", { provider: provider.name }), "info");
			const providerId = method.providerId || provider.id;
			const credential = getStoredCredential(agentDir, providerId);
			if (credential) { const count = listAccounts(agentDir, providerId).length; saveAccount(agentDir, providerId, `account-${count + 1}`, credential, `Account #${count + 1}`); }
			setTimeout(() => shutdown(0, { restart: "provider", ...(state.sessionFile ? { session: state.sessionFile } : {}) }), 180);
		} catch (error) {
			closeAuthDialog();
			if (!controller.signal.aborted && error?.message !== "Cancelled") toast(t("toast.providerAuthFailed", { reason: error?.message || String(error) }), "error", 8_000);
		} finally { if (state.authAbort === controller) state.authAbort = undefined; tui.requestRender(); }
	};
	const openProviderAuth = (provider) => {
		const methods = provider.authMethods || [];
		if (!methods.length) { toast(t("auth.ambientOnly"), "warning"); return; }
		if (methods.length === 1) { void loginProvider(provider, methods[0]); return; }
		const labels = methods.map((method, index) => {
			const base = method.type === "oauth" ? (method.name || t("auth.accountLogin")) : t("auth.apiKeyLogin");
			return methods.filter((item) => (item.type === "oauth" ? (item.name || t("auth.accountLogin")) : t("auth.apiKeyLogin")) === base).length > 1
				? `${base} · ${method.providerId}`
				: base;
		});
		openLocalSelect({ title: t("dialog.loginMethod"), message: provider.name, options: labels,
			descriptions: new Map(methods.map((method, index) => [labels[index], method.type === "oauth" ? t("auth.accountLogin") : t("auth.apiKeyLogin")])),
			onResolve: (result) => { const method = methods[labels.indexOf(result?.value)]; if (method) return loginProvider(provider, method); } });
	};
	const localInputValue = (title, message, { secret = false, prefill = "" } = {}) => new Promise((resolve, reject) => openLocalInput({ title, message, secret, prefill, onResolve: (result) => result?.cancelled ? reject(new Error("Cancelled")) : resolve(String(result?.value || "").trim()) }));
	const localSelectValue = (title, options, selected = 0) => new Promise((resolve, reject) => openLocalSelect({ title, options, descriptions: new Map(), selected, onResolve: (result) => result?.cancelled ? reject(new Error("Cancelled")) : resolve(result?.value) }));
	const webSearchProviders = ["Auto", "Parallel", "Perplexity", "Gemini", "Anthropic", "OpenAI", "xAI", "OpenRouter"];
	const openWebSearchSelector = () => {
		const current = String(loadPreferences(agentDir).webSearchProvider || "auto").toLowerCase();
		openLocalSelect({
			title: locale === "zh" ? "网页搜索供应商" : "Web search provider",
			message: locale === "zh" ? "选择 web_search 工具优先使用的供应商" : "Choose the provider preferred by the web_search tool",
			options: webSearchProviders,
			selected: Math.max(0, webSearchProviders.findIndex((item) => item.toLowerCase() === current)),
			descriptions: new Map([
			["Auto", "Uses the first available configured search provider"],
			["Parallel", "Public search or PARALLEL_API_KEY"],
			["Perplexity", "PERPLEXITY_API_KEY"],
			["Gemini", "GEMINI_API_KEY or GOOGLE_API_KEY"],
			["Anthropic", "ANTHROPIC_API_KEY"],
			["OpenAI", "OPENAI_API_KEY"],
			["xAI", "XAI_API_KEY"],
			["OpenRouter", "OPENROUTER_API_KEY"],
			]),
			onResolve: (result) => {
				if (!result?.value) return;
				if (!savePreferences(agentDir, { webSearchProvider: result.value.toLowerCase() })) { toast("Could not save web search provider", "error"); return; }
				toast(`web_search: ${result.value}`, "info");
			},
		});
	};
	const addCustomProvider = async () => {
		try {
			const protocol = await localSelectValue("Custom provider protocol", ["OpenAI-compatible · Codex", "Claude-compatible · Claude Code"]);
			const openai = protocol.startsWith("OpenAI");
			const configuration = await localInputValue(openai ? "Paste config.toml" : "Paste settings.json",
				openai ? "Paste the complete Codex config.toml; Alt+Enter inserts a newline." : "Paste the complete Claude Code settings.json; Alt+Enter inserts a newline.");
			const credentials = await localInputValue(openai ? "Paste auth.json" : "Paste credential JSON",
				"The credential is saved in Tsukuyomi auth.json, never in providers.json.", { secret: true });
			const imported = openai
				? parseCodexImport(configuration, credentials, { env })
				: parseClaudeImport(configuration, credentials);
			const { config, credential } = imported;
			saveProviderConfig(agentDir, config.id, config);
			syncProviderToModelsJson(agentDir, config.id, config);
			await providers().registerProvider(config.id, toProviderConfigInput(config));
			await providers().saveApiKey(config.id, credential.key);
			toast(t("custom.saved", { provider: config.name || config.id }), "info");
			setTimeout(() => shutdown(0, { restart: "provider", ...(state.sessionFile ? { session: state.sessionFile } : {}) }), 180);
		} catch (error) { if (error?.message !== "Cancelled") toast(error?.message || String(error), "error"); }
	};
	const customProviderConfig = (providerId) => {
		const result = listProviderConfigs(agentDir);
		const config = result.providers.find((item) => item.id === providerId);
		if (config) return config;
		throw new Error(result.error || t("custom.providerMissing", { provider: providerId }));
	};
	const pendingCustomProviderReload = new Set();
	const restartAfterCustomProviderSettings = () => {
		if (!pendingCustomProviderReload.size) return;
		pendingCustomProviderReload.clear();
		toast(t("custom.modelsReloading"), "info");
		setTimeout(() => shutdown(0, { restart: "provider", ...(state.sessionFile ? { session: state.sessionFile } : {}) }), 180);
	};
	const saveCustomProviderModels = async (providerId, models) => {
		const config = customProviderConfig(providerId);
		saveProviderConfig(agentDir, providerId, { ...config, models });
		pendingCustomProviderReload.add(providerId);
		const saved = customProviderConfig(providerId);
		syncProviderToModelsJson(agentDir, providerId, saved);
		await providers().registerProvider(providerId, toProviderConfigInput(saved));
		usageClient.clear();
		return saved;
	};
	const promptCustomModel = async (model = {}) => {
		const id = await localInputValue(t("custom.modelId"), t("custom.modelIdHint"), { prefill: model.id || "" });
		if (!id) throw new Error(t("custom.modelIdRequired"));
		const name = await localInputValue(t("custom.modelName"), t("custom.modelNameHint"), { prefill: model.name || model.id || "" });
		const reasoningOptions = [t("settings.on"), t("settings.off")];
		const reasoning = await localSelectValue(t("custom.modelReasoning"), reasoningOptions, model.reasoning === true ? 0 : 1);
		return { ...model, id, name: name || id, reasoning: reasoning === reasoningOptions[0] };
	};
	const openCustomProviderModels = (provider) => {
		let config;
		try { config = customProviderConfig(provider.id); }
		catch (error) { toast(error?.message || String(error), "error"); return; }
		const addLabel = t("custom.addModel");
		const modelLabels = config.models.map((model) => `${model.name || model.id} · ${model.id}`);
		const labels = [addLabel, ...modelLabels];
		const descriptions = new Map(config.models.map((model, index) => [
			modelLabels[index], model.reasoning ? t("custom.reasoningOn") : t("custom.reasoningOff"),
		]));
		const message = t("custom.modelsMessage", { count: formatNumber(config.models.length, locale) });
		openLocalSelect({
			title: t("custom.modelsTitle", { provider: config.name || config.id }),
			message: pendingCustomProviderReload.has(provider.id) ? `${message} · ${t("custom.modelsRestartHint")}` : message,
			options: labels,
			descriptions: new Map([[addLabel, t("custom.addModelHint")], ...descriptions]),
			searchable: true,
			onResolve: async (result) => {
				if (result?.cancelled) { restartAfterCustomProviderSettings(); return; }
				if (result?.value === addLabel) {
					try {
						const model = await promptCustomModel();
						const current = customProviderConfig(provider.id).models;
						if (current.some((item) => item.id === model.id)) throw new Error(t("custom.duplicateModelId", { model: model.id }));
						const updated = await saveCustomProviderModels(provider.id, [...current, model]);
						toast(t("custom.modelsSaved", { count: updated.models.length, provider: updated.name || provider.id }), "info");
					} catch (error) {
						if (error?.message !== "Cancelled") toast(error?.message || String(error), "error");
					}
					openCustomProviderModels(provider);
					return;
				}
				const model = config.models[modelLabels.indexOf(result?.value)];
				if (!model) return;
				const editLabel = t("custom.editModel");
				const deleteLabel = t("custom.deleteModel");
				openLocalSelect({
					title: t("custom.modelActionsTitle", { model: model.id }),
					options: [editLabel, deleteLabel],
					descriptions: new Map([[editLabel, t("custom.editModelHint")], [deleteLabel, t("custom.deleteModelHint")]]),
					onResolve: async (action) => {
						if (action?.cancelled) { openCustomProviderModels(provider); return; }
						if (action?.value === editLabel) {
							try {
								const updatedModel = await promptCustomModel(model);
								const current = customProviderConfig(provider.id).models;
								if (current.some((item) => item.id === updatedModel.id && item.id !== model.id)) throw new Error(t("custom.duplicateModelId", { model: updatedModel.id }));
								const updated = await saveCustomProviderModels(provider.id, current.map((item) => item.id === model.id ? updatedModel : item));
								toast(t("custom.modelsSaved", { count: updated.models.length, provider: updated.name || provider.id }), "info");
							} catch (error) {
								if (error?.message !== "Cancelled") toast(error?.message || String(error), "error");
							}
							openCustomProviderModels(provider);
							return;
						}
						if (action?.value === deleteLabel) {
							openLocalSelect({
								title: t("custom.deleteModelTitle"),
								message: t("custom.deleteModelMessage", { model: model.id }),
								kind: "confirm",
								options: [t("action.yes"), t("action.no")],
								onResolve: async (answer) => {
									if (!answer?.confirmed) { openCustomProviderModels(provider); return; }
									try {
										const current = customProviderConfig(provider.id).models;
										const updated = await saveCustomProviderModels(provider.id, current.filter((item) => item.id !== model.id));
										toast(t("custom.modelsSaved", { count: updated.models.length, provider: updated.name || provider.id }), "info");
									} catch (error) { toast(error?.message || String(error), "error"); }
									openCustomProviderModels(provider);
								},
							});
						}
					},
				});
			},
		});
	};
	const openCustomProviderModelSelector = () => {
		const result = listProviderConfigs(agentDir);
		if (!result.providers.length) { toast(result.error || t("custom.noProviders"), result.error ? "error" : "info"); return; }
		if (result.error) toast(result.error, "warning");
		const labels = result.providers.map((provider) => `${provider.name || provider.id} · ${provider.id}`);
		openLocalSelect({
			title: t("custom.modelsSettingsTitle"),
			options: labels,
			descriptions: new Map(result.providers.map((provider, index) => [
				labels[index], t("custom.modelsMessage", { count: formatNumber(provider.models.length, locale) }),
			])),
			searchable: true,
			onResolve: (choice) => {
				const provider = result.providers[labels.indexOf(choice?.value)];
				if (provider) openCustomProviderModels(provider);
			},
		});
	};

	const openProviderSelector = async () => {
		if (state.working || state.compacting) { toast(t("toast.abortWorkspace"), "warning"); return; }
		toast(t("toast.loadingModels"), "info", 2_000);
		// The registry derives auth methods, auth status, grouping, and order
		// from PI; the UI only renders the result.
		const list = await loadProviderCatalog(providers(), { currentProviderId: state.model?.provider });
		const providerAuth = (provider) => {
			const status = provider.status ?? providers().authStatus(provider.id) ?? {};
			const configured = status.configured === true || provider.configured === true;
			return { configured, kind: status.source || (configured ? "configured" : "none"), label: status.label };
		};
		// Keep the import action at the top of the sign-in list so it stays
		// discoverable even though the built-in provider catalog is long.
		const providerLabels = list.map((provider) => `${provider.name} · ${provider.id}`);
		const addLabel = t("custom.add");
		const labels = [addLabel, ...providerLabels];
		const descriptions = new Map(list.map((provider) => {
			const auth = providerAuth(provider);
			const mark = auth.configured ? "✓" : "✗";
			const availability = provider.models.length
				? `${provider.models.length} ${t("provider.models")}`
				: auth.configured ? t("provider.loadModels") : t("dialog.providerSignIn");
			return [providerLabels[list.indexOf(provider)], `${mark} ${auth.kind || (auth.configured ? "environment" : "none")} · ${availability}`];
		}));
		descriptions.set(addLabel, t("custom.addHint"));
		const sections = new Map(list.map((provider, index) => [providerLabels[index], t(`provider.group.${provider.group || "other"}`)]));
		sections.set(addLabel, t("provider.group.custom"));
		const searchDescriptions = new Map([
			["Auto", "Uses the first available configured search provider"],
			["Parallel", "Public search or PARALLEL_API_KEY"],
			["Perplexity", "PERPLEXITY_API_KEY"],
			["Gemini", "GEMINI_API_KEY or GOOGLE_API_KEY"],
			["Anthropic", "ANTHROPIC_API_KEY"],
			["OpenAI", "OPENAI_API_KEY"],
			["xAI", "XAI_API_KEY"],
			["OpenRouter", "OPENROUTER_API_KEY"],
		]);
		const currentSearch = String(loadPreferences(agentDir).webSearchProvider || "auto").toLowerCase();
		const currentProviderIndex = list.findIndex((provider) => provider.id === state.model?.provider);
		const selectedProviderIndex = currentProviderIndex < 0 ? 0 : currentProviderIndex + 1;
		openLocalSelect({ title: t("dialog.provider"), message: t("dialog.providerMessage"), options: labels, descriptions, searchable: true, wide: true,
			selected: selectedProviderIndex, setupWizard: true,
			setupTabs: [
				{ label: locale === "zh" ? "登录" : "Sign in", options: labels, descriptions, sections, selected: selectedProviderIndex },
				{ label: locale === "zh" ? "网页搜索" : "Web search", options: webSearchProviders, descriptions: searchDescriptions, selected: Math.max(0, webSearchProviders.findIndex((item) => item.toLowerCase() === currentSearch)) },
			],
			onResolve: async (result) => {
				if (result?.setupTab === 1) {
					if (!savePreferences(agentDir, { webSearchProvider: String(result.value).toLowerCase() })) toast("Could not save web search provider", "error");
					else toast(`web_search: ${result.value}`, "info");
					return;
				}
				if (result?.value === addLabel) { await addCustomProvider(); return; }
				const provider = list[providerLabels.indexOf(result?.value)];
				if (!provider) return;
				migrateCurrentCredential(agentDir, provider.id);
				const accounts = listAccounts(agentDir, provider.id);
				if (accounts.length > 1) {
					const current = activeAccount(agentDir, provider.id);
					const accountLabels = accounts.map((account) => `${account.id === current ? "● " : "○ "}${account.name}`);
					accountLabels.push("+ Add account");
					const manageModels = provider.custom ? t("custom.manageModels") : undefined;
					if (manageModels) accountLabels.push(manageModels);
					openLocalSelect({ title: `${provider.name} accounts`, options: accountLabels, onResolve: async (choice) => {
						if (choice?.value === manageModels) return openCustomProviderModels(provider);
						if (choice?.value === "+ Add account") return openProviderAuth(provider);
						const account = accounts[accountLabels.indexOf(choice?.value)];
						if (account && activateAccount(agentDir, provider.id, account.id)) shutdown(0, { restart: "provider", ...(state.sessionFile ? { session: state.sessionFile } : {}) });
					} });
					return;
				}
				const auth = providerAuth(provider);
				if (!auth.configured && !provider.custom) { openProviderAuth(provider); return; }
				const models = auth.configured
					? await providers().getModels(provider.id).catch((error) => { if (provider.custom) return []; throw error; })
					: [];
				if (!models.length && !provider.custom) { openProviderAuth(provider); return; }
				const modelLabels = models.map((model) => `${model.provider}/${model.id}`);
				const signIn = t("dialog.providerSignIn");
				const signOut = t("auth.signOut");
				const manageModels = provider.custom ? t("custom.manageModels") : undefined;
				const remove = provider.custom ? t("custom.remove") : undefined;
				const options = [...modelLabels, ...(manageModels ? [manageModels] : []), signIn, ...(provider.custom && !auth.configured ? [] : [signOut]), ...(remove ? [remove] : [])];
				const descriptions = new Map([
					...models.map((model, index) => [modelLabels[index], model.name || model.id]),
					...(manageModels ? [[manageModels, t("custom.manageModelsHint")]] : []),
					[signIn, t("auth.accountLogin")],
					...(!(provider.custom && !auth.configured) ? [[signOut, t("auth.signOutHint")]] : []),
					...(remove ? [[remove, t("custom.removeHint")]] : []),
				]);
				openLocalSelect({ title: t("dialog.model"), message: t("dialog.modelMessage", { count: formatNumber(models.length, locale) }), options, descriptions,
					selected: Math.max(0, modelLabels.indexOf(`${state.model?.provider}/${state.model?.id}`)),
					onResolve: async (choice) => {
						if (choice?.value === manageModels) { openCustomProviderModels(provider); return; }
						if (choice?.value === remove) {
							openLocalSelect({
								title: t("custom.removeTitle"),
								message: t("custom.removeMessage", { provider: provider.name }),
								kind: "confirm",
								options: [t("action.yes"), t("action.no")],
								onResolve: async (answer) => {
									if (!answer?.confirmed) return;
									removeProviderConfig(agentDir, provider.id);
									removeProviderFromModelsJson(agentDir, provider.id);
									await providers().unregisterProvider(provider.id).catch(() => {});
									usageClient.clear();
									toast(t("custom.removed", { provider: provider.name }), "info");
									setTimeout(() => shutdown(0, { restart: "provider", ...(state.sessionFile ? { session: state.sessionFile } : {}) }), 180);
								},
							});
							return;
						}
						if (choice?.value === signOut) {
							await providers().logout(provider.id);
							usageClient.clear();
							shutdown(0, { restart: "provider", ...(state.sessionFile ? { session: state.sessionFile } : {}) });
							return;
						}
						if (choice?.value === signIn) { openProviderAuth(provider); return; }
						const model = models[modelLabels.indexOf(choice?.value)];
						if (model) applyModel(model);
					}, searchable: true });
			}, searchable: true, sections });
	};

	const openAccounts = async () => {
		migrateAllCurrentCredentials(agentDir);
		try {
			const codex = syncCodexCredential(agentDir);
			if (codex?.activated || codex?.updated) {
				providers().invalidate();
				usageClient.clear();
			}
		} catch { /* Codex import is best-effort */ }
		let providerList = [];
		try { providerList = await providers().providers(); } catch { /* listing must still work when the kernel is unavailable */ }
		const providerById = new Map(providerList.map((provider) => [provider.id, provider]));
		const entries = listAllAccounts(agentDir).map((entry) => ({
			provider: providerById.get(entry.providerId) || { id: entry.providerId, name: entry.providerId },
			account: entry,
			current: entry.current,
		}));
		if (!entries.length) { toast("No saved accounts", "info"); return; }
		const labels = entries.map(({ provider, account, current }) =>
			`${current ? "●" : "○"} ${provider.name} · ${account.name}`);
		openLocalSelect({
			title: "Accounts",
			message: "Select an account to activate",
			options: labels,
			descriptions: new Map(entries.map(({ provider, account }) => [
				labels[entries.findIndex((item) => item.provider.id === provider.id && item.account.id === account.id)],
				`${provider.id} · ${account.id}`,
			])),
			onResolve: (result) => {
				const entry = entries[labels.indexOf(result?.value)];
				if (!entry) return;
				if (!entry.current && !activateAccount(agentDir, entry.provider.id, entry.account.id)) return;
				// Switching providers also needs a model; otherwise the restarted
				// session keeps using the previous provider and hides the switch.
				providers().invalidate();
				void providers().models(entry.provider.id).then((models) => {
					const model = models[0];
					shutdown(0, {
						restart: "provider",
						providerId: entry.provider.id,
						...(model?.id ? { modelId: model.id } : {}),
						...(state.sessionFile ? { session: state.sessionFile } : {}),
					});
				}).catch(() => {
					shutdown(0, { restart: "provider", ...(state.sessionFile ? { session: state.sessionFile } : {}) });
				});
			},
			searchable: true,
		});
	};

	const editAgent = async (existing) => {
		let models;
		try { models = await availableModels(); } catch { return; }
		if (!models.length) { toast(locale === "zh" ? "没有可用模型" : "No models available", "warning"); return; }
		const modelLabels = models.map((model) => `${model.provider}/${model.id}`);
		const currentModel = existing?.provider && existing?.model ? `${existing.provider}/${existing.model}` : undefined;
		openLocalInput({
			title: locale === "zh" ? "Agent 名称" : "Agent name",
			prefill: existing?.name || "",
			onResolve: (nameResult) => {
				const name = nameResult?.value?.trim(); if (!name) return;
				openLocalSelect({
					title: locale === "zh" ? "Agent 模型" : "Agent model",
					message: locale === "zh" ? "每个 Agent 可独立选择供应商和模型" : "Each agent can use an independent provider and model",
					options: modelLabels,
					selected: Math.max(0, modelLabels.indexOf(currentModel)),
					searchable: true,
					onResolve: (modelResult) => {
						const model = models[modelLabels.indexOf(modelResult?.value)]; if (!model) return;
						const accounts = listAllAccounts(agentDir).filter((entry) => entry.providerId === model.provider);
						const accountLabels = [locale === "zh" ? "使用当前账户" : "Use current account", ...accounts.map((entry) => entry.name || entry.id)];
						openLocalSelect({
							title: locale === "zh" ? "绑定账户" : "Bind account",
							options: accountLabels,
							onResolve: (accountResult) => {
								const accountIndex = accountLabels.indexOf(accountResult?.value) - 1;
								const accountRef = accountIndex >= 0 ? { providerId: model.provider, id: accounts[accountIndex].id } : undefined;
								const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
								openLocalSelect({
									title: locale === "zh" ? "思考强度" : "Thinking level",
									options: levels,
									selected: Math.max(0, levels.indexOf(existing?.thinking || "medium")),
									onResolve: (thinkingResult) => {
										if (!thinkingResult?.value) return;
										openLocalInput({
											title: locale === "zh" ? "独立系统提示词" : "Independent system prompt",
											message: locale === "zh" ? "可留空；Alt+Enter 换行" : "Optional · Alt+Enter for a newline",
											prefill: existing?.systemPrompt || "",
											onResolve: (promptResult) => {
								const saved = saveAgent(agentDir, {
									...existing, name, provider: model.provider, model: model.id, accountRef,
									thinking: thinkingResult.value, systemPrompt: promptResult?.value || "",
								});
												toast(`${saved.name} ${locale === "zh" ? "已保存" : "saved"}`, "info");
											},
										});
									},
								});
							},
						});
					},
				});
			},
		});
	};

	const openAgentActions = (agent) => {
		if (!agent) return;
		const activateLabel = locale === "zh" ? "启用" : "Activate";
		const editLabel = locale === "zh" ? "编辑" : "Edit";
		const deleteLabel = locale === "zh" ? "删除" : "Delete";
		openLocalSelect({ title: agent.name, message: `${agent.provider}/${agent.model} · ${agent.thinking}`, options: [activateLabel, editLabel, deleteLabel], onResolve: (action) => {
			if (action?.value === activateLabel) void runInput(`/kagent use ${agent.id}`);
			else if (action?.value === editLabel) void editAgent(getAgent(agentDir, agent.id));
			else if (action?.value === deleteLabel && deleteAgent(agentDir, agent.id)) toast(`${agent.name} ${locale === "zh" ? "已删除" : "deleted"}`, "info");
		} });
	};
	const openAgents = (focusId) => {
		if (focusId) { openAgentActions(getAgent(agentDir, focusId)); return; }
		const agents = listAgents(agentDir);
		const create = locale === "zh" ? "＋ 新建 Agent" : "＋ New agent";
		const labels = [...agents.map((agent) => `${agent.name} · ${agent.provider}/${agent.model}`), create];
		openLocalSelect({
			title: "Agents",
			message: locale === "zh" ? "选择、编辑或删除可复用 Agent" : "Activate, edit, or delete reusable agents",
			options: labels,
			descriptions: new Map(agents.map((agent, index) => [labels[index], `${agent.thinking} · ${agent.accountRef ? (locale === "zh" ? "独立账户" : "bound account") : (locale === "zh" ? "当前账户" : "current account")} · ${agent.description || agent.id}`])),
			searchable: true,
			onResolve: (result) => {
				if (result?.value === create) { void editAgent(); return; }
				const agent = agents[labels.indexOf(result?.value)]; if (!agent) return;
				openAgentActions(agent);
			},
		});
	};

	const openSkills = (query = "") => {
		// This catalog is intentionally independent of PI's registered commands.
		// Disabled skills are not registered by PI, but must remain visible here so
		// the user can turn them back on.
		const discovered = discoverSkills(agentDir);
		managedSkills = discovered.skills;
		skillDiagnostics.length = 0;
		skillDiagnostics.push(...discovered.diagnostics);
		disabledSkills = new Set(loadSkillSettings(agentDir).disabled);
		const normalized = query.trim().toLowerCase();
		const skills = managedSkills
			.filter((skill) => !normalized || skill.name.toLowerCase().includes(normalized) || skill.description?.toLowerCase().includes(normalized))
			.sort((a, b) => a.name.localeCompare(b.name));
		if (!skills.length) {
			toast(locale === "zh" ? (normalized ? "没有匹配的 Skill" : "没有发现 Skill") : (normalized ? "No matching skills" : "No Tsukuyomi skills discovered"), "warning");
			return;
		}
		const labels = skills.map((skill) => skill.name);
		const apply = locale === "zh" ? "✓ 应用并重启内核" : "✓ Apply and restart kernel";
		const pending = new Map(skills.map((skill) => [skill.name, !disabledSkills.has(skill.name)]));
		const descriptions = new Map(skills.map((skill) => [skill.name,
			`${skill.description || ""} · ${compactPath(skill.filePath)}${disabledSkills.has(skill.name) ? (locale === "zh" ? " · 当前关闭" : " · disabled") : (locale === "zh" ? " · 当前开启" : " · enabled")}`,
		]));
		descriptions.set(apply, locale === "zh" ? "保存选择，重启 PI 内核后立即生效" : "Save the selection and restart the PI kernel to apply it");
		openLocalSelect({
			title: locale === "zh" ? "Skills（Tsukuyomi 管理）" : "Skills (managed by Tsukuyomi)",
			message: locale === "zh" ? "空格切换开启/关闭；选择最后一项应用。关闭的 Skill 不会加载到模型上下文，也不能通过 /skill:name 调用。" : "Space toggles enablement; choose the last item to apply. Disabled skills are not loaded or invokable.",
			options: [...labels, apply],
			descriptions,
			searchable: true,
			checked: (name) => pending.get(name) === true,
			onToggle: (name) => {
				if (pending.has(name)) pending.set(name, !pending.get(name));
			},
			applyOption: apply,
			onApply: () => {
				if (state.working || state.compacting) {
					toast(locale === "zh" ? "请等待当前运行结束后再切换 Skill" : "Wait for the current run to finish before changing skills", "warning");
					return;
				}
				const known = new Set(skills.map((skill) => skill.name));
				const nextDisabled = [
					...disabledSkills,
					...skills.filter((skill) => !pending.get(skill.name)).map((skill) => skill.name),
				].filter((name, index, values) => (!known.has(name) || !pending.has(name)) && values.indexOf(name) === index).sort();
				const before = [...disabledSkills].sort();
				if (JSON.stringify(before) === JSON.stringify(nextDisabled)) {
					clearDialog();
					tui.requestRender();
					return;
				}
				if (!saveSkillSettings(agentDir, { disabled: nextDisabled })) {
					toast(locale === "zh" ? "Skill 配置保存失败" : "Could not save skill configuration", "error");
					return;
				}
				disabledSkills = new Set(nextDisabled);
				clearDialog();
				toast(locale === "zh" ? "Skill 配置已保存，正在重启内核…" : "Skill configuration saved; restarting kernel…", "info", 6_000);
				setTimeout(() => shutdown(0, { restart: "skills", session: state.sessionFile, workspace: cwd }), 120);
			},
		});
	};

	const sendTeamCommand = async (verb, payload = {}) => {
		// Extension commands are control traffic, not user prompts. Sending them
		// directly keeps their JSON payload out of editor history and chat bands.
		try { await request({ type: "prompt", message: `/kteam ${verb} ${JSON.stringify(payload)}` }, { timeoutMs: 30_000 }); }
		catch { /* request() already displayed the error */ }
	};
	const configureTeamMembers = ({ ids, objective, collaborationMode, leaderId, verb }) => {
		const memberProfiles = {};
		const available = listAgents(agentDir);
		const configure = (index) => {
			if (index >= ids.length) {
				if (verb === "start") void sendTeamCommand("start", { agentIds: ids, objective, collaborationMode, leaderId, memberProfiles });
				else void sendTeamCommand("join", { agentIds: ids, memberProfiles });
				return;
			}
			const id = ids[index];
			if (id === leaderId) {
				memberProfiles[id] = { profile: "plan", isolation: "current-readonly" };
				configure(index + 1);
				return;
			}
			const agent = available.find((item) => item.id === id);
			const research = locale === "zh" ? "研究 · 只读" : "Research · read-only";
			const review = locale === "zh" ? "审查 · 只读" : "Review · read-only";
			const build = locale === "zh" ? "构建 · 可写" : "Build · writable";
			const profileByLabel = new Map([[research, "research"], [review, "review"], [build, "build"]]);
			openLocalSelect({
				title: `${locale === "zh" ? "配置成员" : "Configure member"}: ${agent?.name || id}`,
				message: locale === "zh" ? "权限配置独立于文件隔离方式" : "Permission profile is independent from filesystem isolation",
				options: [research, review, build],
				descriptions: new Map([
					[research, locale === "zh" ? "读取、搜索和汇报，不修改文件" : "Read, search, and report without file changes"],
					[review, locale === "zh" ? "只读审查和验证" : "Read-only review and validation"],
					[build, locale === "zh" ? "允许实现；需要 worktree 或共享写租约" : "Implement changes in a worktree or under the shared-write lease"],
				]),
				onResolve: (profileResult) => {
					const profile = profileByLabel.get(profileResult?.value);
					if (!profile) return;
					if (profile !== "build") {
						memberProfiles[id] = { profile, isolation: "current-readonly" };
						configure(index + 1);
						return;
					}
					if (collaborationMode === "peer") {
						memberProfiles[id] = { profile: "build", isolation: "shared-write" };
						configure(index + 1);
						return;
					}
					const worktree = locale === "zh" ? "Git Worktree · 隔离" : "Git worktree · isolated";
					const shared = locale === "zh" ? "Shared write · 单写者租约" : "Shared write · single-writer lease";
					openLocalSelect({
						title: locale === "zh" ? "构建隔离" : "Build isolation",
						message: locale === "zh" ? "共享写入可在 Git 或非 Git 目录直接写入，但同一时间只有获得租约的成员可以写文件" : "Shared writes work in Git and non-Git directories; an explicit lease allows only one member to write at a time",
						options: [worktree, shared],
						onResolve: (isolationResult) => {
							if (!isolationResult?.value) return;
							memberProfiles[id] = { profile: "build", isolation: isolationResult.value === shared ? "shared-write" : "git-worktree" };
							configure(index + 1);
						},
					});
				},
			});
		};
		configure(0);
	};
	const pickTeamAgents = ({ candidates, verb, objective }) => {
		const picked = new Set();
		const show = () => {
			const rows = candidates.map((agent) => `${picked.has(agent.id) ? "●" : "○"} ${agent.name} · ${agent.provider}/${agent.model}`);
			const done = `${locale === "zh" ? "继续" : "Continue"} (${picked.size})`;
			openLocalSelect({
				title: verb === "kick" ? (locale === "zh" ? "移出 Agent" : "Kick agents") : (locale === "zh" ? "选择 Agent" : "Select agents"),
				message: locale === "zh" ? "逐个切换成员，然后选择继续" : "Toggle members one by one, then choose Continue",
				options: [...rows, done],
				onResolve: (result) => {
					if (result?.value === done) {
						if (!picked.size) { toast(locale === "zh" ? "请至少选择一个 Agent" : "Select at least one agent", "warning"); return; }
						if (verb === "start") {
							openLocalInput({ title: locale === "zh" ? "团队目标" : "Team objective", prefill: objective || "", onResolve: (input) => {
								if (!input?.value?.trim()) return;
								const ids = [...picked];
								const peer = locale === "zh" ? "Peer · 平等协作" : "Peer · equal collaboration";
								const leader = locale === "zh" ? "Leader · 独立规划 + 用户批准" : "Leader · independent plan + user approval";
								openLocalSelect({
									title: locale === "zh" ? "团队协作模式" : "Collaboration mode",
									options: [peer, leader],
									descriptions: new Map([[peer, locale === "zh" ? "成员通过 broker 讨论并按各自权限协作" : "Members discuss through the broker with their granted profiles"], [leader, locale === "zh" ? "独立 Leader 先规划，执行前必须由用户批准" : "A separate leader plans first; execution requires explicit user approval"]]),
									onResolve: (modeResult) => {
										if (modeResult?.value === peer) configureTeamMembers({ ids, objective: input.value.trim(), collaborationMode: "peer", verb: "start" });
										else if (modeResult?.value === leader) {
											const available = listAgents(agentDir);
											const labels = ids.map((id) => `${available.find((item) => item.id === id)?.name || id} · ${id}`);
											openLocalSelect({ title: locale === "zh" ? "选择独立 Leader" : "Select planning leader", options: labels, onResolve: (leaderResult) => {
												const leaderIndex = labels.indexOf(leaderResult?.value);
													if (leaderIndex >= 0) configureTeamMembers({ ids, objective: input.value.trim(), collaborationMode: "leader", leaderId: ids[leaderIndex], verb: "start" });
												} });
										}
								},
								});
							} });
						} else configureTeamMembers({ ids: [...picked], objective: undefined, collaborationMode: state.team?.collaborationMode || "peer", verb });
						return;
					}
					const index = rows.indexOf(result?.value);
					if (index >= 0) { const id = candidates[index].id; if (picked.has(id)) picked.delete(id); else picked.add(id); show(); }
				},
			});
		};
		show();
	};
	const openTeamActions = () => {
		const agents = listAgents(agentDir);
		if (!agents.length) { toast(locale === "zh" ? "请先用 /agents 创建 Agent" : "Create agents with /agents first", "warning"); return; }
		if (!state.team?.active) { pickTeamAgents({ candidates: agents, verb: "start" }); return; }
		const join = locale === "zh" ? "加入 Agent" : "Join agents";
		const kick = locale === "zh" ? "移出 Agent" : "Kick agents";
		const approve = locale === "zh" ? "批准 Leader 计划" : "Approve leader plan";
		const takeover = locale === "zh" ? "手动接任 Leader" : "Take over as leader";
		const stop = locale === "zh" ? "停止团队" : "Stop team";
		const pendingPermissions = (state.team.permissionRequests || []).filter((request) => request.status === "pending");
		const permissionLabels = pendingPermissions.map((request) => `${locale === "zh" ? "处理权限" : "Resolve permission"} · ${request.memberId} · ${request.kind}`);
		const actions = [...permissionLabels];
		if (state.team.phase === "awaiting_approval") actions.push(approve);
		if (state.team.phase === "paused" && state.team.collaborationMode === "leader") actions.push(takeover);
		actions.push(join, kick, stop);
		openLocalSelect({ title: "Agent Team", message: `${state.team.collaborationMode || "peer"} · ${state.team.phase || "stopped"}\n${state.team.objective}`, options: actions, onResolve: (result) => {
			const permissionIndex = permissionLabels.indexOf(result?.value);
			if (permissionIndex >= 0) {
				const request = pendingPermissions[permissionIndex];
				const yes = locale === "zh" ? "批准" : "Approve";
				const no = locale === "zh" ? "拒绝" : "Deny";
				openLocalSelect({ title: result.value, options: [yes, no], onResolve: (choice) => {
					if (choice?.value === yes || choice?.value === no) void sendTeamCommand("permission", { requestId: request.id, approved: choice.value === yes });
				} });
				return;
			}
			if (result?.value === approve) { void sendTeamCommand("approve"); return; }
			if (result?.value === takeover) {
				const members = new Set(state.team.members.map((member) => member.id));
				const candidates = agents.filter((agent) => !members.has(agent.id));
				openLocalSelect({ title: locale === "zh" ? "选择接任 Leader" : "Select replacement leader", options: candidates.map((agent) => `${agent.name} · ${agent.id}`), onResolve: (choice) => {
					const agent = candidates.find((item) => `${item.name} · ${item.id}` === choice?.value);
					if (agent) void sendTeamCommand("takeover", { agentId: agent.id });
				} });
				return;
			}
			if (result?.value === join) {
				const ids = new Set(state.team.members.map((member) => member.id));
				pickTeamAgents({ candidates: agents.filter((agent) => !ids.has(agent.id)), verb: "join" });
			} else if (result?.value === kick) {
				const byId = new Map(agents.map((agent) => [agent.id, agent]));
				pickTeamAgents({ candidates: state.team.members.map((member) => byId.get(member.id) || member), verb: "kick" });
			} else if (result?.value === stop) void sendTeamCommand("stop");
		} });
	};

	const showHubTask = async (job) => {
		const fresh = await taskClient.request("get", { id: job.id });
		if (fresh?.cwd !== cwd) { toast(t("toast.workspaceUnreadable", { path: job.cwd || "" }), "error"); return; }
		const isRunning = !fresh.endedAt && ["running", "queued"].includes(fresh.status);
		const view = locale === "zh" ? "查看输出" : "View output";
		const cancel = locale === "zh" ? "取消任务" : "Cancel task";
		const steer = locale === "zh" ? "纠正任务" : "Steer task";
		const apply = locale === "zh" ? "检查并应用补丁" : "Check and apply patch";
		const actions = [view, ...(isRunning ? [cancel, ...(fresh.kind === "subagent" && fresh.status === "running" ? [steer] : [])] : []), ...(fresh.kind === "subagent" && fresh.status === "done" && fresh.patchPath ? [apply] : [])];
		openLocalSelect({ title: fresh.command || fresh.kind, message: `${fresh.status} · ${fresh.profile || (fresh.readonly ? "read-only" : "—")} · ${fresh.patchPath || "—"}`, options: actions, onResolve: (answer) => {
			if (answer?.value === view) {
				replaceDialog({ source: "local", kind: "status", title: fresh.command || "Task", message: redactText((fresh.kind === "pty" ? fresh.screen || fresh.output : fresh.output || fresh.result) || "—").slice(-50_000), statusOffset: 0, onResolve: () => { void openAgentHub(); } });
			} else if (answer?.value === steer) {
				openLocalInput({ title: steer, onResolve: (result) => result?.value?.trim() && taskClient.request("steer", { id: fresh.id, message: result.value.trim() }).catch((error) => toast(error.message, "error")) });
			} else if (answer?.value === cancel || answer?.value === apply) {
				openLocalSelect({ title: answer.value, kind: "confirm", options: [t("action.yes"), t("action.no")], selected: 1,
					onResolve: async (choice) => {
						if (!choice?.confirmed) return;
						const latest = await taskClient.request("get", { id: fresh.id });
						if (latest.cwd !== cwd || (answer.value === cancel ? Boolean(latest.endedAt) : latest.status !== "done" || !latest.patchPath)) throw new Error("Task state changed; reopen the Hub");
						await taskClient.request(answer.value === cancel ? "cancel" : "apply", { id: fresh.id });
						toast(answer.value === cancel ? (locale === "zh" ? "任务已取消" : "Task cancelled") : (locale === "zh" ? "补丁已应用" : "Patch applied"), "info");
					},
				});
			}
		} });
	};
	const openAgentHub = async () => {
		const jobs = await taskClient.request("list").catch(() => []);
		const rows = buildAgentHubRows({ team: state.team, jobs: Array.isArray(jobs) ? jobs : [], agents: listAgents(agentDir), cwd, locale });
		const options = rows.map((row, index) => `${row.kind.toUpperCase()}  ${row.title}  · ${index + 1}`);
		openLocalSelect({ title: locale === "zh" ? "Agent Hub · 团队与任务" : "Agent Hub · Team & tasks", options, searchable: true,
			descriptions: new Map(rows.map((row, index) => [options[index], row.detail])),
			onResolve: (result) => {
				const row = rows[options.indexOf(result?.value)];
				if (!row) return;
				if (row.kind === "task") void showHubTask(row.data).catch((error) => toast(error.message, "error"));
				else if (row.kind === "permission") {
					openLocalSelect({ title: row.title, message: row.detail, kind: "confirm", options: [t("action.yes"), t("action.no")], selected: 1, onResolve: (choice) => {
						if (choice?.cancelled) return;
						if (!state.team?.permissionRequests?.some((request) => request.id === row.id && request.status === "pending")) { toast("Permission request expired", "warning"); return; }
						void sendTeamCommand("permission", { requestId: row.id, approved: Boolean(choice.confirmed) });
					} });
				} else if (row.kind === "agent") openAgents();
				else if (row.kind === "member" || row.kind === "summary") openTeamActions();
				else if (row.kind === "report") replaceDialog({ source: "local", kind: "status", title: row.title, message: redactText(row.data?.text || row.detail).slice(-50_000), statusOffset: 0, onResolve: () => { void openAgentHub(); } });
			},
		});
		if (state.dialog?.source === "local" && state.dialog.title?.startsWith("Agent Hub")) {
			state.dialog.kind = "hub";
			state.dialog.hubRows = rows;
			state.dialog.hubOptions = options;
			state.dialog.hubJobs = Array.isArray(jobs) ? jobs : [];
		}
	};
	const refreshHubDialog = (job) => {
		const dialog = state.dialog;
		if (dialog?.kind !== "hub") return;
		if (job) {
			const index = dialog.hubJobs.findIndex((item) => item.id === job.id);
			if (index >= 0) dialog.hubJobs[index] = job;
			else dialog.hubJobs.push(job);
			if (dialog.hubJobs.length > 200) dialog.hubJobs.splice(0, dialog.hubJobs.length - 200);
		}
		const selectedOption = dialog.options[dialog.selected];
		const selectedItem = dialog.hubRows?.[dialog.hubOptions?.indexOf(selectedOption)];
		const rows = buildAgentHubRows({ team: state.team, jobs: dialog.hubJobs, agents: listAgents(agentDir), cwd, locale });
		const options = rows.map((row, index) => `${row.kind.toUpperCase()}  ${row.title}  · ${index + 1}`);
		dialog.hubRows = rows;
		dialog.hubOptions = options;
		dialog.allOptions = options;
		dialog.descriptions = new Map(rows.map((row, index) => [options[index], row.detail]));
		dialog.options = filterSelectOptions(options, dialog.descriptions, dialog.query);
		const selected = rows.findIndex((item) => item.kind === selectedItem?.kind && item.id === selectedItem?.id);
		dialog.selected = Math.max(0, Math.min(dialog.options.length - 1, dialog.options.indexOf(options[selected])));
		tui.requestRender();
	};
	const openTeam = () => { void openAgentHub().catch((error) => toast(error.message, "error")); };

	const availableThinkingLevels = async () => {
		const data = await request({ type: "get_available_thinking_levels" }, { timeoutMs: 30_000 });
		return Array.isArray(data?.levels) ? data.levels.filter((level) => typeof level === "string") : [];
	};

	const applyThinkingLevel = async (level) => {
		await request({ type: "set_thinking_level", level }, { timeoutMs: 30_000 });
		state.thinking = level;
		toast(t("toast.thinking", { level }), "info");
		tui.requestRender();
	};

	const cycleThinkingLevel = async () => {
		const levels = await availableThinkingLevels();
		if (!levels.length) { toast(t("toast.noThinking"), "warning"); return; }
		const current = levels.indexOf(state.thinking);
		await applyThinkingLevel(levels[(current + 1) % levels.length]);
	};

	const openThinkingSelector = async () => {
		toast(t("toast.loadingThinking"), "info", 2_000);
		try {
			const levels = await availableThinkingLevels();
			if (!levels.length) {
				toast(t("toast.noThinking"), "warning");
				return;
			}
			openLocalSelect({
				title: t("dialog.thinking"),
				message: t("dialog.thinkingMessage"),
				options: levels,
				descriptions: new Map(levels.map((level) => [level, t(`thinking.${level}`) === `thinking.${level}` ? t("thinking.modelSpecific") : t(`thinking.${level}`)])),
				selected: Math.max(0, levels.indexOf(state.thinking)),
				onResolve: (result) => {
					if (typeof result?.value === "string") return applyThinkingLevel(result.value);
				},
			});
		} catch {
			// request() already displayed the error.
		}
	};

	const resolveWorkspace = (value) => {
		const input = value?.trim() || ".";
		const home = process.env.HOME || "";
		const expanded = input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
		try {
			const target = realpathSync(resolve(cwd, expanded));
			return statSync(target).isDirectory() ? target : undefined;
		} catch {
			return undefined;
		}
	};

	const chooseWorkspace = (value) => {
		if (!value?.trim() && workspacePool) {
			const entries = workspacePool.list();
			const labels = entries.map((e) => `${e.working ? "●" : "○"} ${e.waiting ? "! " : ""}${e.cwd}`);
			const add = locale === "zh" ? "+ 打开工作区" : "+ Open workspace";
			openLocalSelect({ title: t("dialog.workspace"), options: [...labels, add], onResolve: (result) => {
				if (result?.value === add) openLocalInput({ title: t("dialog.workspace"), prefill: cwd, onResolve: (r) => r?.value && chooseWorkspace(r.value) });
				else { const index = labels.indexOf(result?.value); if (index >= 0) chooseWorkspace(entries[index].cwd); }
			} });
			return;
		}
		const target = resolveWorkspace(value);
		if (!target) {
			toast(t("toast.workspaceUnreadable", { path: value || "." }), "error");
			return;
		}
		if (target === cwd) {
			askShowFiles();
			return;
		}
		const switchWorkspace = () => shutdown(0, { workspace: target });
		if (workspacePool) { switchWorkspace(); return; }
		if (state.messages.length > 0) {
			openLocalSelect({
				title: t("dialog.switchWorkspace"),
				message: t("dialog.switchWorkspaceMessage", { path: compactPath(target) }),
				kind: "confirm",
				options: [t("action.yes"), t("action.no")],
				onResolve: (result) => {
					if (result?.confirmed) switchWorkspace();
				},
			});
			return;
		}
		switchWorkspace();
	};

	const activate = () => {
		if (!state.active) {
			state.active = true;
			tree.refresh();
		}
	};

	const narrowPanelMode = () => (state.lastTerminalWidth || 0) < FULL_RAIL_MIN_COLUMNS;
	const togglePanel = (kind) => {
		activate();
		if (narrowPanelMode()) {
			state.panelOverlay = state.panelOverlay === kind ? undefined : kind;
			if (state.panelOverlay === "files") {
				state.showFiles = true;
				tree.refresh();
			} else if (state.panelOverlay === "workflow") state.showWorkflow = true;
			else if (state.panelOverlay === "todo") state.showTodos = true;
			state.pointer.cancel();
			tui.requestRender();
			return;
		}
		state.panelOverlay = undefined;
		if (kind === "files") {
			state.showFiles = !state.showFiles;
			if (state.showFiles) tree.refresh();
		} else if (kind === "workflow") state.showWorkflow = !state.showWorkflow;
		else if (kind === "todo") state.showTodos = !state.showTodos;
		state.pointer.cancel();
		tui.requestRender();
	};

	const runInput = async (raw, streamingBehavior = "steer") => {
		const value = raw.trim();
		if (!value) return;
		if (state.dialog && ["input", "editor"].includes(state.dialog.kind)) {
			finishDialog({ value: raw });
			return;
		}
		editor.addToHistory(raw);

		const [rawCommand, ...tail] = value.startsWith("/") ? value.slice(1).split(/\s+/) : ["", ""];
		const command = rawCommand.toLowerCase();
		const rest = tail.join(" ");
		if (command === "tasks") {
			try { await openAgentHub(); } catch (error) { toast(error.message, "error"); }
			return;
		}
		if (command === "followup") return runInput(rest, "followUp");
		if (command === "steer") return runInput(rest, "steer");
		if (command === "interrupt") {
			if (!rest) { toast(t("toast.interruptUsage"), "warning"); return; }
			return interruptAndSend(rest);
		}
		if (command === "quit" || command === "exit") return shutdown(0);
		if (command === "help") {
			toast(t("toast.help"), "info", 10_000);
			return;
		}
		if (command === "perf") {
			const file = startPerfLog();
			toast(`${perfSnapshot()}${file ? ` → ${file}` : ""}`, "info", 10_000);
			return;
		}
		if (command === "files") {
			if (!state.workspaceDeclared) askShowFiles();
			else togglePanel("files");
			return;
		}
		if (command === "workflow") {
			togglePanel("workflow"); return;
		}
		if (command === "todo") {
			togglePanel("todo"); return;
		}
		if (command === "sidebar") {
			activate();
			if (narrowPanelMode()) {
				state.panelOverlay = state.panelOverlay ? undefined : "workflow";
				if (state.panelOverlay) state.showWorkflow = true;
				tui.requestRender(); return;
			}
			const visible = state.showFiles || state.showWorkflow || state.showTodos;
			state.showFiles = state.workspaceDeclared && !visible;
			state.showWorkflow = !visible;
			state.showTodos = !visible;
			tui.requestRender(); return;
		}
		if (command === "mode") return rest ? setMode(rest.toLowerCase()) : openModeSelector();
		if (command === "workspace") return chooseWorkspace(rest);
		if (command === "language" || command === "lang") return rest ? setLocale(rest) : openLanguageSelector();
		if (command === "status") return openStatus(["refresh", "force"].includes(rest.toLowerCase()));
		if (command === "settings" || command === "config") { activate(); return openSettings(); }
		if (command === "update") return promptForUpdate();
		if (command === "accounts" || command === "account") {
			try { await openAccounts(); } catch (error) { toast(redactText(error?.message || String(error)), "error"); }
			return;
		}
		if (command === "agents" || command === "agent") {
			try { openAgents(); } catch (error) { toast(redactText(error?.message || String(error)), "error"); }
			return;
		}
		if (command === "skill" || command === "skills") {
			openSkills(rest);
			return;
		}
		if (command === "team") {
			try { openTeam(); } catch (error) { toast(redactText(error?.message || String(error)), "error"); }
			return;
		}
		if (command === "new") {
			activate();
			try {
				const result = await request({ type: "new_session" }, { timeoutMs: 30_000 });
				if (!result?.cancelled) {
					replaceMessages([]); state.workflow = []; state.todos = []; resetTranscript();
					state.sessionTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
					state.usageStatus = undefined;
					clearStream(); state.runStartText = undefined; state.runStartAt = undefined;
					state.runStartIndex = undefined; state.runPromptPersisted = false; state.runWorkSince = undefined;
					state.runThoughtMs = 0; state.thinkingPhaseStart = undefined;
					state.lastThoughtMs = undefined; state.lastWorkMs = undefined;
					const session = await rpc.request({ type: "get_state" }, 30_000).catch(() => undefined);
					state.sessionFile = session?.sessionFile;
					state.sessionName = session?.sessionName || "";
					toast(t("toast.newSession"), "info");
				}
			} catch {}
			return;
		}
		if (command === "compact" || command === "kcompact") {
			activate();
			state.compacting = true; state.compactStatus = `${t("status.compactingShort")} · ${t("action.start").toLowerCase()}`; tui.requestRender();
			try { await request({ type: "compact", ...(rest ? { customInstructions: rest } : {}) }); }
			catch {} finally { state.compacting = false; tui.requestRender(); }
			return;
		}
		if (command === "model") {
			try {
				if (!rest) await openModelSelector();
				else {
					const models = await availableModels();
					const requested = rest.toLowerCase();
					const matches = models.filter((model) =>
						`${model.provider}/${model.id}`.toLowerCase() === requested || model.id.toLowerCase() === requested,
					);
					if (matches.length !== 1) {
						toast(matches.length ? t("toast.modelAmbiguous") : t("toast.modelNotFound", { model: rest }), "warning");
					} else await applyModel(matches[0]);
				}
			} catch {}
			return;
		}
		if (command === "provider" || command === "providers" || command === "setup") { try { await openProviderSelector(); } catch (error) { toast(redactText(error?.message || String(error)), "error"); } return; }
		if (command === "web-search" || command === "web_search") { openWebSearchSelector(); return; }
		if (command === "queue") {
			const queued = [...state.queueItems.steering.map((item) => `↪ ${item}`), ...state.queueItems.followUp.map((item) => `+ ${item}`)];
			replaceDialog({ source: "local", kind: "status", title: "Queue", message: queued.join("\n") || (locale === "zh" ? "队列为空" : "Queue is empty"), options: [] });
			tui.requestRender(); return;
		}
		if (command === "tools") return openToolsDialog();
		if (command === "sessions") return openSessionsDialog();
		if (command === "touch") {
			const requested = rest.toLowerCase();
			if (requested && !["on", "off"].includes(requested)) {
					toast(t("toast.touchUsage"), "warning");
				return;
			}
			state.touchMode = requested ? requested === "on" : !state.touchMode;
			state.pointer.cancel();
			toast(t("toast.touch", { state: state.touchMode ? t("toast.touchOn") : t("toast.touchOff") }), "info");
			tui.requestRender();
			return;
		}
		if (command === "thinking") {
			if (!rest) return openThinkingSelector();
			try {
				const levels = await availableThinkingLevels();
				const level = levels.find((candidate) => candidate.toLowerCase() === rest.toLowerCase());
				if (!level) toast(t("toast.unknownThinking", { level: rest, levels: levels.join(", ") }), "warning");
				else await applyThinkingLevel(level);
			} catch {
				// request() already displayed the error.
			}
			return;
		}

		activate();
		resetTranscript();
		if (!command && state.team?.active) {
			const receiver = state.team.collaborationMode === "leader"
				? (state.team.members || []).find((member) => member.id === state.team.leaderId)?.name || "leader"
				: (state.team.members || []).filter((member) => !member.removedAt).map((member) => member.name).join(", ");
			toast(`${locale === "zh" ? "发送给" : "Sending to"} ${receiver}`, "info", 4_000);
			await sendTeamCommand("dispatch", { prompt: value });
			return;
		}
		if (!state.working) {
			state.runStartText = value;
			state.runStartAt = Date.now();
			state.runPromptPersisted = false;
			state.runStartIndex = undefined;
			state.runWorkSince = Date.now();
			state.runThoughtMs = 0;
			state.thinkingPhaseStart = undefined;
			state.lastThoughtMs = undefined;
			state.lastWorkMs = undefined;
			tui.requestRender();
		}
		try {
			await request({
				type: "prompt",
				message: raw,
				streamingBehavior,
			}, { timeoutMs: 30_000 });
			// The kernel emits the user message's `message_end`, which
			// appendFinalMessage folds in; no snapshot round-trip is needed here.
		} catch { editor.setText(raw); }
	};

	// Grok Build-style interject: forcibly stop the in-flight turn (and drop
	// anything queued), then start a fresh turn with this prompt immediately.
	const waitForIdle = (timeoutMs = 4_000) => new Promise((resolve) => {
		const startedAt = Date.now();
		const check = () => {
			if (!state.working || Date.now() - startedAt >= timeoutMs) resolve();
			else setTimeout(check, 30);
		};
		check();
	});
	const interruptAndSend = async (raw) => {
		const value = String(raw ?? "").trim();
		if (!value) return;
		editor.addToHistory(value);
		activate();
		resetTranscript();
		state.runStartText = value;
		state.runStartAt = Date.now();
		state.runPromptPersisted = false;
		state.runStartIndex = undefined;
		state.runWorkSince = Date.now();
		state.runThoughtMs = 0;
		state.thinkingPhaseStart = undefined;
		state.lastThoughtMs = undefined;
		state.lastWorkMs = undefined;
		state.working = true;
		editor.setText("");
		tui.requestRender();
		try { await rpc.request({ type: "clear_queue" }, 10_000); } catch {}
		try { await rpc.request({ type: "abort" }, 30_000); } catch {}
		await waitForIdle();
		try {
			await request({ type: "prompt", message: value }, { timeoutMs: 30_000 });
		} catch {
			state.working = false;
			editor.setText(value);
			tui.requestRender();
		}
	};

	editor.onChange = () => resetCursorBlink();
	editor.onSubmit = (value) => { void runInput(value); };

	const settingsBool = (value) => value ? t("settings.on") : t("settings.off");
	const settingsGroups = () => ([
		{ header: "🎨 Appearance", items: [
			{ id: "language", label: t("settings.language"), detail: languageName() },
			{ id: "sidebar", label: t("settings.rightSidebar"), detail: settingsBool(state.showWorkflow || state.showTodos), toggle: true },
			{ id: "markdown", label: t("settings.markdown"), detail: settingsBool(state.markdown), toggle: true },
		] },
		{ header: "🤖 Model", items: [
			{ id: "model", label: t("settings.model"), detail: state.model?.id || t("status.noModel") },
			{ id: "thinkingLevel", label: t("command.thinking"), detail: state.thinking },
		] },
		{ header: "⌨ Interaction", items: [
			{ id: "thinking", label: t("settings.thinking"), detail: settingsBool(state.thinkingAutoCollapse), toggle: true },
			{ id: "touch", label: t("settings.touch"), detail: settingsBool(state.touchMode), toggle: true },
			{ id: "keybindings", label: t("settings.keybindings"), detail: t(state.keybindingPreset === "omp" ? "settings.keybindingsOmp" : "settings.keybindingsLegacy") },
			{ id: "mode", label: t("command.mode"), detail: t(`mode.${state.mode}`) },
		] },
		{ header: "📋 Context", items: [
			{ id: "compact", label: t("command.compact") },
			{ id: "status", label: t("command.status") },
		] },
		{ header: "🧠 Memory", items: [
			{ id: "sessions", label: t("command.sessions") },
			{ id: "new", label: t("command.new") },
		] },
		{ header: "📁 Files", items: [
			{ id: "workspace", label: t("command.workspace"), detail: compactPath(cwd) },
		] },
		{ header: "💻 Shell", items: [
			{ id: "tools", label: t("command.tools") },
		] },
		{ header: "🔧 Tools", items: [
			{ id: "tools", label: t("command.tools") },
			{ id: "webSearch", label: "Web search", detail: "Auto / Parallel / Perplexity / Gemini / Anthropic / OpenAI / xAI / OpenRouter" },
		] },
		{ header: "📦 Tasks", items: [
			{ id: "team", label: t("command.team") },
			{ id: "agents", label: t("command.agents") },
		] },
		{ header: "🌐 Providers", items: [
			{ id: "provider", label: t("settings.provider"), detail: state.model?.provider || t("status.notAvailable") },
			{ id: "accounts", label: t("settings.accounts"), detail: t("settings.accountsHint") },
			{ id: "customModels", label: t("custom.modelsSettings"), detail: t("custom.modelsSettingsHint") },
			{ id: "customProvider", label: t("custom.add") },
		] },
		{ header: "📦 Plugins", items: [
			{ id: "skills", label: t("command.skill") },
		] },
		{ header: "◉ Agents", items: [
			...listAgents(agentDir).map((agent) => ({ id: `agent:${agent.id}`, label: agent.name, detail: `${agent.provider}/${agent.model} · ${agent.thinking}` })),
			{ id: "agents", label: locale === "zh" ? "＋ 新建 Agent" : "＋ New agent" },
			{ id: "team", label: locale === "zh" ? "团队协作设置" : "Agent team settings" },
		] },
		{ header: "ⓘ About", items: [
			{ id: "update", label: t("command.update") },
			{ id: "help", label: t("command.help") },
			{ id: "version", label: t("settings.version"), detail: `v${version}` },
		] },
	]);
	const buildSettingsRows = (tab = 0) => {
		const rows = [];
		const items = [];
		const group = settingsGroups()[tab] || settingsGroups()[0];
		if (group) {
			for (const item of group.items) {
				item.index = items.length;
				items.push(item);
				rows.push({ type: "item", item });
			}
		}
		return { rows, items };
	};
	const refreshSettingsRows = () => {
		const dialog = state.dialog;
		if (dialog?.kind !== "settings") return;
		const { rows, items } = buildSettingsRows(dialog.activeTab || 0);
		dialog.settingsRows = rows;
		dialog.items = items;
		dialog.selected = Math.max(0, Math.min(items.length - 1, dialog.selected || 0));
	};
	const runSettingsAction = (id) => {
		const close = () => { clearDialog(); };
		if (id?.startsWith("agent:")) {
			const agent = getAgent(agentDir, id.slice(6));
			if (agent) { close(); openAgents(agent.id); }
			return;
		}
		switch (id) {
			case "language": close(); openLanguageSelector(); break;
			case "sidebar": { const next = !(state.showWorkflow || state.showTodos); state.showWorkflow = next; state.showTodos = next; savePreferences(agentDir, { rightSidebarDefault: next }); break; }
			case "thinking": state.thinkingAutoCollapse = !state.thinkingAutoCollapse; savePreferences(agentDir, { thinkingAutoCollapse: state.thinkingAutoCollapse }); break;
			case "markdown": state.markdown = !state.markdown; savePreferences(agentDir, { markdown: state.markdown }); rebuildWorkflowHistory(state.messages); break;
			case "touch": state.touchMode = !state.touchMode; state.pointer.cancel(); savePreferences(agentDir, { touchMode: state.touchMode }); break;
			case "keybindings": {
				state.keybindingPreset = state.keybindingPreset === "omp" ? "legacy" : "omp";
				activeKeybindings = resolveTuiKeybindings(state.keybindingPreset, preferences.keybindingOverrides);
				savePreferences(agentDir, { keybindingPreset: state.keybindingPreset });
				break;
			}
			case "mode": close(); void nextMode(); break;
			case "workspace": close(); openLocalInput({ title: t("dialog.switchWorkspace"), prefill: cwd, onResolve: (result) => result?.value && chooseWorkspace(result.value) }); break;
			case "provider": close(); void openProviderSelector().catch((error) => toast(error?.message || String(error), "error")); break;
			case "customModels": close(); openCustomProviderModelSelector(); break;
			case "customProvider": close(); void addCustomProvider(); break;
			case "webSearch": close(); openWebSearchSelector(); break;
			case "accounts": close(); void openAccounts().catch((error) => toast(error?.message || String(error), "error")); break;
			case "model": close(); void openModelSelector().catch((error) => toast(error?.message || String(error), "error")); break;
			case "thinkingLevel": close(); void openThinkingSelector().catch((error) => toast(error?.message || String(error), "error")); break;
			case "new": close(); void runInput("/new"); break;
			case "sessions": close(); void openSessionsDialog(); break;
			case "compact": close(); void runInput("/compact"); break;
			case "tools": close(); openToolsDialog(); break;
			case "skills": close(); openSkills(); break;
			case "agents": close(); openAgents(); break;
			case "team": close(); openTeam(); break;
			case "status": close(); void openStatus(false); break;
			case "update": close(); void promptForUpdate({ automatic: false }); break;
			case "help": close(); toast(t("toast.help"), "info", 10_000); break;
			default: break;
		}
		refreshSettingsRows();
		tui.requestRender();
	};
	const openSettings = () => {
		clearTerminalSelection();
		state.pointer.cancel();
		const { rows, items } = buildSettingsRows(0);
		replaceDialog({
			source: "local",
			kind: "settings",
			title: t("settings.title"),
			selected: 0,
			activeTab: 0,
			scroll: 0,
			settingsRows: rows,
			items,
		});
		resetCursorBlink();
		tui.requestRender();
	};
	// Painted-row memo. render() pads and paints the background of every row each
	// frame; unchanged rows (borders, panel chrome, blanks) produce identical
	// strings and can reuse the previous painted result instead of re-running the
	// ANSI background regex over them.
	const paintedRowCache = createLruCache(8192);
	const paintRow = (line, width) => {
		const key = `${width}\u0000${line}`;
		const cached = paintedRowCache.get(key);
		if (cached !== undefined) return cached;
		const painted = blackBackground(pad(line.replace(/[\r\n\t]/g, " "), width));
		paintedRowCache.set(key, painted);
		return painted;
	};

	class TsukuyomiRoot extends Container {
		constructor() {
			super();
			this.historyCache = createHistoryCache();
			this.fileVisualCache = undefined;
			this.todoVisualCache = undefined;
			this.contextVisualCache = undefined;
			this.addChild(editor);
		}

		invalidate() {
			this.historyCache = createHistoryCache();
			this.fileVisualCache = undefined;
			this.todoVisualCache = undefined;
			this.contextVisualCache = undefined;
			editor.invalidate();
		}

		#contextText() {
			const percent = state.contextPercent;
			if (percent == null) return color.muted(t("status.contextUnknown"));
			const used = state.contextTokens ?? 0;
			const limit = percent > 0 && used > 0 ? Math.round(used / (percent / 100)) : undefined;
			const shorten = (value) => formatTokens(value, locale);
			const label = limit != null ? `${shorten(used)} / ${shorten(limit)}` : `${formatPercent(percent, locale)}%`;
			const painter = percent >= 85 ? color.error : percent >= 70 ? color.warning : percent >= 40 ? color.title : color.success;
			if (percent >= 85 && spinnerFrame % 2 === 0) return bold(painter(label));
			return painter(label);
		}

		#promptPrefix(maxWidth = undefined) {
			const raw = color.accent("❯");
			if (maxWidth == null || visibleWidth(raw) <= maxWidth) return raw;
			return truncateToWidth(raw, Math.max(1, maxWidth), "…");
		}

		#shortcutHint(value) {
			return String(value || "").split(/\s*│\s*/).map((part) => {
				const separator = part.indexOf(":");
				if (separator < 0) return color.dim(part);
				return `${bold(color.text(part.slice(0, separator)))}${color.dim(`:${part.slice(separator + 1)}`)}`;
			}).join(`  ${color.dim("│")}  `);
		}

		#bandRow(width, prompt, timestamp, owner) {
			return renderUserMessageBand({
				width,
				prompt,
				timestamp,
				owner,
				locale,
				visibleWidth,
				pad,
				promptPrefix: (maxWidth) => this.#promptPrefix(maxWidth),
				textRows,
				formatTime,
				bandBackground,
				color,
			});
		}

		#taskRows() {
			if (!state.working || !state.todos.length) return [];
			const rows = [`  ${color.muted(`✦ ${t("panel.tasks")} ${formatNumber(state.todos.length, locale)}`)}`];
			let firstPending = true;
			for (const todo of state.todos) {
				const inProgress = !todo.done && firstPending;
				if (!todo.done) firstPending = false;
				const icon = todo.done ? color.muted("✓")
					: inProgress ? bold(color.success(spinnerFrame % 2 ? "✦" : "◆"))
					: color.muted("⋮");
				const painter = todo.done ? color.dim : inProgress ? color.success : color.accent;
				const wrapped = wrapCached(todo, "text", todo.text || t("panel.task"), Math.max(8, 48));
				for (let index = 0; index < wrapped.length; index++) {
					rows.push(`    ${index === 0 ? `${icon} ` : "   "}${painter(wrapped[index] || " ")}`);
				}
			}
			return rows;
		}

		#pinBlockRows(width, block, durationText) {
			const rows = [];
			rows.push(...this.#taskRows());
			rows.push(...this.#bandRow(width, clean(textOfContent(block.message.content)).trim(), block.message.timestamp));
			if (durationText) rows.push(`  ${color.muted(t("status.workedFor", { duration: durationText }))}`);
			return rows;
		}

		#messageLines(width, omitUserIndex = undefined) {
			// Per-message render cache, mirroring grok-build's per-entry cache.
			// workflowRevision is not part of the layout key: a tool chunk only
			// re-renders the messages that own that tool. Unchanged history is
			// reused as immutable segments; the frame copies only the viewport.
			const inner = Math.max(4, width - 4);
			const cache = this.historyCache;
			syncHistoryCache(cache, {
				messages: state.messages,
				layoutKey: historyLayoutKey({
					width,
					terminalRows: tui.terminal.rows,
					omitUserIndex,
					locale,
				}),
				omitUserIndex: omitUserIndex ?? -1,
				liveTools: state.liveTools,
				thinkingAutoCollapse: state.thinkingAutoCollapse,
				thinkingExpanded: state.thinkingExpanded,
				lastWorkMs: state.lastWorkMs,
				lastThoughtMs: state.lastThoughtMs,
				now: Date.now(),
				dirtyToolIds: state.dirtyToolIds,
				renderMessage: (index) => this.#renderMessageSegment(cache, index, inner, width),
			});
			perf.segments += cache.rendered;
			perf.reused += cache.reused;
			if (cache.didAssemble) perf.assembles += 1;
			// Everything below is the live tail: an optimistic prompt, the streaming
			// phases, and the working indicator. Rows stay lazy (stored per segment
			// with a paint function) so a frame materializes only its visible window.
			const tailSegments = [];
			let tailLength = 0;
			const tailRanges = [];
			const renderedTailTools = new Set();
			const pushTailSegment = (rows, paint) => {
				if (!rows.length) return;
				tailSegments.push({ start: tailLength, rows, paint });
				tailLength += rows.length;
			};
			const appendTailTool = (id, name, args = {}, toolResult) => {
				if (renderedTailTools.has(id)) return;
				renderedTailTools.add(id);
				if (cache.toolIds.has(id)) return;
				let tool = state.liveTools.get(id);
				if (!tool) {
					tool = new LiveTool(id);
					tool.update({ type: toolResult ? "tool_execution_end" : "tool_execution_start", toolName: name, args, result: toolResult, isError: toolResult?.isError });
					state.liveTools.set(id, tool);
				}
				const rows = [];
				const start = tailLength;
				rows.push(...renderToolRows(tool, name, inner));
				pushTailSegment(rows, (line) => line);
				tailRanges.push({ id, start, end: tailLength });
			};
			// A prompt can be submitted a few frames before PI persists the user
			// message. Render that optimistic row in scrollback instead of pinning a
			// second copy above the viewport (the old layout did the latter).
			const pendingPrompt = clean(state.runStartText || "").trim();
			const persistedPendingPrompt = pendingPrompt && state.runPromptPersisted;
			if (state.working && pendingPrompt && !persistedPendingPrompt) {
				pushTailSegment(this.#bandRow(width, pendingPrompt, state.runStartAt), (line) => line);
				pushTailSegment([""], (line) => line);
			}
			// Streaming text is wrapped incrementally: only the trailing partial line
			// is reprocessed when a token arrives, instead of the whole response.
			const phaseRows = (phase, phaseWidth) => {
				if (state.markdown) {
					const streamingCode = renderStreamingCodeBlock(phase.text || "", {
						width: phaseWidth,
						streamState: phase.highlightState ||= {},
					});
					if (streamingCode) return streamingCode;
					if (/^\s*(`{3,}|~{3,})/m.test(phase.text || "")) {
						const key = `${phaseWidth}\0${phase.text || ""}`;
						if (phase.markdownKey !== key) {
							phase.markdownKey = key;
							phase.markdownRows = renderMarkdown(phase.text || "", { width: phaseWidth });
						}
						return phase.markdownRows;
					}
				}
				if (!phase.inc) {
					phase.inc = new IncrementalText(wrap);
					phase.inc.append(phase.text || "");
				}
				return phase.inc.rows(phaseWidth);
			};
			for (const phase of state.stream) {
				if (phase.kind === "thinking") {
					const elapsed = phase.startAt ? formatDuration((Date.now() - phase.startAt) / 1000, locale) : "";
					pushTailSegment([`  ${color.muted("◆")} ${bold(color.muted(t("status.thought")))}${elapsed ? color.dim(` · ${elapsed}`) : ""}`], (line) => line);
					pushTailSegment(phaseRows(phase, Math.max(4, inner - 6)), (line) => `    ${color.muted(line || " ")}`);
				} else if (phase.kind === "text") {
					pushTailSegment(phaseRows(phase, Math.max(4, inner - 2)), (line) => `  ${color.text(line || " ")}`);
				} else if (phase.kind === "tool") {
					appendTailTool(phase.id, state.liveTools.get(phase.id)?.name || phase.label);
				}
			}
			if (state.working && !state.stream.length) {
				const elapsed = state.runWorkSince ? formatDuration((Date.now() - state.runWorkSince) / 1000, locale) : "";
				pushTailSegment([`  ${color.muted("◆")} ${bold(color.muted(t("status.working")))}${elapsed ? color.dim(` · ${elapsed}`) : ""}`], (line) => line);
			}
			const base = cache.total;
			const toolRanges = tailRanges.length
				? cache.toolRanges.concat(tailRanges.map((range) => ({ id: range.id, start: range.start + base, end: range.end + base })))
				: cache.toolRanges;
			return {
				history: cache,
				tail: tailSegments,
				tailLength,
				total: base + tailLength,
				blocks: cache.blocks,
				userBlocks: cache.userBlocks,
				blockIndex: cache.blockIndex,
				toolRanges,
			};
		}

		// Render one message's rows. The history cache decides whether this runs.
		#renderMessageSegment(cache, index, inner, width) {
			const message = state.messages[index];
			if (!message) return;
			if (message.role === "user" && index === cache.omitUserIndex) return;
			const lines = [];
			const localToolRanges = [];
			let block;
			const isLastAssistant = index === cache.lastAssistantIndex;
			if (message.role === "user") {
				block = { kind: "user", messageIndex: index, message, start: 0, end: 0, replied: false };
				const prompt = clean(textOfContent(message.content)).trim();
				for (const row of this.#bandRow(width, prompt, message.timestamp, message)) lines.push(row);
				lines.push("");
			} else if (message.role === "assistant") {
				block = { kind: "assistant", messageIndex: index, message, start: 0, end: 0 };
				const timeText = message.timestamp != null ? ` ${formatTime(message.timestamp, locale)}` : "";
				const timeWidth = visibleWidth(timeText);
				let thoughtHeaderPushed = false;
				let firstTextRow = true;
				for (const part of Array.isArray(message.content) ? message.content : []) {
					if (!part) continue;
					if (part.type === "thinking") {
						if (!thoughtHeaderPushed) {
							thoughtHeaderPushed = true;
							const thoughtSecond = isLastAssistant && state.lastThoughtMs != null && state.lastThoughtMs > 0
								? formatDuration(state.lastThoughtMs / 1000, locale) : "";
							lines.push(`  ${color.muted("◆")} ${bold(color.muted(t("status.thought")))}${thoughtSecond ? color.muted(` ${t("status.thoughtFor", { duration: thoughtSecond })}`) : ""}`);
						}
						if (!(part.thinking || "").trim()) continue;
						if (!state.thinkingAutoCollapse || state.thinkingExpanded.has(index)) {
							for (const line of wrapCached(part, "thinking", part.thinking, Math.max(4, inner - 6))) lines.push(`    ${color.muted(line || " ")}`);
						} else lines.push(`    ${color.dim(t("status.thinkingCollapsed"))}`);
				} else if (part.type === "text") {
					if (!(part.text || "").trim()) continue;
					const allowTime = firstTextRow && timeWidth > 0;
					const wrapWidth = allowTime ? Math.max(4, inner - timeWidth - 4) : Math.max(4, inner - 2);
					const { rows: textLines, sgr: textSgr } = textRows(part, "text", part.text, wrapWidth);
					for (const line of textLines) {
						let row = `  ${textSgr ? (line || " ") : color.text(line || " ")}`;
						if (allowTime && firstTextRow) {
							firstTextRow = false;
							row = pad(row, Math.max(1, width - timeWidth)) + timeText;
						}
						lines.push(row);
					}
				} else if (part.type === "toolCall" && part.name !== "todo") {
						const id = part.id || part.toolCallId;
						const toolResult = cache.toolResults.get(id);
						let tool = state.liveTools.get(id);
						if (!tool) {
							tool = new LiveTool(id);
							tool.update({ type: toolResult ? "tool_execution_end" : "tool_execution_start", toolName: part.name, args: part.arguments || {}, result: toolResult, isError: toolResult?.isError });
							state.liveTools.set(id, tool);
						}
						const start = lines.length;
						lines.push(...renderToolRows(tool, part.name, inner));
						localToolRanges.push({ id, start, end: lines.length });
					}
				}
				const turnError = assistantErrorMessage(message);
				if (turnError) {
					const label = t("status.turnFailed");
					for (const [index, line] of wrapCached(message, "turnError", `${label}: ${turnError}`, Math.max(4, inner - 4)).entries()) {
						lines.push(`  ${color.error(`${index === 0 ? "⚠ " : "  "}${line || " "}`)}`);
					}
				}
				if (isLastAssistant && state.lastWorkMs != null && state.lastWorkMs > 0) {
					lines.push(`  ${color.muted(t("status.workedFor", { duration: formatDuration(state.lastWorkMs / 1000, locale) }))}`);
				}
				lines.push("");
			} else if (message.role === "custom" && message.display !== false) {
				for (const line of wrapCached(message, "custom", `✦ ${textOfContent(message.content)}`, inner)) lines.push(`  ${color.warning(line)}`);
			} else if (message.role === "bashExecution") {
				const output = message.output ? wrapCached(message, "bashOut", message.output, Math.max(4, inner - 6)) : [];
				const visible = output.slice(-20).map((line) => color.muted(line || " "));
				if (output.length > visible.length) visible.unshift(color.dim(`… ${output.length - visible.length} earlier lines`));
				lines.push(...renderOutputBlock({
					header: `$ ${message.command || ""}`,
					state: Number(message.exitCode) ? "error" : "done",
					sections: [{ lines: visible }],
					width: Math.max(8, inner - 2),
				}).map((line) => `  ${line}`));
				lines.push("");
			} else if (message.role === "compactionSummary") {
				lines.push(color.success(`  ✓ ${t("status.checkpointSaved")}`), "");
			} else {
				return;
			}
			return { lines, block, localToolRanges };
		}

		// Materialize only the requested window from the immutable per-message
		// segments plus the lazy live tail. This is the transcript equivalent of a
		// viewport blit: the cost is the viewport height, never the session length.
		#flowSlice(flow, start, end) {
			return sliceFlow(flow.history.segments, flow.tail, flow.history.total, start, end);
		}

		// Blocks are ordered by their start row, so scroll anchoring and the active
		// timeline turn are found with a binary search instead of an O(session) scan.
		#blockContaining(blocks, index) {
			let low = 0, high = blocks.length - 1, found;
			while (low <= high) {
				const mid = (low + high) >> 1;
				if (blocks[mid].start > index) high = mid - 1;
				else { found = blocks[mid]; low = mid + 1; }
			}
			return found && index < Math.max(found.end, found.start + 1) ? found : undefined;
		}

		#lastBlockIndexStartingAtOrBefore(blocks, index) {
			let low = 0, high = blocks.length - 1, found = -1;
			while (low <= high) {
				const mid = (low + high) >> 1;
				if (blocks[mid].start <= index) { found = mid; low = mid + 1; }
				else high = mid - 1;
			}
			return found;
		}

		#panelRow(value, width, surface = "panel") {
			const line = pad(value, Math.max(1, width));
			if (surface === "hover") return panelHoverBackground(line);
			if (surface === "tool") return toolBackground(line);
			return panelBackground(line);
		}

		#installPanelScrollbar(panel, lines, {
			width, originX, originY, panelHeight, contentTop, total, viewport, scroll,
		}) {
			const view = panelWindow(total, viewport, scroll);
			const metrics = scrollbarMetrics({
				contentLength: total,
				viewportLength: viewport,
				offset: view.maxScroll - view.start,
				trackLength: viewport,
				minThumbLength: state.touchMode ? 4 : 2,
			});
			const bar = {
				panel,
				originX,
				originY,
				panelWidth: width,
				panelHeight,
				x: originX + width - 1,
				y: originY + contentTop,
				height: viewport,
				metrics,
				maxScroll: view.maxScroll,
			};
			state.panelScrollbars.set(panel, bar);
			if (viewport > 0 && width > 1 && metrics.overflow) {
				for (let row = 0; row < viewport && contentTop + row < panelHeight; row++) {
					const thumb = row >= metrics.thumbStart && row < metrics.thumbStart + metrics.thumbLength;
					lines[contentTop + row] = compositeTuiLine(
						lines[contentTop + row] || this.#panelRow("", width),
						thumb ? color.accent("┃") : color.dim("│"),
						width - 1,
						1,
						width,
					);
				}
				state.mouseZones.push({
					key: `scrollbar:${panel}`,
					x: bar.x,
					y: bar.y,
					width: 1,
					height: bar.height,
					action: "panel-scrollbar",
					panel,
				});
			}
			return view;
		}

		#fileVisual(width) {
			const key = `${width}|${tree.revision}|${locale}`;
			if (this.fileVisualCache?.key === key) return this.fileVisualCache.rows;
			const rows = tree.rows.map((item) => {
				const indent = item.depth > 0 ? color.dim("│ ".repeat(Math.min(5, item.depth))) : "";
				const marker = item.dir ? (tree.expanded.has(item.rel) ? "▾" : "▸") : "·";
				const name = item.dir ? color.text(item.name) : color.muted(item.name);
				return { item, key: `file:${item.rel}`, text: `  ${indent}${color.dim(marker)} ${name}` };
			});
			this.fileVisualCache = { key, rows };
			return rows;
		}

		#leftPanel(width, height, originX = 0, originY = 0) {
			const lines = [];
			const close = "[×]";
			const title = `  ${bold(color.text(t("panel.files")))}`;
			const titleGap = Math.max(1, width - visibleWidth(title) - visibleWidth(close) - 1);
			lines.push(this.#panelRow(`${title}${" ".repeat(titleGap)}${color.dim(close)} `, width));
			lines.push(this.#panelRow(`  ${color.accent("◇")} ${color.muted(tree.label)} ${color.dim("· Ctrl+B")}`, width));
			lines.push(this.#panelRow("", width));
			state.mouseZones.push({
				key: "files:close",
				x: originX + Math.max(0, width - 5),
				y: originY,
				width: 4,
				height: 1,
				action: "hide-files",
			});

			const visual = this.#fileVisual(width);
			const contentTop = lines.length;
			const viewport = Math.max(0, height - contentTop);
			const view = panelWindow(visual.length, viewport, state.fileScroll);
			state.fileScroll = view.start;
			for (let index = view.start; index < view.end; index++) {
				const row = visual[index];
				const surface = state.hoveredZoneKey === row.key ? "hover" : "panel";
				lines.push(this.#panelRow(row.text, width, surface));
				state.mouseZones.push({
					key: row.key,
					x: originX + 1,
					y: originY + contentTop + index - view.start,
					width: Math.max(1, width - 2),
					height: 1,
					action: "file",
					panel: "files",
					item: row.item,
				});
			}
			while (lines.length < height) lines.push(this.#panelRow("", width));
			this.#installPanelScrollbar("files", lines, {
				width,
				originX,
				originY,
				panelHeight: height,
				contentTop,
				total: visual.length,
				viewport,
				scroll: state.fileScroll,
			});
			return lines.slice(0, height);
		}

		#workflowItemRows(item, width, now) {
			const contentWidth = Math.max(8, width - 6);
			const expanded = state.workflowExpanded.has(item.id);
			const elapsedMs = item.status === "running" && item.startedAt
				? now - item.startedAt
				: item.endedAt && item.startedAt ? item.endedAt - item.startedAt : undefined;
			const elapsedSec = elapsedMs != null && elapsedMs >= 0 ? Math.floor(elapsedMs / 1000) : -1;
			const spin = item.status === "running" ? spinnerFrame % SPINNER.length : 0;
			const key = `${width}|${expanded ? 1 : 0}|${item.revision || 0}|${item.status}|${elapsedSec}|${spin}|${locale}`;
			if (item.visualCache?.key === key) return item.visualCache.rows;
			const output = clean(item.output || item.error || "");
			const wrappedOutput = output ? wrapCached(item, "output", output, contentWidth) : [];
			let collapsed;
			if (item.collapsedCache && item.collapsedCache.source === wrappedOutput) {
				collapsed = item.collapsedCache;
			} else {
				collapsed = collapseToolOutput(wrappedOutput.join("\n"), 10, 10 * contentWidth);
				item.collapsedCache = { source: wrappedOutput, lines: collapsed.lines, overflow: collapsed.overflow };
			}
			const hasDetails = Boolean(item.summary || wrappedOutput.length);
			const zone = `workflow:${item.id}`;
			const rows = [{ text: "", surface: "panel" }];
			const icon = item.status === "running"
				? color.warning(SPINNER[spin])
				: item.status === "error" ? color.error("×") : color.success("✓");
			const elapsed = elapsedSec >= 0 ? formatDuration(elapsedSec, locale) : "";
			const titleWidth = Math.max(4, contentWidth - visibleWidth(elapsed) - 2);
			const titleText = truncateToWidth(item.label || item.name, titleWidth, "…");
			rows.push({
				key: zone,
				itemId: item.id,
				action: hasDetails ? "workflow-toggle" : undefined,
				surface: "tool",
				text: `${color.dim("▏")}  ${icon} ${color.muted("#")} ${color.text(titleText)}${elapsed ? color.dim(` · ${elapsed}`) : ""}`,
			});
			if (expanded) {
				if (item.summary && !String(item.label || "").includes(item.summary)) {
					for (const line of wrapCached(item, "summary", item.summary, contentWidth).slice(0, 3)) {
						rows.push({ key: zone, itemId: item.id, action: "workflow-toggle", surface: "tool", text: `${color.dim("▏")}     ${color.muted(line)}` });
					}
				}
				for (const line of collapsed.lines) {
					const painter = item.status === "error" ? color.error : color.muted;
					rows.push({ key: zone, itemId: item.id, action: "workflow-toggle", surface: "tool", text: `${color.dim("▏")}     ${painter(line || " ")}` });
				}
				if (collapsed.overflow) {
					rows.push({ key: zone, itemId: item.id, action: "workflow-toggle", surface: "tool", text: `${color.dim("▏")}     ${color.accent(`▴ ${t("panel.collapse")}`)}` });
				}
			} else if (hasDetails) {
				const preview = item.summary || wrappedOutput[0] || "";
				rows.push({
					key: zone,
					itemId: item.id,
					action: "workflow-toggle",
					surface: "tool",
					text: `${color.dim("▏")}     ${color.muted(truncateToWidth(preview, contentWidth, "…"))}`,
				});
				if (wrappedOutput.length > 1) {
					rows.push({ key: zone, itemId: item.id, action: "workflow-toggle", surface: "tool", text: `${color.dim("▏")}     ${color.accent(`▾ ${t("panel.expand")}`)}` });
				}
			}
			rows.push({ key: zone, itemId: item.id, action: hasDetails ? "workflow-toggle" : undefined, text: color.dim("▏"), surface: "tool" });
			item.visualCache = { key, rows };
			return rows;
		}

		#workflowVisualRows(width) {
			const rows = [];
			if (!state.workflow.length) {
				rows.push({ text: `  ${color.dim(t("panel.noToolActivity"))}`, surface: "panel" });
			}
			const now = Date.now();
			for (const item of state.workflow) rows.push(...this.#workflowItemRows(item, width, now));
			if (state.tools.available.length > 0) {
				const enabled = state.tools.available.filter((name) => !state.tools.disabled.includes(name)).length;
				rows.push({ text: "", surface: "panel" });
				rows.push({
					text: `  ${bold(color.text(t("panel.tools")))} ${color.muted(t("toast.toolsCount", { enabled: formatNumber(enabled, locale), total: formatNumber(state.tools.available.length, locale) }))} ${color.dim("· /tools")}`,
					surface: "panel",
				});
			}
			if (state.activeAgent) {
				rows.push({ text: "", surface: "panel" });
				rows.push({ text: `  ${bold(color.text("AGENT"))} ${color.accent(state.activeAgent.name)} ${color.dim(`· ${state.activeAgent.thinking}`)}`, surface: "panel" });
			}
			if (state.team) {
				rows.push({ text: "", surface: "panel" });
				rows.push({ text: `  ${bold(color.text("AGENT TEAM"))} ${color.dim(`${state.team.collaborationMode || "peer"} · ${state.team.phase || "stopped"} · /team`)}`, surface: "panel" });
				for (const member of state.team.members || []) {
					const job = state.teamJobs.get(member.jobId);
					const status = job?.endedAt ? job.status : job?.activity || member.status || "waiting";
					const icon = ["running", "queued"].includes(status) ? color.warning("◆")
						: status === "working" ? color.success("●")
						: status === "thinking" ? color.accent("◉")
						: status === "waiting" ? color.dim("○")
						: status === "done" ? color.success("✓")
						: status === "cancelled" ? color.dim("−") : color.error("×");
					const detail = status === "error" && member.error ? ` · ${member.error}` : "";
					rows.push({ text: `  ${icon} ${agentColor(member.id)(member.name)} ${color.dim(`${member.role || "peer"} · ${status}${member.isolation ? ` · ${member.isolation}` : ""}${detail}`)}`, surface: "panel" });
				}
				for (const message of (state.team.messages || []).slice(-8)) {
					const fromId = message.from?.memberId || "agent";
					const from = message.from?.name || fromId;
					const target = message.to ? (state.team.members || []).find((item) => item.id === message.to)?.name || message.to : "team";
					rows.push({ text: `  ${agentColor(fromId)(`%${from} -> ${target}`)}`, surface: "panel" });
					rows.push({ text: `    ${color.muted(truncateToWidth(message.text || "", Math.max(8, width - 6), "…"))}`, surface: "panel" });
				}
				for (const assignment of (state.team.assignments || []).slice(-5)) {
					const from = (state.team.members || []).find((item) => item.id === assignment.from);
					const to = (state.team.members || []).find((item) => item.id === assignment.to);
					rows.push({ text: `  ${agentColor(assignment.from)(`%${from?.name || assignment.from} -> ${to?.name || assignment.to}`)}`, surface: "panel" });
					rows.push({ text: `    ${color.text(truncateToWidth(assignment.objective || "", Math.max(8, width - 6), "…"))}`, surface: "panel" });
				}
				for (const report of (state.team.reports || []).slice(-5)) {
					const member = (state.team.members || []).find((item) => item.id === report.memberId);
					rows.push({ text: `  ${agentColor(report.memberId)(member?.name || report.memberId)} ${color.dim("reported")}`, surface: "panel" });
					rows.push({ text: `    ${color.muted(truncateToWidth(report.text || "", Math.max(8, width - 6), "…"))}`, surface: "panel" });
				}
			}
			for (const [key, status] of state.statuses) {
				if (["tsukuyomi-mode", "tsukuyomi-compact", "tsukuyomi-agent", "tsukuyomi-team"].includes(key)) continue;
				rows.push({ text: `  ${color.dim(key)} ${color.muted(status)}`, surface: "panel" });
			}
			for (const widgetLines of state.widgets.values()) {
				for (const line of widgetLines) rows.push({ text: `  ${color.muted(clean(line))}`, surface: "panel" });
			}
			return rows;
		}

		#workflowPanel(width, height, originX = 0, originY = 0) {
			const lines = [];
			const running = state.workflow.filter((item) => item.status === "running").length;
			const close = "[×]";
			const title = `  ${bold(color.text(t("panel.workflow")))}`;
			const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(close) - 1);
			lines.push(this.#panelRow(`${title}${" ".repeat(gap)}${color.dim(close)} `, width));
			const count = formatNumber(state.workflow.length, locale);
			const status = running ? color.warning(`${formatNumber(running, locale)} ${t("panel.running")}`) : color.muted(`${count} ${t("panel.events")}`);
			lines.push(this.#panelRow(`  ${status}${state.keybindingPreset === "legacy" ? ` ${color.dim("· Ctrl+O")}` : ""}`, width));
			state.mouseZones.push({
				key: "workflow:close",
				x: originX + Math.max(0, width - 5),
				y: originY,
				width: 4,
				height: 1,
				action: "hide-workflow",
			});

			const contentTop = lines.length;
			const viewport = Math.max(0, height - contentTop);
			const visual = this.#workflowVisualRows(width);
			const tail = Math.max(0, visual.length - viewport);
			if (state.workflowFollowTail) state.workflowScroll = tail;
			const view = panelWindow(visual.length, viewport, state.workflowScroll);
			state.workflowScroll = view.start;
			for (let index = view.start; index < view.end; index++) {
				const row = visual[index];
				const hovered = row.key && state.hoveredZoneKey === row.key;
				lines.push(this.#panelRow(row.text || "", width, hovered ? "hover" : row.surface));
				if (row.action) {
					state.mouseZones.push({
						key: row.key,
						x: originX,
						y: originY + contentTop + index - view.start,
						width: Math.max(1, width - 1),
						height: 1,
						action: row.action,
						panel: "workflow",
						itemId: row.itemId,
					});
				}
			}
			while (lines.length < height) lines.push(this.#panelRow("", width));
			this.#installPanelScrollbar("workflow", lines, {
				width,
				originX,
				originY,
				panelHeight: height,
				contentTop,
				total: visual.length,
				viewport,
				scroll: state.workflowScroll,
			});
			return lines.slice(0, height);
		}

		#todoPanel(width, height, originX = 0, originY = 0) {
			const lines = [];
			const close = "[×]";
			const title = `  ${bold(color.text(t("panel.todo")))}`;
			const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(close) - 1);
			lines.push(this.#panelRow(`${title}${" ".repeat(gap)}${color.dim(close)} `, width));
			const done = state.todos.filter((item) => item.done).length;
			const summary = state.todos.length
				? t("status.tasksComplete", { done: formatNumber(done, locale), total: formatNumber(state.todos.length, locale) })
				: t("panel.noTodos");
			lines.push(this.#panelRow(`  ${color.muted(summary)}${state.keybindingPreset === "legacy" ? ` ${color.dim("· Ctrl+T")}` : ""}`, width));
			state.mouseZones.push({
				key: "todo:close",
				x: originX + Math.max(0, width - 5),
				y: originY,
				width: 4,
				height: 1,
				action: "hide-todos",
			});

			const fingerprint = state.todos.map((todo) => `${todo.id ?? ""}:${todo.done ? 1 : 0}:${todo.text || ""}`).join("\n");
			const visualKey = `${width}|${state.working ? 1 : 0}|${locale}|${fingerprint}`;
			let visual = this.todoVisualCache?.key === visualKey ? this.todoVisualCache.rows : undefined;
			if (!visual) {
				visual = [];
				const contentWidth = Math.max(4, width - 7);
				for (const todo of todoStatuses(state.todos, state.working)) {
					const marker = todo.status === "completed" ? "[✓]" : todo.status === "in_progress" ? "[•]" : "[ ]";
					const painter = todo.status === "in_progress" ? color.warning : color.muted;
					const wrapped = wrapCached(todo, "todo", todo.text || t("panel.task"), contentWidth);
					for (let index = 0; index < wrapped.length; index++) {
						visual.push({
							key: `todo:${todo.id}`,
							text: index === 0 ? `  ${painter(marker)} ${painter(wrapped[index] || " ")}` : `      ${painter(wrapped[index] || " ")}`,
						});
					}
				}
				this.todoVisualCache = { key: visualKey, rows: visual };
			}
			const contentTop = lines.length;
			const viewport = Math.max(0, height - contentTop);
			const view = panelWindow(visual.length, viewport, state.todoScroll);
			state.todoScroll = view.start;
			for (let index = view.start; index < view.end; index++) {
				const row = visual[index];
				lines.push(this.#panelRow(row.text, width, state.hoveredZoneKey === row.key ? "hover" : "panel"));
				state.mouseZones.push({
					key: row.key,
					x: originX,
					y: originY + contentTop + index - view.start,
					width: Math.max(1, width - 1),
					height: 1,
					action: "panel-body",
					panel: "todo",
				});
			}
			while (lines.length < height) lines.push(this.#panelRow("", width));
			this.#installPanelScrollbar("todo", lines, {
				width,
				originX,
				originY,
				panelHeight: height,
				contentTop,
				total: visual.length,
				viewport,
				scroll: state.todoScroll,
			});
			return lines.slice(0, height);
		}

		#contextPanel(width, height) {
			if (height <= 0) return [];
			const modelId = state.model?.id || t("status.noModel");
			const provider = state.model?.provider || "—";
			const percent = Math.max(0, Math.min(100, Number(state.contextPercent) || 0));
			const cacheKey = `${width}|${height}|${percent}|${state.contextTokens ?? ""}|${provider}|${modelId}|${state.mode}|${state.thinking}|${locale}`;
			if (this.contextVisualCache?.key === cacheKey) return this.contextVisualCache.rows;
			const barWidth = Math.max(4, width - 9);
			const filled = Math.round(barWidth * percent / 100);
			const rows = [
				this.#panelRow(`  ${bold(color.text(t("status.context")))}`, width),
				this.#panelRow(`  ${color.accent("━".repeat(filled))}${color.dim("─".repeat(Math.max(0, barWidth - filled)))} ${color.muted(`${formatPercent(percent, locale)}%`)}`, width),
				this.#panelRow(`  ${color.muted(provider)}${color.dim("/")}${color.text(modelId)}`, width),
				this.#panelRow(`  ${color.dim(`${t(`mode.${state.mode}`)} · ${state.thinking}`)}`, width),
			];
			while (rows.length < height) rows.push(this.#panelRow("", width));
			const sliced = rows.slice(0, height);
			this.contextVisualCache = { key: cacheKey, rows: sliced };
			return sliced;
		}

		#rightPanel(width, height, originX = 0, originY = 0) {
			const contextHeight = height >= 12 ? 5 : Math.min(2, height);
			const context = this.#contextPanel(width, contextHeight);
			const remaining = Math.max(0, height - contextHeight);
			if (!remaining) return context;
			if (state.showWorkflow && state.showTodos) {
				if (remaining < 4) return [...context, ...this.#workflowPanel(width, remaining, originX, originY + contextHeight)];
				const workflowHeight = Math.max(2, Math.min(remaining - 2, Math.floor(remaining * 0.58)));
				const todoHeight = remaining - workflowHeight;
				return [
					...context,
					...this.#workflowPanel(width, workflowHeight, originX, originY + contextHeight),
					...this.#todoPanel(width, todoHeight, originX, originY + contextHeight + workflowHeight),
				].slice(0, height);
			}
			if (state.showWorkflow) return [...context, ...this.#workflowPanel(width, remaining, originX, originY + contextHeight)];
			return [...context, ...this.#todoPanel(width, remaining, originX, originY + contextHeight)];
		}

		#drawSessions(screen, width, height, dialog) {
			const next = Array.from({ length: height }, () => pad("", width));
			const filtered = filterSessionCatalog(dialog.items, { query: dialog.query, workspace: cwd, currentOnly: dialog.currentOnly });
			dialog.visibleItems = filtered;
			dialog.selected = Math.max(0, Math.min(filtered.length - 1, dialog.selected || 0));
			dialog.mouseRows = [];
			const top = height >= 14 ? 2 : 0;
			const bottom = height - 1;
			const innerWidth = Math.max(1, width - 2);
			const framed = (value = "") => `${color.border("│")}${pad(value, innerWidth)}${BLACK_BACKGROUND}${color.border("│")}`;
			if (top > 0) next[0] = ` ${color.dim(compactPath(cwd))}`;
			next[top] = color.border(`╭${"─".repeat(innerWidth)}╮`);
			if (top + 1 < height) {
				const title = `  ${bold(color.text(t("dialog.sessions")))}`;
				const close = color.dim("[×]");
				const gap = " ".repeat(Math.max(1, innerWidth - visibleWidth(title) - visibleWidth(close) - 1));
				next[top + 1] = framed(`${title}${gap}${close} `);
			}
			if (top + 2 < height) next[top + 2] = color.border(`├${"─".repeat(innerWidth)}┤`);
			if (top + 3 < height) {
				const query = dialog.query ? color.text(dialog.query) : color.dim(t("session.search"));
				const scope = dialog.currentOnly ? t("session.currentWorkspace") : t("session.allWorkspaces");
				const lead = `  / ${query}`;
				const gap = " ".repeat(Math.max(1, innerWidth - visibleWidth(lead) - visibleWidth(scope) - 2));
				next[top + 3] = framed(`${lead}${gap}${color.muted(scope)} `);
			}
			if (top + 4 < height) next[top + 4] = color.border(`├${"─".repeat(innerWidth)}┤`);
			const footerY = Math.max(top + 5, bottom - 2);
			const contentStart = top + 5;
			const available = Math.max(0, footerY - contentStart);
			const logical = [];
			let group;
			for (let index = 0; index < filtered.length; index++) {
				const item = filtered[index];
				const label = compactPath(item.cwd);
				if (label !== group) { group = label; logical.push({ type: "group", label }); }
				logical.push({ type: "item", item, index });
			}
			const selectedLogical = Math.max(0, logical.findIndex((row) => row.type === "item" && row.index === dialog.selected));
			let start = Math.max(0, Math.min(Math.max(0, logical.length - available), selectedLogical - Math.floor(available / 2)));
			for (let row = 0; row < available && start + row < logical.length; row++) {
				const entry = logical[start + row]; const y = contentStart + row;
				if (entry.type === "group") {
					const lead = `  ${bold(color.muted(entry.label))} `;
					next[y] = framed(`${lead}${color.border("─".repeat(Math.max(0, innerWidth - visibleWidth(lead))))}`);
					continue;
				}
				const selected = entry.index === dialog.selected;
				const current = entry.item.path === state.sessionFile ? ` · ${t("status.current")}` : "";
				const right = `${formatAgo(entry.item.mtime, locale)}${current}`;
				const left = `${selected ? "❯" : " "} ${entry.item.name || t("session.empty")}  ${color.dim(entry.item.id)}`;
				const leftShown = truncateToWidth(left, Math.max(4, innerWidth - visibleWidth(right) - 3), "…");
				const line = `${leftShown}${" ".repeat(Math.max(1, innerWidth - visibleWidth(leftShown) - visibleWidth(right) - 1))}${color.dim(right)}`;
				next[y] = framed(selected ? listSelection(pad(line, innerWidth)) : pad(line, innerWidth));
				dialog.mouseRows.push({ y, index: entry.index });
			}
			for (let y = contentStart; y < footerY; y++) if (!next[y].includes("│")) next[y] = framed("");
			if (!filtered.length && available) next[contentStart] = framed(pad(color.dim(t("session.noMatch")), innerWidth, "center"));
			if (footerY < height) next[footerY] = color.border(`├${"─".repeat(innerWidth)}┤`);
			if (footerY + 1 < height) next[footerY + 1] = framed(` ${this.#shortcutHint(t("session.footer"))}`);
			if (bottom < height) next[bottom] = color.border(`╰${"─".repeat(innerWidth)}╯`);
			dialog.mouseClose = { x: Math.max(0, width - 7), y: top + 1, width: 5, height: 1 };
			dialog.mouseBox = { x: 0, y: top, width, height: bottom - top + 1 };
			return next;
		}

		#drawSettings(screen, width, height, dialog) {
			const next = Array.from({ length: height }, () => menuBackground(" ".repeat(width)));
			const tabs = settingsGroups();
			const active = Math.max(0, Math.min(tabs.length - 1, dialog.activeTab || 0));
			const title = `  ${bold(color.accent(dialog.title || t("settings.title")))}`;
			const close = color.dim("[×]");
			next[0] = menuBackground(pad(`${title}${" ".repeat(Math.max(1, width - visibleWidth(title) - visibleWidth(close) - 1))}${close} `, width));
			dialog.mouseTabs = [];
			let first = Math.max(0, active - 2);
			let tabText = " ";
			for (let index = first; index < tabs.length; index++) {
				const label = tabs[index].header;
				const cell = ` ${label} `;
				if (visibleWidth(tabText) + visibleWidth(cell) >= width - 2) break;
				const x = visibleWidth(tabText);
				dialog.mouseTabs.push({ x, width: visibleWidth(cell), index });
				tabText += index === active ? listSelection(bold(color.text(cell))) : color.muted(cell);
			}
			if (height > 1) next[1] = menuBackground(pad(tabText, width));
			if (height > 3) next[3] = menuBackground(`  ${bold(color.text(tabs[active]?.header || ""))}`);
			const leftWidth = Math.max(16, Math.min(28, Math.floor(width * 0.25)));
			const rows = dialog.settingsRows || [];
			const firstRow = Math.max(0, Math.min(Math.max(0, rows.length - Math.max(1, height - 7)), (dialog.selected || 0) - Math.floor(Math.max(1, height - 7) / 2)));
			dialog.mouseRows = [];
			for (let offset = 0; offset < height - 7 && firstRow + offset < rows.length; offset++) {
				const item = rows[firstRow + offset].item;
				if (!item) continue;
				const y = 5 + offset;
				const selected = item.index === dialog.selected;
				const marker = item.toggle ? (item.detail === t("settings.on") ? "◉" : "○") : "›";
				const left = truncateToWidth(`${selected ? "❯" : " "} ${marker} ${item.label}`, leftWidth - 2, "…");
				const right = truncateToWidth(item.detail || "", Math.max(1, width - leftWidth - 4), "…");
				const line = pad(` ${pad(left, leftWidth - 1)} ${color.dim(right)}`, width);
				next[y] = selected ? listSelection(line) : menuBackground(line);
				dialog.mouseRows.push({ y, index: item.index });
			}
			if (height > 2) next[height - 2] = menuBackground(`  ${color.dim("←/→ or Tab: sections · ↑/↓: options · Enter: change · Esc: close")}`);
			dialog.mouseClose = { x: Math.max(0, width - 6), y: 0, width: 5, height: 1 };
			dialog.mouseBox = { x: 0, y: 0, width, height };
			return next;
		}

		#drawProviderSetup(width, height, dialog) {
			const next = Array.from({ length: height }, () => blackBackground(" ".repeat(width)));
			const baseRow = (value = "") => blackBackground(pad(value, width));
			const tabs = dialog.setupTabs || [];
			const compact = height < 25 || width < 72;
			let cursorY = 0;
			if (height >= 15 && width >= 12) {
				for (let index = 0; index < TSUKUYOMI_LOGO.length && cursorY < height; index++) {
					next[cursorY++] = baseRow(pad(paintLogoRow(TSUKUYOMI_LOGO[index], index), width, "center"));
				}
				if (cursorY < height) next[cursorY++] = baseRow(pad(color.accent("Tsukuyomi"), width, "center"));
				if (cursorY < height) next[cursorY++] = baseRow(pad(color.dim("Setup step 1 of 1"), width, "center"));
				cursorY += compact ? 1 : 2;
			}
			const headingY = Math.min(height - 1, cursorY++);
			next[headingY] = baseRow(`  ${bold(color.accent(locale === "zh" ? "设置供应商" : "Set up your providers"))}`);
			if (cursorY < height) next[cursorY++] = baseRow(`  ${color.muted(locale === "zh" ? "登录模型供应商，或选择网页搜索服务。按 Esc 完成。" : "Sign in and pick a web search provider. Press Esc when you're done.")}`);
			cursorY++;
			const tabY = cursorY++;
			let tabX = 2 + visibleWidth(locale === "zh" ? "供应商:" : "Providers:") + 2;
			dialog.setupMouseTabs = [];
			const tabParts = [color.accent(locale === "zh" ? "供应商:" : "Providers:")];
			for (let index = 0; index < tabs.length; index++) {
				const label = tabs[index].label;
				const part = index === (dialog.setupTab || 0) ? listSelection(` ${label} `) : ` ${color.muted(label)} `;
				dialog.setupMouseTabs.push({ index, x: tabX, y: tabY, width: visibleWidth(part) });
				tabParts.push(part);
				tabX += visibleWidth(part) + 2;
			}
			tabParts.push(color.dim(locale === "zh" ? "（Tab 切换）" : "(tab to cycle)"));
			next[tabY] = baseRow(`  ${tabParts.join("  ")}`);
			const helpY = Math.min(height - 1, cursorY++);
			next[helpY] = baseRow(`  ${color.muted(dialog.setupTab === 1 ? (locale === "zh" ? "选择 web_search 工具优先使用的供应商。" : "Choose the provider preferred by the web_search tool.") : (locale === "zh" ? "选择供应商以登录并选择模型；也可以添加自定义供应商。" : "Pick a provider to sign in; you can connect more than one."))}`);
			cursorY++;
			const listLabelY = Math.min(height - 1, cursorY++);
			next[listLabelY] = baseRow(`  ${color.secondary(dialog.setupTab === 1 ? (locale === "zh" ? "选择搜索服务" : "Select web search provider") : (locale === "zh" ? "选择供应商登录" : "Select provider to login"))}`);
			const listTop = Math.min(height - 1, cursorY++);
			const listBottom = Math.max(listTop, height - (compact ? 1 : 3));
			const availableRows = Math.max(1, listBottom - listTop);
			const options = dialog.options || [];
			const selected = Math.max(0, Math.min(options.length - 1, dialog.selected || 0));
			dialog.setupPageSize = availableRows;
			// Section headings consume terminal rows too. Anchor the viewport to
			// the selected rendered row, rather than pretending every option is one
			// row tall (which could hide the last providers behind those headings).
			const selectedDescription = dialog.setupTab === 1 ? dialog.descriptions?.get(options[selected]) : undefined;
			const rowEntries = providerListWindow({ options, sections: dialog.sections, selectedIndex: selected, rowCount: availableRows, selectedDescription });
			dialog.mouseRows = [];
			let rowY = listTop;
			for (const entry of rowEntries) {
				if (rowY >= listBottom) break;
				if (entry.kind === "option") {
					const chosen = entry.index === selected;
					const marker = chosen ? color.accent("❯") : " ";
					const label = truncateToWidth(entry.value, Math.max(1, width - 8), "…");
					const line = `${marker} ${label}`;
					next[rowY] = chosen ? blackBackground(`  ${listSelection(pad(line, width - 4))}  `) : baseRow(`  ${color.text(line)}`);
					dialog.mouseRows.push({ y: rowY, index: entry.index });
				} else if (entry.kind === "section") next[rowY] = baseRow(`  ${color.secondary(entry.section)}`);
				else if (entry.kind === "description") next[rowY] = baseRow(`    ${color.dim(entry.text)}`);
				rowY++;
			}
			dialog.mouseBox = { x: 0, y: 0, width, height };
			dialog.mouseClose = { x: Math.max(0, width - 5), y: 0, width: 4, height: 1 };
			const footer = locale === "zh"
				? "↑/↓移动 · PgUp/PgDn翻页 · Home/End首尾 · Enter确认 · Tab切换 · Esc退出"
				: "↑/↓ move · PgUp/Dn page · Home/End jump · Enter select · Tab switch · Esc close";
			if (height > 1) next[height - 1] = baseRow(`  ${truncateToWidth(color.dim(footer), Math.max(1, width - 2), "…")}`);
			return next;
		}

		#drawHub(screen, width, height, dialog) {
			const next = Array.from({ length: height }, () => menuBackground(" ".repeat(width)));
			const wide = width >= 94;
			const inspectorOnly = !wide && dialog.hubInspector;
			const leftWidth = inspectorOnly ? 0 : wide ? Math.max(38, Math.floor(width * 0.47)) : width;
			const detailWidth = inspectorOnly ? width : Math.max(1, width - leftWidth - 3);
			const row = (content) => menuBackground(pad(content, width));
			next[0] = row(` ${bold(color.title(dialog.title))}${" ".repeat(Math.max(1, width - visibleWidth(dialog.title) - 12))}${color.dim("[✗] Esc")}`);
			next[1] = row(` ${color.muted(`${dialog.options.length}/${dialog.allOptions.length} · ↑↓ · Enter · Tab ${wide ? "detail" : inspectorOnly ? "roster" : "inspector"} · PgUp/PgDn · Esc`)}`);
			next[2] = row(` ${color.accent("⌕")} ${color.text(dialog.query || (locale === "zh" ? "搜索成员、权限、任务…" : "Search members, permissions, jobs…"))}`);
			const count = Math.max(1, height - 5);
			const first = Math.max(0, Math.min(Math.max(0, dialog.options.length - count), dialog.selected - Math.floor(count / 2)));
			dialog.mouseRows = [];
			if (!inspectorOnly) {
				for (let index = first; index < Math.min(dialog.options.length, first + count); index++) {
					const y = 3 + index - first;
					const selected = index === dialog.selected;
					const label = truncateToWidth(dialog.options[index], Math.max(1, (leftWidth || width) - 4), "…");
					next[y] = row(` ${selected ? color.accent("❯") : " "} ${selected ? bold(color.text(label)) : color.muted(label)}`);
					dialog.mouseRows.push({ y, index });
				}
				if (!dialog.options.length) next[3] = row(` ${color.dim(t("dialog.noMatch"))}`);
			}
			const selectedOption = dialog.options[dialog.selected];
			const item = dialog.hubRows?.[dialog.hubOptions?.indexOf(selectedOption)];
			if (dialog.hubDetailKey !== item?.id) { dialog.hubDetailKey = item?.id; dialog.hubDetailOffset = 0; }
			if (wide || inspectorOnly) {
				const detail = item?.kind === "task" ? `${item.detail}\n${item.data?.output || item.data?.screen || ""}` : item?.kind === "report" ? `${item.detail}\n${item.data?.text || ""}` : item?.detail || "—";
				const safeDetail = String(detail).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "").slice(-6_000);
				const detailLines = wrap(safeDetail, Math.max(1, detailWidth - 2));
				const capacity = Math.max(1, height - 6);
				dialog.hubDetailMax = Math.max(0, detailLines.length - capacity);
				dialog.hubDetailOffset = Math.max(0, Math.min(dialog.hubDetailMax, dialog.hubDetailOffset || 0));
				const shown = detailLines.slice(dialog.hubDetailOffset, dialog.hubDetailOffset + capacity);
				const origin = inspectorOnly ? 0 : leftWidth;
				for (let y = 3; y < height - 2; y++) {
					const text = y === 3 ? bold(color.text(item?.title || "—")) : color.muted(shown[y - 4] || "");
					const pane = menuBackground(`${inspectorOnly ? " " : "│"} ${pad(text, Math.max(1, detailWidth - 2))}`);
					next[y] = inspectorOnly ? pane : compositeTuiLine(next[y], pane, origin, detailWidth, width);
				}
			}
			next[height - 2] = !wide && !inspectorOnly
				? row(` ${color.muted(truncateToWidth(item?.detail || "—", Math.max(1, width - 2), "…"))}`)
				: row(` ${color.dim("─".repeat(Math.max(1, width - 2)))}`);
			next[height - 1] = row(` ${color.dim(locale === "zh" ? "仅显示真实状态；操作会再次检查权限与任务状态" : "Live state only · actions recheck permissions and task status")}`);
			dialog.mouseClose = { x: Math.max(0, width - 10), y: 0, width: 9, height: 1 };
			dialog.mouseBox = { x: 0, y: 0, width, height };
			return next;
		}

		#paintOverlayRow(width, content) {
			return menuBackground(pad(content, width));
		}

		#drawPlanReview(width, height, dialog) {
			const session = dialog.planSession;
			const body = session ? session.sections.map((section) => [...section.lines, ...section.annotations.map((note) => `▎ note: ${note.note}`)].join("\n")).join("\n") : dialog.structured?.payload?.body || "";
			const model = layoutPlanReview({
				width, height, body,
				options: session?.options || dialog.options,
				selected: session?.selected || 0,
				focus: session?.focus || "actions",
				scroll: session?.scroll || 0,
				tocCursor: session?.toc || 0,
				slider: session?.slider || [],
				sliderIndex: session?.sliderIndex || 0,
				visibleWidth,
			});
			if (session) session.scroll = model.scroll;
			dialog.planScroll = model.scroll;
			dialog.planMaxScroll = model.maxScroll;
			dialog.planSidebar = model.sidebar;
			dialog.planTocMax = Math.max(0, model.headings.length - 1);
			dialog.planSectionStarts = model.sectionStarts;
			dialog.mouseRows = [];
			dialog.mouseBox = { x: 0, y: 0, width, height: Math.min(height, model.regions.length) };
			const next = Array.from({ length: height }, () => this.#paintOverlayRow(width, ""));
			model.regions.forEach((region, y) => {
				if (y >= height) return;
				const rule = (glyph) => color.border(glyph.repeat(Math.max(1, width - 2)));
				if (region.type === "top") next[y] = this.#paintOverlayRow(width, color.border(`╭─ ${bold(color.accent("Plan Review"))} ${"─".repeat(Math.max(0, width - 18))}╮`));
				else if (region.type === "bottom") next[y] = this.#paintOverlayRow(width, color.border(`╰${rule("─")}╯`));
				else if (region.type === "divider") next[y] = this.#paintOverlayRow(width, color.border(`├${rule("─")}┤`));
				else if (region.type === "slider") next[y] = this.#paintOverlayRow(width, ` ${color.accent("◂")} ${bold(color.text(region.label || "—"))} ${color.dim(`${region.index + 1}/${region.count}`)} ${color.accent("▸")}`);
			else if (region.type === "prompt") next[y] = this.#paintOverlayRow(width, ` ${bold(color.accent(region.text))}`);
				else if (region.type === "help") next[y] = this.#paintOverlayRow(width, ` ${color.dim(region.text)}`);
				else if (region.type === "option") {
					const cursor = region.selected ? color.accent(region.focused ? "❯ " : "· ") : "  ";
					const label = region.selected && region.focused ? bold(color.accent(region.label)) : color.text(region.label);
					next[y] = this.#paintOverlayRow(width, ` ${cursor}${label}`);
					dialog.mouseRows.push({ y, index: region.index, action: "plan-option" });
				} else {
					const body = color.muted(region.text || " ");
					const side = region.sidebar ? color.dim(truncateToWidth(region.side || "", region.sidebarWidth, "…")) : "";
					next[y] = this.#paintOverlayRow(width, region.sidebar ? ` ${pad(side, region.sidebarWidth)} ${color.border("│")} ${body}` : ` ${body}`);
					dialog.mouseRows.push({ y, action: "plan-body" });
				}
			});
			return next;
		}

		#drawAsk(screen, width, height, dialog) {
			const payload = dialog.structured?.payload || {};
			const session = dialog.askSession;
			const current = session?.questions[session.tab];
			const model = askPanelModel({
				width, height,
				questions: session ? [...session.questions.map((item) => ({ header: item.header || item.id, question: item.question })), { header: "Submit", question: "Review answers and submit." }] : payload.questions,
				index: session ? session.tab : payload.index,
				options: current ? [...current.options.map((option) => ({ ...option })), ...(current.allowOther ? [{ label: current.custom ? `Other: ${current.custom}` : "Other" }] : [])] : [{ label: "Submit", recommended: true }],
				selected: current?.cursor || dialog.selected || 0,
				answers: session ? session.questions.map((item) => item.selected.size || item.custom ? item : undefined) : payload.answers,
			});
			if (session && session.tab === session.questions.length) model.question = session.questions.map((item, index) => `${index + 1}. ${item.header || item.id}: ${item.custom || [...item.selected].join(", ") || "unanswered"}${item.note ? ` · note: ${item.note}` : ""}`).join("\n");
			const next = [...screen];
			for (let y = model.top; y < Math.min(height, model.top + model.boxHeight); y++) next[y] = blackBackground(" ".repeat(width));
			const inner = Math.max(4, model.boxWidth - 4);
			const tabs = model.tabs.map((tab) => `${tab.active ? color.accent(`[${tab.label}]`) : tab.done ? color.success(tab.label) : color.dim(tab.label)}`).join("  ");
			const lines = [
				color.border(`╭─ ${bold(color.accent(model.title))} ${"─".repeat(Math.max(0, model.boxWidth - 12))}╮`),
				` ${tabs}`,
				color.border(`├${"─".repeat(Math.max(1, model.boxWidth - 2))}┤`),
				...wrap(model.question, inner).slice(0, 3).map((line) => ` ${bold(color.text(line))}`),
				"",
			];
			dialog.mouseRows = [];
			model.options.forEach((option, index) => {
				const marker = option.recommended ? color.accent("★") : color.dim("○");
				const cursor = option.selected ? color.accent("❯") : " ";
				const label = option.selected ? bold(color.accent(option.label)) : color.text(option.label);
				lines.push(` ${cursor} ${marker} ${label}`);
				if (option.description && option.selected) lines.push(`     ${color.dim(option.description)}`);
				dialog.mouseRows.push({ y: model.top + lines.length - 1, index });
			});
			lines.push(color.border(`├${"─".repeat(Math.max(1, model.boxWidth - 2))}┤`), ` ${color.dim(model.help)}`, color.border(`╰${"─".repeat(Math.max(1, model.boxWidth - 2))}╯`));
			const box = lines.slice(0, model.boxHeight).map((line) => menuBackground(` ${pad(line, model.boxWidth - 2)} `));
			while (box.length < model.boxHeight) box.push(menuBackground(" ".repeat(model.boxWidth)));
			box.forEach((line, row) => { if (model.top + row < height) next[model.top + row] = compositeTuiLine(next[model.top + row], line, model.left, model.boxWidth, width); });
			dialog.mouseBox = { x: model.left, y: model.top, width: model.boxWidth, height: model.boxHeight };
			dialog.mouseClose = { x: model.left + model.boxWidth - 6, y: model.top, width: 4, height: 1 };
			return next;
		}

		#drawDialog(screen, width, height) {
			const dialog = state.dialog;
			if (!dialog || width < 6 || height < 3) return screen;
			if (dialog.setupWizard) return this.#drawProviderSetup(width, height, dialog);
			if (dialog.kind === "plan-review") return this.#drawPlanReview(width, height, dialog);
			if (dialog.kind === "ask") return this.#drawAsk(screen, width, height, dialog);
			if (dialog.kind === "sessions") return this.#drawSessions(screen, width, height, dialog);
			if (dialog.kind === "settings") return this.#drawSettings(screen, width, height, dialog);
			if (dialog.kind === "hub" && width >= 50 && height >= 12) return this.#drawHub(screen, width, height, dialog);
			if (dialog.closeHovered == null) dialog.closeHovered = false;
			const requestedBounds = state.dialogBounds || { x: 0, width };
			const dialogBounds = requestedBounds.width >= 20 ? requestedBounds : { x: 0, width };
			const areaX = Math.max(0, Math.min(width - 1, dialogBounds.x || 0));
			const areaWidth = Math.max(1, Math.min(width - areaX, dialogBounds.width || width));
			const widthRatio = dialog.wide ? 0.98 : dialog.searchable ? 0.96 : 0.9;
			const boxWidth = Math.max(1, Math.min(areaWidth, Math.floor(areaWidth * widthRatio)));
			const innerWidth = boxWidth - 4;
			const content = [];
			const optionRows = [];
			if (dialog.structured) {
				const preview = structuredPreview(dialog.structured, innerWidth).flatMap((line) => wrap(line, innerWidth));
				const capacity = Math.max(1, height - 12);
				dialog.previewMaxOffset = Math.max(0, preview.length - capacity);
				dialog.previewOffset = Math.max(0, Math.min(dialog.previewOffset || 0, dialog.previewMaxOffset));
				if (dialog.previewOffset) content.push(color.dim("↑ PgUp"));
				content.push(...preview.slice(dialog.previewOffset, dialog.previewOffset + capacity).map((line) => color.muted(line)));
				if (dialog.previewOffset < dialog.previewMaxOffset) content.push(color.dim("↓ PgDown"));
				content.push("");
			} else if (dialog.message && dialog.kind !== "status" && !dialog.searchable) content.push(...wrap(dialog.message, innerWidth), "");
			if (dialog.searchable) {
				if (dialog.wide && dialog.message) content.push(color.muted(dialog.message), "");
				content.push(
					"",
					` ${bold(color.text(t("dialog.searchLabel")))}${dialog.query ? ` ${color.text(dialog.query)}` : ""}`,
					"",
				);
			}
			if (dialog.kind === "select" || dialog.kind === "confirm" || dialog.kind === "hub") {
				const visibleOptions = Math.max(3, Math.min(height - 8, dialog.searchable ? 12 : 16));
				const first = Math.max(0, Math.min(
					dialog.options.length - visibleOptions,
					dialog.selected - Math.floor(visibleOptions / 2),
				));
				const last = Math.min(dialog.options.length, first + visibleOptions);
				if (first > 0) content.push(color.dim(`  ${t("dialog.moreUp", { count: first })}`));
				let previousSection;
				for (let index = first; index < last; index++) {
					const option = dialog.options[index];
					const section = dialog.sections?.get(option);
					if (section && section !== previousSection) {
						content.push(dialog.searchable
							? ` ${color.secondary(section)}`
							: `${color.secondary(section)} ${color.border("─".repeat(Math.max(0, innerWidth - visibleWidth(section) - 1)))}`);
						previousSection = section;
					}
					const selected = index === dialog.selected;
					optionRows.push({ row: content.length, index });
					const optionLine = `${selected ? "❯" : " "} ${option}`;
					content.push(selected
						? menuSelection(pad(optionLine, innerWidth))
						: `${selected ? color.accent("❯") : " "} ${selected ? bold(color.text(option)) : color.muted(option)}`);
					const description = dialog.descriptions?.get(option);
					if (description && selected && !dialog.searchable) {
						const shown = state.markdown ? inlineAnsi(description, DIM_OPEN) : description;
						content.push(`  ${color.dim(shown)}`);
					}
				}
				if (!dialog.options.length) content.push(color.dim(`  ${t("dialog.noMatch")}`));
				if (last < dialog.options.length) content.push(color.dim(`  ${t("dialog.moreDown", { count: dialog.options.length - last })}`));
			} else if (dialog.kind === "multi") {
				const visibleOptions = Math.max(3, Math.min(16, height - 8));
				const first = Math.max(0, Math.min(
					dialog.options.length - visibleOptions,
					dialog.selected - Math.floor(visibleOptions / 2),
				));
				const last = Math.min(dialog.options.length, first + visibleOptions);
				if (first > 0) content.push(color.dim(`  ${t("dialog.moreUp", { count: first })}`));
				for (let index = first; index < last; index++) {
					const option = dialog.options[index];
					const selected = index === dialog.selected;
					const isApply = dialog.applyOption === option;
					const on = !isApply && (dialog.checked ? dialog.checked(option) : toolEnabled(option));
					const marker = isApply ? color.accent("[↵]") : on ? bold(color.success("[x]")) : color.dim("[ ]");
					optionRows.push({ row: content.length, index });
					content.push(`${selected ? color.accent("❯") : " "} ${marker} ${selected ? bold(color.text(option)) : color.muted(option)}`);
					const description = dialog.descriptions?.get(option) || state.tools.labels[option] || t(TOOL_LABEL_KEYS[option] || option);
					if (description && selected) {
						const shown = state.markdown ? inlineAnsi(description, DIM_OPEN) : description;
						content.push(`  ${color.dim(shown)}`);
					}
				}
				if (last < dialog.options.length) content.push(color.dim(`  ${t("dialog.moreDown", { count: dialog.options.length - last })}`));
			} else if (dialog.kind === "status") {
				const statusLines = wrap(dialog.message || "", innerWidth);
				const visibleRows = Math.max(1, height - 6);
				const maxOffset = Math.max(0, statusLines.length - visibleRows + 1);
				dialog.statusMaxOffset = maxOffset;
				dialog.statusOffset = Math.max(0, Math.min(maxOffset, dialog.statusOffset || 0));
				if (dialog.statusOffset > 0) content.push(color.dim(`  ${t("dialog.moreUp", { count: dialog.statusOffset })}`));
				const start = dialog.statusOffset;
				const end = Math.min(statusLines.length, start + visibleRows - (dialog.statusOffset > 0 ? 1 : 0));
				content.push(...statusLines.slice(start, end));
				if (end < statusLines.length) content.push(color.dim(`  ${t("dialog.moreDown", { count: statusLines.length - end })}`));
			} else if (dialog.kind === "input" || dialog.kind === "editor") {
				const draft = dialog.secret ? "•".repeat([...editor.getText()].length) : editor.getText();
				const inputLines = wrap(draft || " ", Math.max(1, innerWidth - 2)).slice(-Math.max(1, height - 9));
				content.push(...inputLines.map((line) => bandBackground(pad(` ${color.accent("▏")} ${color.text(line)}`, innerWidth))), "", color.dim("Alt+Enter: newline · Enter: continue · Esc: cancel"));
			} else {
				content.push(color.muted(t("dialog.valueHint")));
			}
			const boxHeight = dialog.searchable
				? Math.min(height, Math.max(6, content.length + 2))
				: Math.min(height - 2, Math.max(5, content.length + 4));
			const top = Math.max(0, Math.floor((height - boxHeight) / 2));
			const left = areaX + Math.max(0, Math.floor((areaWidth - boxWidth) / 2));
			const compositeDialogRow = (baseLine, overlayLine) => {
				return compositeTuiOverlayLine(baseLine, overlayLine, {
					startCol: left,
					overlayWidth: boxWidth,
					totalWidth: width,
					background: BLACK_BACKGROUND,
					composite: compositeTuiLine,
				});
			};
			dialog.mouseRows = optionRows.map((item) => ({ y: top + 1 + item.row, index: item.index }));
			dialog.mouseBox = { x: left, y: top, width: boxWidth, height: boxHeight };
			if (dialog.searchable) {
				const title = truncateToWidth(dialog.title || "Tsukuyomi", Math.max(4, boxWidth - 12), "…");
				const close = color.muted("esc");
				const titleText = `  ${bold(color.text(title))}`;
				const header = `${titleText}${" ".repeat(Math.max(1, boxWidth - visibleWidth(titleText) - visibleWidth(close) - 2))}${close}  `;
				const box = [menuBackground(pad(header, boxWidth))];
				for (const line of content.slice(0, boxHeight - 1)) box.push(menuBackground(`  ${pad(line, innerWidth)}  `));
				while (box.length < boxHeight) box.push(menuBackground(" ".repeat(boxWidth)));
				const next = [...screen];
				for (let row = 0; row < box.length && top + row < height; row++) {
					next[top + row] = compositeDialogRow(next[top + row], box[row]);
				}
				dialog.mouseClose = { x: left + Math.max(0, boxWidth - 7), y: top, width: 5, height: 1 };
				return next;
			}
			const closeX = boxWidth - 7;
			dialog.mouseClose = { x: left + closeX, y: top, width: 5, height: 1 };
			const title = truncateToWidth(dialog.title || "Tsukuyomi", Math.max(4, boxWidth - 11), "…");
			const close = dialog.closeHovered ? bold(modalPrimary("[✗]")) : modalGrayDim("[✗]");
			const header = `  ${bold(color.accent(title))}${" ".repeat(Math.max(1, boxWidth - visibleWidth(title) - 9))}${close}  `;
			const box = [menuBackground(pad(header, boxWidth))];
			for (const line of content.slice(0, boxHeight - 1)) box.push(menuBackground(`  ${pad(line, innerWidth)}  `));
			while (box.length < boxHeight) box.push(menuBackground(" ".repeat(boxWidth)));
			const next = [...screen];
			for (let row = 0; row < box.length && top + row < height; row++) {
				next[top + row] = compositeDialogRow(next[top + row], box[row]);
			}
			return next;
		}

		#home(width, height) {
			state.dialogBounds = { x: 0, width };
			const lines = Array.from({ length: height }, () => "");
			const compactHome = width < 80 || height < 22;
			const composerWidth = width >= 12 ? width - 2 : Math.max(1, width);
			const homeEditorWidth = Math.max(1, composerWidth - 4);
			const composer = this.#grokComposer(composerWidth, editorLinesFor(homeEditorWidth), compactHome ? 3 : 12);
			const editorTop = Math.max(0, height - composer.lines.length - 2);
			const editorLeft = Math.max(0, Math.floor((width - composerWidth) / 2));

			if (height > 2) lines[0] = ` ${color.dim(compactPath(cwd))}`;
			const fullLogo = width >= visibleWidth(TSUKUYOMI_LOGO[0]) + 4
				&& editorTop >= TSUKUYOMI_LOGO.length + 11;
			const logoRows = fullLogo
				? TSUKUYOMI_LOGO.map(paintLogoRow)
				: [paintLogoRow("Ti", 0)];
			const logoTop = Math.max(1, Math.min(
				Math.floor(editorTop * (fullLogo ? 0.15 : 0.08)),
				Math.max(1, editorTop - logoRows.length - 4),
			));
			for (let row = 0; row < logoRows.length && logoTop + row < editorTop; row++) {
				lines[logoTop + row] = pad(logoRows[row], width, "center");
			}
			const avatarTop = logoTop + logoRows.length + 1;
			const availableGreetingWidth = Math.max(1, width - 4);
			const greetingRows = editorTop - avatarTop >= GREETING_ASCII_ART.length + 2
				&& GREETING_ASCII_ART_WIDTH <= availableGreetingWidth
				? GREETING_ASCII_ART_ALIGNED
				: ["Kaguya Dayou ~"];
			const greetingGap = greetingRows.length > 1 ? 2 : 1;
			const avatarRoom = Math.max(0, editorTop - avatarTop - greetingGap - greetingRows.length);
			const avatarRows = renderHomeAvatarRows(Math.min(49, width - 4), avatarRoom);
			for (let row = 0; row < avatarRows.length && avatarTop + row < editorTop; row++) {
				lines[avatarTop + row] = pad(avatarRows[row], width, "center");
			}
			const greetingTop = avatarTop + avatarRows.length + greetingGap;
			for (let row = 0; row < greetingRows.length && greetingTop + row < editorTop; row++) {
				lines[greetingTop + row] = pad(paintHomeGreeting(greetingRows[row]), width, "center");
			}

			for (let row = 0; row < composer.lines.length && editorTop + row < height; row++) {
				lines[editorTop + row] = compositeTuiLine(lines[editorTop + row], " ".repeat(composerWidth), editorLeft, composerWidth, width);
				lines[editorTop + row] = compositeTuiLine(lines[editorTop + row], composer.lines[row], editorLeft, composerWidth, width);
			}
			state.mouseZones.push({ x: editorLeft, y: editorTop, width: composerWidth, height: composer.lines.length, action: "composer" });
			if (Date.now() < state.toastUntil && height > 1) {
				const painter = state.toastType === "error" ? color.error : state.toastType === "warning" ? color.warning : color.muted;
				// Keep transient startup messages below the composer.
				lines[height - 1] = pad(painter(state.toast), width, "center");
			}
			return this.#drawDialog(lines, width, height);
		}

		#grokStatusBar(width) {
			const columns = Math.max(1, width);
			const branch = gitBranch ? ` · ${gitBranch}` : "";
			const workspace = truncateToWidth(
				`${compactPath(cwd)}${branch}`,
				Math.min(columns, Math.max(6, Math.floor(columns * 0.34))),
				"…",
			);
			const leftStyled = color.muted(workspace);
			const rightStyled = this.#contextText();
			const leftWidth = visibleWidth(leftStyled);
			const rightWidth = visibleWidth(rightStyled);
			if (leftWidth + rightWidth + 2 <= columns) {
				const rightX = columns - rightWidth;
				let line = pad(leftStyled, columns);
				line = compositeTuiLine(line, rightStyled, rightX, rightWidth, width);
				return { line, workspaceWidth: leftWidth, centerX: 0, centerWidth: 0, rightX, rightWidth };
			}
			if (leftWidth >= columns - 1) {
				return { line: pad(leftStyled, columns), workspaceWidth: columns, centerX: 0, centerWidth: 0, rightX: columns, rightWidth: 0 };
			}
			const compactRight = truncateToWidth(rightStyled, Math.max(1, columns - leftWidth - 1), "…");
			const gap = Math.max(1, columns - leftWidth - visibleWidth(compactRight));
			return {
				line: pad(`${leftStyled}${" ".repeat(gap)}${color.muted(compactRight)}`, columns),
				workspaceWidth: leftWidth,
				centerX: 0,
				centerWidth: 0,
				rightX: leftWidth + gap,
				rightWidth: visibleWidth(compactRight),
			};
		}

		#grokTurnStatus(width) {
			let status;
			if (state.compacting) {
				status = `${color.warning("↻")} ${color.warning(t("status.compacting"))}`;
			} else {
				const current = state.stream.at(-1);
				const runningTool = [...state.workflow].reverse().find((item) => item.status === "running");
				const elapsed = state.runWorkSince ? formatDuration((Date.now() - state.runWorkSince) / 1000, locale) : "";
				const phase = runningTool || current?.kind === "tool"
					? t("status.working")
					: current?.kind === "thinking" ? t("status.thinking") : t("status.responding");
				const glyph = current?.kind === "thinking" && !runningTool
					? color.secondary("✦")
					: color.success(SPINNER[spinnerFrame % SPINNER.length]);
				const detail = runningTool?.label || (current?.kind === "tool" ? current.label : "");
				status = `${glyph} ${color.text(phase)}${detail ? color.dim(` · ${detail}`) : ""}${elapsed ? color.dim(` · ${elapsed}`) : ""}`;
			}
			if (state.queued > 0) status += color.dim(t("status.queuedSuffix", { count: formatNumber(state.queued, locale) }));
			const stop = state.working && !state.compacting ? color.error(t("status.stopShort")) : "";
			const stopWidth = visibleWidth(stop);
			const body = truncateToWidth(status, Math.max(1, width - stopWidth - 2), "…");
			const gap = stop ? Math.max(1, width - visibleWidth(body) - stopWidth) : 0;
			return {
				line: pad(`${body}${" ".repeat(gap)}${stop}`, width),
				stopX: stop ? width - stopWidth : undefined,
				stopWidth,
			};
		}

		#dockView(width) {
			const visual = buildDockRows({
				workflow: state.workflow,
				todos: state.todos,
				queued: state.queued,
				working: state.working,
				expanded: state.dockTasksExpanded,
				maxTaskRows: 2,
			});
			const rows = [];
			for (const item of visual) {
				if (item.kind === "header") {
					const label = item.section === "tasks" ? t("panel.tasks") : t("panel.queued");
					const chevron = item.section === "tasks" ? (item.expanded ? "▾ " : "▸ ") : "▸ ";
					const lead = `${chevron}${label} ${formatNumber(item.count, locale)} `;
					const fill = "─".repeat(Math.max(0, width - visibleWidth(lead)));
					rows.push({
						key: `dock:${item.section}`,
						action: item.section === "tasks" ? "dock-toggle" : undefined,
						text: `${color.dim(chevron)}${bold(color.muted(label))} ${color.dim(`${formatNumber(item.count, locale)} ${fill}`)}`,
					});
					continue;
				}
				if (item.kind === "more") {
					rows.push({ text: `    ${color.dim(`▾ ${formatNumber(item.count, locale)} ${t("panel.more")}`)}` });
					continue;
				}
				const elapsed = item.task.startedAt
					? formatDuration((Date.now() - item.task.startedAt) / 1000, locale)
					: "";
				const left = `    ${color.warning("◆")} ${color.warning(item.task.kind)} ${color.text(item.task.description)}`;
				const leftShort = truncateToWidth(left, Math.max(4, width - visibleWidth(elapsed) - 1), "…");
				const gap = Math.max(1, width - visibleWidth(leftShort) - visibleWidth(elapsed));
				rows.push({
					key: `dock:task:${item.task.id}`,
					text: `${leftShort}${" ".repeat(gap)}${color.dim(elapsed)}`,
				});
			}
			// Queued prompts: Grok Build shows the text, not just a count. Show up
			// to two wrapped rows per prompt and let the wheel scroll the rest.
			if (state.queued > 0) {
				const entries = [
					...state.queueItems.steering.map((text) => ({ prefix: color.accent("↪"), text })),
					...state.queueItems.followUp.map((text) => ({ prefix: color.success("+"), text })),
				];
				const contentWidth = Math.max(8, width - 6);
				const lines = [];
				for (const entry of entries) {
					const wrapped = wrap(clean(entry.text), contentWidth);
					const shown = wrapped.slice(0, 2);
					for (let index = 0; index < shown.length; index++) {
						const ellipsis = index === shown.length - 1 && wrapped.length > 2 ? color.dim(" …") : "";
						lines.push(`    ${index === 0 ? entry.prefix : " "} ${color.dim(truncateToWidth(shown[index] || " ", contentWidth, "…"))}${ellipsis}`);
					}
				}
				const viewport = Math.max(1, Math.min(4, lines.length));
				state.queueMaxScroll = Math.max(0, lines.length - viewport);
				state.queueScroll = Math.max(0, Math.min(state.queueMaxScroll, state.queueScroll || 0));
				const start = state.queueScroll;
				const end = Math.min(lines.length, start + viewport);
				for (let index = start; index < end; index++) {
					rows.push({ key: `dock:queue:${index}`, action: "dock-queue", text: truncateToWidth(lines[index], width, "…") });
				}
				if (end < lines.length) rows.push({ text: `    ${color.dim(`▾ ${formatNumber(lines.length - end, locale)} ${t("panel.more")}`)}` });
			}
			return rows;
		}

	#grokComposer(width, editorLines, maxRows) {
			const geometry = wideComposerGeometry(width, maxRows);
			const { columns } = geometry;
			if (geometry.minimal) {
				const editorLine = editorLines.findLast((line) => visibleWidth(line) > 0) || "";
				return {
					lines: [blackBackground(pad(`${color.secondary("│")} ${editorLine}`, columns))],
					metaRow: 0,
					statusX: 0,
					statusWidth: 0,
					providerX: 0,
					providerWidth: 0,
					modelX: 0,
					modelWidth: 0,
					modeX: 0,
					modeWidth: 0,
				};
			}
			const stripAnsi = (value) => value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
			const isEditorRule = (value) => {
				const plain = stripAnsi(value).trim();
				return plain.length > 0 && /^[─↑↓ ]+$/.test(plain);
			};
			const { contentWidth } = geometry;
			const filteredEditor = editorLines.filter((line) => !isEditorRule(line));
			const requestedAutocompleteCount = Math.min(
				Math.max(0, Math.floor(Number(editor.renderedAutocompleteHeight) || 0)),
				filteredEditor.length,
			);
			const editable = filteredEditor.slice(0, filteredEditor.length - requestedAutocompleteCount);
			const requestedAutocomplete = requestedAutocompleteCount > 0
				? filteredEditor.slice(filteredEditor.length - requestedAutocompleteCount)
				: [];
			const maxAutocompleteRows = Math.max(0, maxRows - 3); // status, input, return border
			const selectedCompletion = requestedAutocomplete.findIndex((line) => stripAnsi(line).trimStart().startsWith("→"));
			const completionStart = requestedAutocomplete.length <= maxAutocompleteRows
				? 0
				: Math.max(0, Math.min(
					selectedCompletion < 0 ? 0 : selectedCompletion - Math.floor(maxAutocompleteRows / 2),
					requestedAutocomplete.length - maxAutocompleteRows,
				));
			const autocomplete = requestedAutocomplete.slice(completionStart, completionStart + maxAutocompleteRows);
			// Reserve one row for the lower return edge even when the autocomplete
			// popup is closed; otherwise the frame loses its bottom at the screen edge.
			const editableBudget = Math.max(1, maxRows - 2 - autocomplete.length);
			// The cursor marker must survive into the final frame or the hardware
			// cursor (and IME preedit) is misplaced. Tail-trimming can drop a marker
			// that sits on an early line, so pick the window that keeps it.
			const markerIndex = editable.findIndex((line) => line.includes(CURSOR_MARKER));
			const contentStart = markerIndex < 0
				? Math.max(0, editable.length - editableBudget)
				: Math.max(0, Math.min(markerIndex, editable.length - editableBudget));
			const content = editable.slice(contentStart, contentStart + editableBudget);
			const contextRaw = `${formatPercent(state.contextPercent ?? 0, locale)}%/${formatTokens(state.contextTokens ?? 0, locale)}`;
			const modelId = state.model?.id || state.model?.name || t("status.noModel");
			const providerText = state.model?.provider || t("status.provider");
			const modelText = modelId;
			const modelLabel = `${providerText}/${modelText}`;
			const modeText = t(`mode.${state.mode}`);
			const thinkingText = state.thinking || "off";
			const workspace = compactPath(cwd);
			const cost = Number(state.sessionTokens?.cost || 0);
			const route = state.team?.active
				? state.team.collaborationMode === "leader"
					? `${locale === "zh" ? "发给 Leader" : "To leader"}: ${(state.team.members || []).find((member) => member.id === state.team.leaderId)?.name || "leader"}`
					: (locale === "zh" ? "发给所有 Agent" : "To every agent")
				: "";
			const statusParts = [
				{ raw: "Ti", paint: (value) => bold(color.title(value)) },
				{ raw: `v${version}`, paint: (value) => color.dim(value) },
				...(route ? [{ raw: route, paint: (value) => color.secondary(value) }] : []),
				{ raw: modelLabel, paint: (value) => color.accent(value) },
				{ raw: `⚡ ${thinkingText}`, paint: (value) => color.warning(value) },
				{ raw: workspace, paint: (value) => color.muted(value) },
				...(gitBranch ? [{ raw: gitBranch, paint: (value) => color.secondary(value) }] : []),
				{ raw: contextRaw, paint: (value) => color.dim(value) },
				{ raw: `$${cost.toFixed(2)}`, paint: (value) => color.warning(value) },
				{ raw: modeText, paint: (value) => bold(color.text(value)) },
			];
			const separator = " › ";
			const statusAvailable = Math.max(1, columns - 6);
			const formatStatus = () => ({
				raw: statusParts.map((part) => part.raw).join(separator),
				text: statusParts.map((part) => part.paint(part.raw)).join(color.dim(separator)),
			});
			let { raw: rawStatus, text: statusText } = formatStatus();
			if (visibleWidth(statusText) > statusAvailable) {
				const workspacePart = statusParts.find((part) => part.raw === workspace);
				if (workspacePart && workspace.includes("/")) workspacePart.raw = workspace.split("/").filter(Boolean).at(-1) || "~";
				const branchIndex = statusParts.findIndex((part) => part.raw === gitBranch);
				if (branchIndex >= 0 && visibleWidth(formatStatus().text) > statusAvailable) statusParts.splice(branchIndex, 1);
				({ raw: rawStatus, text: statusText } = formatStatus());
			}
			const statusWidth = visibleWidth(statusText);
			const fittedStatus = statusWidth > statusAvailable
				? truncateToWidth(statusText, Math.max(1, statusAvailable), "…")
				: statusText;
			const fittedStatusWidth = visibleWidth(fittedStatus);
			const border = rgb(0, 174, 239);
			// Restore the canvas background after the pill. Its SGR reset would
			// otherwise leave the adjacent top-border glyphs on the terminal default.
			const statusPill = `${paintBackground(` ${fittedStatus} `, MENU_BACKGROUND)}${BLACK_BACKGROUND}`;
			const topFill = Math.max(0, columns - fittedStatusWidth - 5);
			const lines = [`${border("╭─")}${statusPill}${border("─".repeat(topFill))}${border("╮")}`];
			for (let index = 0; index < content.length; index++) {
				// The editor's APC cursor marker is zero-width to the terminal but is
				// not understood by pi-tui's generic truncator. Measure without it and
				// append padding manually so IME/hardware-cursor placement survives.
				const line = content[index];
				const measuredWidth = visibleWidth(line.replace(CURSOR_MARKER, ""));
				const fittedLine = `${line}${" ".repeat(Math.max(0, contentWidth - measuredWidth))}`;
				lines.push(`${border("│")} ${fittedLine} ${border("│")}`);
			}
			if (lines.length < maxRows) {
				// OMP closes the editor with a lower-left return before its
				// completion popup begins. Keep the popup outside that frame.
				lines.push(`${border("╰")}${border("─".repeat(Math.max(0, columns - 2)))}${border("╯")}`);
			}
			for (const line of autocomplete) {
				if (lines.length >= maxRows) break;
				const selected = stripAnsi(line).trimStart().startsWith("→");
				const fittedLine = pad(line, columns);
				lines.push(selected ? listSelection(fittedLine) : fittedLine);
			}
			const statusStart = 3;
			const providerOffset = rawStatus.indexOf(providerText);
			const modelOffset = rawStatus.indexOf(modelText, providerOffset + providerText.length);
			const modeOffset = rawStatus.indexOf(modeText);
			const contextOffset = rawStatus.indexOf(contextRaw);
			const segmentWidth = (offset, raw) => offset >= 0 && offset < fittedStatusWidth ? Math.min(visibleWidth(raw), fittedStatusWidth - offset) : 0;
			return {
				lines: lines.slice(0, Math.max(1, maxRows)),
				metaRow: 0,
				statusX: statusStart,
				statusWidth: fittedStatusWidth,
				providerX: statusStart + providerOffset,
				providerWidth: segmentWidth(providerOffset, providerText),
				modelX: statusStart + modelOffset,
				modelWidth: segmentWidth(modelOffset, modelText),
				modeX: statusStart + modeOffset,
				modeWidth: segmentWidth(modeOffset, modeText),
				contextX: statusStart + contextOffset,
				contextWidth: segmentWidth(contextOffset, contextRaw),
			};
		}

		#drawPanelOverlay(screen, width, height) {
			if (!state.panelOverlay || width >= FULL_RAIL_MIN_COLUMNS || width < 8 || height < 5) {
				if (width >= FULL_RAIL_MIN_COLUMNS) state.panelOverlay = undefined;
				return screen;
			}
			const boxWidth = Math.max(8, Math.min(64, width - 4));
			const boxHeight = Math.max(5, height - 2);
			const left = Math.max(0, Math.floor((width - boxWidth) / 2));
			const top = Math.max(0, Math.floor((height - boxHeight) / 2));
			const innerWidth = Math.max(1, boxWidth - 2);
			const innerHeight = Math.max(1, boxHeight - 2);
			state.mouseZones = [{
				key: "overlay:backdrop",
				x: 0,
				y: 0,
				width,
				height,
				action: "close-panel-overlay",
			}];
			state.mouseZones.push({
				key: "overlay:body",
				x: left + 1,
				y: top + 1,
				width: innerWidth,
				height: innerHeight,
				action: "panel-body",
				panel: state.panelOverlay,
			});
			state.panelScrollbars.clear();
			let panel;
			if (state.panelOverlay === "files") panel = this.#leftPanel(innerWidth, innerHeight, left + 1, top + 1);
			else if (state.panelOverlay === "todo") panel = this.#todoPanel(innerWidth, innerHeight, left + 1, top + 1);
			else panel = this.#workflowPanel(innerWidth, innerHeight, left + 1, top + 1);
			const overlay = [
				panelBackground(color.border(`╭${"─".repeat(Math.max(0, boxWidth - 2))}╮`)),
				...panel,
				panelBackground(color.border(`╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`)),
			].slice(0, boxHeight);
			for (let row = 0; row < overlay.length && top + row < height; row++) {
				screen[top + row] = compositeTuiLine(screen[top + row] || pad("", width), overlay[row], left, boxWidth, width);
			}
			return screen;
		}

		#session(width, height) {
			state.mouseZones = [];
			state.panelScrollbars.clear();
			const shell = computeWorkspaceLayout({
				width,
				height,
				showFiles: state.showFiles,
				showRight: state.showWorkflow || state.showTodos,
			});
			state.dialogBounds = { x: shell.center.x, width: shell.center.width };
			const left = shell.left.width
				? this.#leftPanel(shell.left.width, height, shell.left.x, 0)
				: [];
			const right = shell.right.width
				? this.#rightPanel(shell.right.width, height, shell.right.x, 0)
				: [];
			const centerWidth = shell.center.width;
			const estimatedHorizontalPadding = centerWidth >= 8 ? (height <= 20 ? 1 : 2) : 0;
			const estimatedInnerWidth = Math.max(1, centerWidth - estimatedHorizontalPadding * 2);
			const firstDock = this.#dockView(estimatedInnerWidth);
			const initialEditorWidth = Math.max(1, estimatedInnerWidth - 4);
			const initialEditorLines = editorLinesFor(initialEditorWidth);
			const initialComposer = this.#grokComposer(estimatedInnerWidth, initialEditorLines, 13);
			const desiredPromptHeight = Math.max(1, Math.min(13, initialComposer.lines.length));
			const layout = computeAgentLayout({
				width: centerWidth,
				height,
				promptHeight: desiredPromptHeight,
				statusHeight: 0,
				dockHeight: firstDock.length,
				// Progress belongs to the transcript in the Grok layout. Reserving a
				// second fixed status row produced the old duplicated "responding" bar.
				turnStatusHeight: 0,
				shortcutsHeight: 1,
			});
			const editorWidth = Math.max(1, layout.prompt.width - 4);
			// Editor.render() also maintains its viewport. Reuse the sizing pass when
			// the width is unchanged so reserved and painted composer heights are
			// derived from the exact same editor frame.
			const editorLines = editorWidth === initialEditorWidth
				? initialEditorLines
				: editorLinesFor(editorWidth);
			const composer = this.#grokComposer(
				layout.prompt.width,
				editorLines,
				Math.max(1, layout.prompt.height),
			);
			const dock = this.#dockView(layout.dock.width);
			const center = Array.from({ length: height }, () => pad("", centerWidth));
			const place = (area, rows) => {
				for (let row = 0; row < Math.min(area.height, rows.length); row++) {
					if (area.y + row >= height) break;
					center[area.y + row] = compositeTuiLine(
						center[area.y + row],
						pad(rows[row], area.width),
						area.x,
						area.width,
						centerWidth,
					);
				}
			};

			if (layout.statusBar.height) {
				const status = this.#grokStatusBar(layout.statusBar.width);
				place(layout.statusBar, [status.line]);
				state.mouseZones.push({
					key: "status:workspace",
					x: shell.center.x + layout.statusBar.x,
					y: layout.statusBar.y,
					width: Math.max(1, status.workspaceWidth),
					height: 1,
					action: "workspace",
				});
				if (status.centerWidth > 0) {
					state.mouseZones.push({
						key: "status:sessions",
						x: shell.center.x + layout.statusBar.x + status.centerX,
						y: layout.statusBar.y,
						width: status.centerWidth,
						height: 1,
						action: "sessions",
					});
				}
				if (status.rightWidth > 0) {
					state.mouseZones.push({
						key: "status:usage",
						x: shell.center.x + layout.statusBar.x + status.rightX,
						y: layout.statusBar.y,
						width: status.rightWidth,
						height: 1,
						action: "status",
					});
				}
			}

			const userTurnCount = state.userTurnCount ?? 0;
			const timelineCandidate = state.keybindingPreset === "legacy" && userTurnCount >= 2 && layout.scrollback.width >= 60;
			const railWidth = timelineCandidate ? 2 : 1;
			const transcriptWidth = Math.max(1, layout.scrollback.width - railWidth);
			const flow = this.#messageLines(transcriptWidth);
			const previousContentLength = state.transcriptContentLength;
			const previousViewportLength = state.transcriptViewportLength;
			let nextOffset = preserveScrollOffset({
				offset: state.transcriptOffset,
				contentLength: previousContentLength,
				nextContentLength: flow.total,
				viewportLength: previousViewportLength,
				nextViewportLength: layout.scrollback.height,
				followTail: state.transcriptFollowTail,
			});
			if (!state.transcriptFollowTail && state.transcriptAnchor) {
				const anchorBlock = flow.blockIndex.get(`${state.transcriptAnchor.kind}:${state.transcriptAnchor.messageIndex}`);
				if (anchorBlock) {
					const lineOffset = Math.min(state.transcriptAnchor.lineOffset, Math.max(0, anchorBlock.end - anchorBlock.start - 1));
					nextOffset = flow.total - (anchorBlock.start + lineOffset) - layout.scrollback.height;
				}
			}
			state.transcriptMaxOffset = Math.max(0, flow.total - layout.scrollback.height);
			state.transcriptOffset = Math.max(0, Math.min(nextOffset, state.transcriptMaxOffset));
			if (state.transcriptOffset === 0) {
				state.transcriptFollowTail = true;
				state.transcriptAnchor = undefined;
			}
			state.transcriptContentLength = flow.total;
			state.transcriptViewportLength = layout.scrollback.height;
			const visibleEnd = Math.max(0, flow.total - state.transcriptOffset);
			const sliceStart = Math.max(0, visibleEnd - layout.scrollback.height);
			const visible = this.#flowSlice(flow, sliceStart, visibleEnd);
			// Ranges are ordered by start row: skip what is above the window and stop
			// once past it, so hit-testing is O(visible tools).
			for (const range of flow.toolRanges || []) {
				if (range.end <= sliceStart) continue;
				if (range.start >= visibleEnd) break;
				const start = Math.max(range.start, sliceStart), end = Math.min(range.end, visibleEnd);
				if (end <= start) continue;
				state.mouseZones.push({ key: `inline:${range.id}`, action: "inline-tool", toolId: range.id, x: shell.center.x + layout.scrollback.x, y: layout.scrollback.y + start - sliceStart, width: transcriptWidth, height: end - start, footerY: layout.scrollback.y + range.end - 1 - sliceStart });
			}
			if (!state.transcriptFollowTail) {
				const topBlock = this.#blockContaining(flow.blocks, sliceStart);
				state.transcriptAnchor = topBlock ? {
					messageIndex: topBlock.messageIndex,
					kind: topBlock.kind,
					lineOffset: Math.max(0, sliceStart - topBlock.start),
				} : undefined;
			}
			// Short conversations start directly below the status bar.  Only long
			// conversations follow the tail; do not bottom-align an otherwise empty
			// transcript above the composer.
			while (visible.length < layout.scrollback.height) visible.push("");
			for (let row = 0; row < visible.length; row++) {
				center[layout.scrollback.y + row] = compositeTuiLine(
					center[layout.scrollback.y + row],
					pad(visible[row], transcriptWidth),
					layout.scrollback.x,
					transcriptWidth,
					centerWidth,
				);
			}

			const turnBlocks = flow.userBlocks;
			const activeTurnIndex = this.#lastBlockIndexStartingAtOrBefore(turnBlocks, sliceStart);
			const activeTurn = Math.max(0, activeTurnIndex);
			const timeline = timelineCandidate
				? computeTimelineRail({
					area: layout.scrollback,
					terminalWidth: layout.scrollback.width,
					turnCount: turnBlocks.length,
					activeTurn,
				})
				: undefined;
			if (timeline) {
				state.transcriptScrollbar = undefined;
				const railX = timeline.x;
				const offsetForTurn = (turn) => {
					const block = turnBlocks[turn];
					return Math.max(0, Math.min(
						state.transcriptMaxOffset,
						flow.total - block.start - layout.scrollback.height,
					));
				};
				const paintRail = (y, glyph, active = false) => {
					if (y < layout.scrollback.y || y >= layout.scrollback.y + layout.scrollback.height) return;
					center[y] = compositeTuiLine(center[y], active ? color.accent(glyph) : color.dim(glyph), railX, 2, centerWidth);
				};
				paintRail(timeline.upY, activeTurn > 0 ? " ↑" : " ·");
				if (activeTurn > 0) {
					state.mouseZones.push({
						key: "timeline:up",
						x: shell.center.x + railX,
						y: timeline.upY,
						width: 2,
						height: 1,
						action: "timeline-turn",
						offset: offsetForTurn(activeTurn - 1),
					});
				}
				for (let turn = timeline.start; turn < timeline.end; turn++) {
					const y = timeline.ticksY + turn - timeline.start;
					paintRail(y, turn === timeline.active ? " ◆" : " ·", turn === timeline.active);
					state.mouseZones.push({
						key: `timeline:${turn}`,
						x: shell.center.x + railX,
						y,
						width: 2,
						height: 1,
						action: "timeline-turn",
						offset: offsetForTurn(turn),
					});
				}
				paintRail(timeline.downY, activeTurn < turnBlocks.length - 1 ? " ↓" : " ·");
				if (activeTurn < turnBlocks.length - 1) {
					state.mouseZones.push({
						key: "timeline:down",
						x: shell.center.x + railX,
						y: timeline.downY,
						width: 2,
						height: 1,
						action: "timeline-turn",
						offset: offsetForTurn(activeTurn + 1),
					});
				}
			} else {
				const scrollbar = scrollbarMetrics({
					contentLength: flow.total,
					viewportLength: layout.scrollback.height,
					offset: state.transcriptOffset,
					trackLength: layout.scrollback.height,
					minThumbLength: state.touchMode ? 4 : 3,
				});
				const scrollbarX = layout.scrollback.x + layout.scrollback.width - 1;
				if (scrollbar.overflow) {
					state.transcriptScrollbar = {
						x: shell.center.x + scrollbarX,
						y: layout.scrollback.y,
						height: layout.scrollback.height,
						metrics: scrollbar,
					};
					for (let row = 0; row < layout.scrollback.height; row++) {
						const thumb = row >= scrollbar.thumbStart && row < scrollbar.thumbStart + scrollbar.thumbLength;
						center[layout.scrollback.y + row] = compositeTuiLine(
							center[layout.scrollback.y + row],
							thumb ? color.accent("┃") : color.dim("│"),
							scrollbarX,
							1,
							centerWidth,
						);
					}
					state.mouseZones.push({
						key: "scrollbar:transcript",
						x: state.transcriptScrollbar.x,
						y: state.transcriptScrollbar.y,
						width: 1,
						height: state.transcriptScrollbar.height,
						action: "transcript-scrollbar",
					});
				} else {
					state.transcriptScrollbar = undefined;
				}
			}

			if (layout.turnStatus.height) {
				const status = this.#grokTurnStatus(layout.turnStatus.width);
				place(layout.turnStatus, [status.line]);
				if (status.stopX != null) {
					state.mouseZones.push({
						key: "turn:abort",
						x: shell.center.x + layout.turnStatus.x + status.stopX,
						y: layout.turnStatus.y,
						width: status.stopWidth,
						height: 1,
						action: "abort",
					});
				}
			}
			if (layout.dock.height) {
				place(layout.dock, dock.map((row) => row.text));
				for (let index = 0; index < Math.min(layout.dock.height, dock.length); index++) {
					if (!dock[index].action) continue;
					state.mouseZones.push({
						key: dock[index].key,
						x: shell.center.x + layout.dock.x,
						y: layout.dock.y + index,
						width: layout.dock.width,
						height: 1,
						action: dock[index].action,
					});
				}
			}
			place(layout.prompt, composer.lines);
			state.mouseZones.push({
				key: "prompt:composer",
				x: shell.center.x + layout.prompt.x,
				y: layout.prompt.y,
				width: layout.prompt.width,
				height: layout.prompt.height,
				action: "composer",
			});
			const metaY = layout.prompt.y + Math.min(layout.prompt.height - 1, composer.metaRow);
			if (composer.contextWidth > 0) state.mouseZones.push({
				key: "prompt:context",
				x: shell.center.x + layout.prompt.x + composer.contextX,
				y: metaY,
				width: composer.contextWidth,
				height: 1,
				action: "status",
			});
			if (composer.providerWidth > 0) {
				state.mouseZones.push({
					key: "prompt:provider",
					x: shell.center.x + layout.prompt.x + composer.providerX,
					y: metaY,
					width: composer.providerWidth,
					height: 1,
					action: "provider",
				});
			}
			if (composer.modelWidth > 0) state.mouseZones.push({ key: "prompt:model", x: shell.center.x + layout.prompt.x + composer.modelX, y: metaY, width: composer.modelWidth, height: 1, action: "model" });
			if (composer.modeWidth > 0) {
				state.mouseZones.push({
					key: "prompt:mode",
					x: shell.center.x + layout.prompt.x + composer.modeX,
					y: metaY,
					width: composer.modeWidth,
					height: 1,
					action: "mode",
				});
			}
			if (layout.shortcuts.height) {
				const hint = layout.compact ? t("footer.sessionShort", { panels: t("footer.filesPanels") }) : t("footer.session");
				place(layout.shortcuts, [this.#shortcutHint(hint)]);
			}

			const joinRow = (row) => {
				const leftLine = shell.left.width ? left[row] : "";
				const rightLine = shell.right.width ? right[row] : "";
				return `${leftLine}${shell.left.width ? color.border("│") : ""}${center[row] || pad("", centerWidth)}${shell.right.width ? color.border("│") : ""}${rightLine}`;
			};
			let screen = Array.from({ length: height }, (_unused, row) => joinRow(row));
			screen = this.#drawPanelOverlay(screen, width, height);
			return this.#drawDialog(screen.slice(0, height), width, height);
		}

		render(width) {
			const height = Math.max(1, tui.terminal.rows);
			// TuiAltScreen applies its selection after this method returns. Clearing
			// here closes the race where a coalesced mouse report recreates selection
			// after the dialog input handler already cleared it.
			if (state.dialog) clearTerminalSelection();
			if ((state.lastTerminalWidth && state.lastTerminalWidth !== width) ||
				(state.lastTerminalHeight && state.lastTerminalHeight !== height)) {
				// A software keyboard commonly changes rows while a pointer button is
				// still logically down. Never carry that gesture across a reflow.
				state.pointer.cancel();
				state.transcriptScrollbarDrag = undefined;
				state.panelScrollbarDrag = undefined;
				state.hoveredZoneKey = undefined;
			}
			state.lastTerminalWidth = width;
			state.lastTerminalHeight = height;
			state.mouseZones = [];
			const screen = state.active ? this.#session(width, height) : this.#home(width, height);
			// A component row must never move the terminal to another physical row.
			// Structured multiline content is wrapped above; this guard also covers
			// extension titles/metadata and preserves the editor's cursor marker.
			return screen.map((line) => paintRow(line, width));
		}
	}

	const root = new TsukuyomiRoot();
	tui.setLayoutRoot(root);
	tui.setFocus(editor);
	const restoreSessionItem = (item) => {
		if (!item) return;
		if (item.path === state.sessionFile) { toast(t("toast.alreadySession"), "info"); clearDialog(); return; }
		toast(t("toast.restoring", { name: item.name || t("session.empty") }), "info");
		clearDialog();
		setTimeout(() => shutdown(0, { session: item.path, workspace: item.cwd }), 180);
	};
	const confirmTrashSession = (dialog) => {
		const item = dialog.visibleItems?.[dialog.selected];
		if (!item || item.path === state.sessionFile) { toast(t("session.cannotDeleteCurrent"), "warning"); return; }
		const browser = { ...dialog };
		openLocalSelect({
			title: t("session.deleteTitle"), message: t("session.deleteMessage", { name: item.name || t("session.empty") }),
			kind: "confirm", options: [t("action.yes"), t("action.no")], onResolve: async (result) => {
				if (result?.confirmed) {
					try { await trashSession(sessionsRoot(), item.path); browser.items = await scanSessionCatalog(sessionsRoot(), { cwd, limit: 500 }); toast(t("session.deleted"), "info"); }
					catch (error) { toast(error?.message || String(error), "error"); }
				}
				browser.selected = Math.max(0, Math.min(browser.selected, browser.items.length - 1));
				clearTerminalSelection();
				replaceDialog(browser); tui.requestRender();
			},
		});
	};

	const handleDialogKey = (data) => {
		const dialog = state.dialog;
		if (!dialog) return false;
		// Filtering replaces dialog rows while the user types. Any previous drag
		// selection belongs to the old row coordinates.
		clearTerminalSelection();
		if (dialog.kind === "sessions") {
			if (matchesKey(data, "escape")) {
				if (dialog.query) dialog.query = ""; else finishDialog({ cancelled: true });
				tui.requestRender(); return true;
			}
			if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) dialog.selected = Math.max(0, dialog.selected - 1);
			else if (matchesKey(data, "down")) dialog.selected = Math.min(Math.max(0, (dialog.visibleItems?.length || 1) - 1), dialog.selected + 1);
			else if (matchesKey(data, "pageUp")) dialog.selected = Math.max(0, dialog.selected - Math.max(3, tui.terminal.rows - 8));
			else if (matchesKey(data, "pageDown")) dialog.selected = Math.min(Math.max(0, (dialog.visibleItems?.length || 1) - 1), dialog.selected + Math.max(3, tui.terminal.rows - 8));
			else if (matchesKey(data, "tab")) { dialog.currentOnly = !dialog.currentOnly; dialog.selected = 0; }
			else if (matchesKey(data, "backspace")) { dialog.query = [...dialog.query].slice(0, -1).join(""); dialog.selected = 0; }
			else if (matchesKey(data, "ctrl+u")) { dialog.query = ""; dialog.selected = 0; }
			else if (matchesKey(data, "delete")) confirmTrashSession(dialog);
			else if (matchesKey(data, "enter")) restoreSessionItem(dialog.visibleItems?.[dialog.selected]);
			else if (!data.includes("\x1b") && !/[\u0000-\u001f\u007f]/.test(data)) { dialog.query += data; dialog.selected = 0; }
			tui.requestRender(); return true;
		}
		if (dialog.kind === "plan-review" && dialog.planSession) {
			const session = dialog.planSession;
			const command = matchesKey(data, "escape") ? "cancel"
				: matchesKey(data, "tab") ? "tab"
				: matchesKey(data, "shift+tab") ? "shift-tab"
				: matchesKey(data, "up") ? "up"
				: matchesKey(data, "down") ? "down"
				: matchesKey(data, "left") ? "left"
				: matchesKey(data, "right") ? "right"
				: matchesKey(data, "enter") ? (session.annotating ? "submit" : "enter")
				: matchesKey(data, "pageUp") || data === "g" ? "top"
				: matchesKey(data, "pageDown") || data === "G" ? "bottom"
				: data === "d" ? "delete"
				: data === "u" ? "undo"
				: data === "a" ? "annotate"
				: data === "c" ? "copy"
				: data === "e" ? "editor"
				: session.annotating && matchesKey(data, "backspace") ? "backspace"
				: session.annotating && !data.includes("\x1b") && !/[\u0000-\u001f\u007f]/.test(data) ? "type"
				: "";
			if (command) {
				const effect = planCommand(session, command, command === "submit" ? session.draft : data);
				if (effect === "confirm") finishDialog({ value: planResult(session) });
				else if (effect === "cancel") finishDialog({ cancelled: true });
				else if (effect === "copy") { try { terminal.write(`\x1b]52;c;${Buffer.from(joinPlan(session)).toString("base64")}\x07`); } catch {} toast(locale === "zh" ? "方案已复制" : "Plan copied", "info"); }
				else if (effect === "editor") {
					const program = process.env.VISUAL || process.env.EDITOR;
					if (!program) toast(locale === "zh" ? "未设置 EDITOR" : "EDITOR is not set", "warning");
					else {
						const file = join(tmpdir(), `tsukuyomi-plan-${Date.now()}.md`);
						writeFileSync(file, joinPlan(session));
						tui.stop();
						const child = spawn(program, [file], { stdio: "inherit" });
						child.on("exit", () => {
							try {
								const next = createPlanSession({ body: readFileSync(file, "utf8"), options: session.options, slider: session.slider });
								next.sliderIndex = session.sliderIndex; next.focus = session.focus;
								dialog.planSession = next;
							} catch {}
							tui.start();
							tui.requestRender();
						});
					}
				}
			}
			tui.requestRender(); return true;
		}
		if (dialog.kind === "ask" && dialog.askSession) {
			const session = dialog.askSession;
			const command = matchesKey(data, "escape") ? "cancel" : matchesKey(data, "tab") || matchesKey(data, "right") ? "tab" : matchesKey(data, "shift+tab") || matchesKey(data, "left") ? "shift-tab" : matchesKey(data, "up") ? "up" : matchesKey(data, "down") ? "down" : matchesKey(data, "enter") ? "enter" : data === " " ? "space" : data === "n" ? "note" : "";
			if (!command) return true;
			const effect = askCommand(session, command);
			if (effect === "submit") finishDialog({ value: askResult(session) });
			else if (effect === "cancel") finishDialog({ cancelled: true });
			else if (effect === "prompt") openLocalInput({ title: session.prompt === "note" ? "Note" : "Other", onResolve: (result) => { if (result?.cancelled) askCommand(session, "cancel"); else askCommand(session, "submit", result?.value || ""); tui.requestRender(); } });
			else tui.requestRender();
			return true;
		}
		if (dialog.kind === "ask" && matchesKey(data, "enter")) {
			if (!dialog.options.length) return true;
			finishDialog({ value: dialog.options[dialog.selected] });
			return true;
		}
		if (dialog.kind === "hub" && matchesKey(data, "tab")) {
			dialog.hubInspector = !dialog.hubInspector;
			dialog.hubDetailOffset = 0;
			tui.requestRender();
			return true;
		}
		if (dialog.kind === "hub" && matchesKey(data, "escape") && dialog.hubInspector && (tui.terminal.columns || 0) < 94) {
			dialog.hubInspector = false;
			tui.requestRender();
			return true;
		}
		if (dialog.kind === "hub" && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
			dialog.hubDetailOffset = Math.max(0, Math.min(dialog.hubDetailMax || 0, (dialog.hubDetailOffset || 0) + (matchesKey(data, "pageDown") ? 5 : -5)));
			tui.requestRender();
			return true;
		}
		if (dialog.kind === "settings") {
			const count = dialog.items?.length || 0;
			if (matchesKey(data, "escape")) { finishDialog({ cancelled: true }); return true; }
			if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) { dialog.activeTab = (dialog.activeTab - 1 + settingsGroups().length) % settingsGroups().length; dialog.selected = 0; refreshSettingsRows(); }
			else if (matchesKey(data, "right") || matchesKey(data, "tab")) { dialog.activeTab = (dialog.activeTab + 1) % settingsGroups().length; dialog.selected = 0; refreshSettingsRows(); }
			else if (count === 0) return true;
			else if (matchesKey(data, "up")) dialog.selected = (dialog.selected - 1 + count) % count;
			else if (matchesKey(data, "down")) dialog.selected = (dialog.selected + 1) % count;
			else if (matchesKey(data, "home")) dialog.selected = 0;
			else if (matchesKey(data, "end")) dialog.selected = count - 1;
			else {
				const item = dialog.items[dialog.selected];
				if (item && (matchesKey(data, "enter") || data === " ")) runSettingsAction(item.id);
			}
			tui.requestRender(); return true;
		}
		if (dialog.setupWizard && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
			dialog.setupTab = (dialog.setupTab + (matchesKey(data, "tab") ? 1 : -1) + dialog.setupTabs.length) % dialog.setupTabs.length;
			const tab = dialog.setupTabs[dialog.setupTab];
			dialog.query = "";
			dialog.allOptions = [...tab.options];
			dialog.options = [...tab.options];
			dialog.descriptions = tab.descriptions;
			dialog.sections = tab.sections;
			dialog.selected = Math.max(0, Math.min(tab.options.length - 1, tab.selected || 0));
			tui.requestRender(); return true;
		}
		if (dialog.setupWizard && (matchesKey(data, "home") || matchesKey(data, "end") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
			const count = dialog.options?.length || 0;
			if (!count) return true;
			if (matchesKey(data, "home")) dialog.selected = 0;
			else if (matchesKey(data, "end")) dialog.selected = count - 1;
			else {
				const page = Math.max(1, (dialog.setupPageSize || 10) - 2);
				const direction = matchesKey(data, "pageDown") ? 1 : -1;
				dialog.selected = Math.max(0, Math.min(count - 1, dialog.selected + direction * page));
			}
			tui.requestRender(); return true;
		}
		if (dialog.searchable && matchesKey(data, "escape") && dialog.query) {
			dialog.query = ""; dialog.options = filterSelectOptions(dialog.allOptions, dialog.descriptions, dialog.query); dialog.selected = 0; tui.requestRender(); return true;
		}
		if (matchesKey(data, "escape")) {
			finishDialog({ cancelled: true });
			return true;
		}
		if (dialog.kind === "input" || dialog.kind === "editor") return false;
		if (dialog.structured && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
			dialog.previewOffset = Math.max(0, Math.min(dialog.previewMaxOffset || 0, (dialog.previewOffset || 0) + (matchesKey(data, "pageDown") ? 5 : -5)));
			tui.requestRender(); return true;
		}
		if (dialog.searchable && matchesKey(data, "backspace")) {
			dialog.query = [...dialog.query].slice(0, -1).join("");
			dialog.options = filterSelectOptions(dialog.allOptions, dialog.descriptions, dialog.query); dialog.selected = 0; tui.requestRender(); return true;
		}
		if (dialog.searchable && !data.includes("\x1b") && !/[\u0000-\u001f\u007f]/.test(data)) {
			dialog.query += data; dialog.options = filterSelectOptions(dialog.allOptions, dialog.descriptions, dialog.query); dialog.selected = 0; tui.requestRender(); return true;
		}
		if (dialog.kind === "status") {
			if (matchesKey(data, "up") || matchesKey(data, "pageUp")) {
				dialog.statusOffset = Math.max(0, (dialog.statusOffset || 0) - 3);
				tui.requestRender();
			}
			if (matchesKey(data, "down") || matchesKey(data, "pageDown")) {
				dialog.statusOffset = Math.min(dialog.statusMaxOffset || 0, (dialog.statusOffset || 0) + 3);
				tui.requestRender();
			}
			return true;
		}
		if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
			if (!dialog.options.length) return true;
			dialog.selected = (dialog.selected - 1 + dialog.options.length) % dialog.options.length;
			tui.requestRender(); return true;
		}
		if (matchesKey(data, "down") || matchesKey(data, "tab")) {
			if (!dialog.options.length) return true;
			dialog.selected = (dialog.selected + 1) % dialog.options.length;
			tui.requestRender(); return true;
		}
		if (dialog.kind === "multi") {
			const option = dialog.options[dialog.selected];
			if (matchesKey(data, "enter") || data === " ") toggleDialogOption(option);
			return true;
		}
		if (matchesKey(data, "enter")) {
			if (!dialog.options.length) return true;
			const value = dialog.options[dialog.selected];
			finishDialog(dialog.kind === "confirm" ? { confirmed: value === dialog.options[0] } : { value, ...(dialog.setupWizard ? { setupTab: dialog.setupTab } : {}) });
			return true;
		}
		return true;
	};

	const handleDialogMouse = (mouse) => {
		const dialog = state.dialog;
		if (!dialog) return false;
		if (dialog.setupWizard) {
			const tab = dialog.setupMouseTabs?.find((entry) => mouse.y === entry.y && mouse.x >= entry.x && mouse.x < entry.x + entry.width);
			const row = dialog.mouseRows?.find((entry) => entry.y === mouse.y);
			const switchTab = (index) => {
				dialog.setupTab = index;
				const selectedTab = dialog.setupTabs[index];
				dialog.query = "";
				dialog.allOptions = [...selectedTab.options];
				dialog.options = [...selectedTab.options];
				dialog.descriptions = selectedTab.descriptions;
				dialog.sections = selectedTab.sections;
				dialog.selected = Math.max(0, Math.min(selectedTab.options.length - 1, selectedTab.selected || 0));
			};
			if (mouse.wheel && !mouse.release) { dialog.selected = Math.max(0, Math.min(Math.max(0, dialog.options.length - 1), dialog.selected + mouse.wheelDirection * 3)); tui.requestRender(); return true; }
			if (mouse.motion) {
				if (tab && tab.index !== dialog.setupTab) { switchTab(tab.index); tui.requestRender(); }
				else if (row && row.index !== dialog.selected) { dialog.selected = row.index; tui.requestRender(); }
				return true;
			}
			if (mouse.release || !mouse.left) return true;
			if (tab) { switchTab(tab.index); tui.requestRender(); return true; }
			if (row) { dialog.selected = row.index; finishDialog({ value: dialog.options[row.index], setupTab: dialog.setupTab }); }
			return true;
		}
		if (dialog.kind === "ask" && dialog.askSession) {
			if (mouse.wheel && !mouse.release) { askCommand(dialog.askSession, mouse.wheelDirection > 0 ? "tab" : "shift-tab"); tui.requestRender(); return true; }
			if (mouse.motion || mouse.release || !mouse.left) return true;
			const row = dialog.mouseRows?.find((entry) => entry.y === mouse.y);
			if (row && dialog.askSession.questions[dialog.askSession.tab]) dialog.askSession.questions[dialog.askSession.tab].cursor = row.index;
			const effect = askCommand(dialog.askSession, "enter");
			if (effect === "submit") finishDialog({ value: askResult(dialog.askSession) });
			else if (effect === "prompt") openLocalInput({ title: "Other", onResolve: (result) => { if (!result?.cancelled) askCommand(dialog.askSession, "submit", result?.value || ""); tui.requestRender(); } });
			tui.requestRender(); return true;
		}
		if (dialog.kind === "plan-review") {
			if (mouse.wheel && !mouse.release) { if (dialog.planSession) planCommand(dialog.planSession, "scroll", mouse.wheelDirection * 3); tui.requestRender(); return true; }
			if (mouse.motion || mouse.release || !mouse.left) return true;
			const row = dialog.mouseRows?.find((entry) => entry.y === mouse.y);
			if (row?.action === "plan-option") { dialog.planFocus = "actions"; dialog.selected = row.index; finishDialog({ value: dialog.options[row.index] }); }
			else if (row?.action === "plan-body") dialog.planFocus = "body";
			tui.requestRender(); return true;
		}
		if (dialog.kind === "sessions") {
			if (mouse.wheel && !mouse.release) { dialog.selected = Math.max(0, Math.min(Math.max(0, (dialog.visibleItems?.length || 1) - 1), dialog.selected + mouse.wheelDirection * 3)); tui.requestRender(); return true; }
			if (mouse.motion || mouse.release || !mouse.left) return true;
			if (dialog.mouseClose && mouse.x >= dialog.mouseClose.x && mouse.x < dialog.mouseClose.x + dialog.mouseClose.width && mouse.y === 0) { finishDialog({ cancelled: true }); return true; }
			const row = dialog.mouseRows?.find((entry) => entry.y === mouse.y);
			if (row) { dialog.selected = row.index; restoreSessionItem(dialog.visibleItems?.[row.index]); }
			return true;
		}
		if (dialog.kind === "settings") {
			const count = dialog.items?.length || 0;
			if (mouse.wheel && !mouse.release) { dialog.selected = Math.max(0, Math.min(Math.max(0, count - 1), dialog.selected + mouse.wheelDirection * 2)); tui.requestRender(); return true; }
			const tab = mouse.y === 1 ? dialog.mouseTabs?.find((entry) => mouse.x >= entry.x && mouse.x < entry.x + entry.width) : undefined;
			const row = dialog.mouseRows?.find((entry) => entry.y === mouse.y);
			if (mouse.motion) {
				if (tab && dialog.activeTab !== tab.index) { dialog.activeTab = tab.index; dialog.selected = 0; refreshSettingsRows(); tui.requestRender(); }
				else if (row && dialog.selected !== row.index) { dialog.selected = row.index; tui.requestRender(); }
				return true;
			}
			if (mouse.release || !mouse.left) return true;
			if (dialog.mouseClose && mouse.x >= dialog.mouseClose.x && mouse.x < dialog.mouseClose.x + dialog.mouseClose.width && mouse.y === dialog.mouseClose.y) { finishDialog({ cancelled: true }); return true; }
			if (tab) { dialog.activeTab = tab.index; dialog.selected = 0; refreshSettingsRows(); tui.requestRender(); return true; }
			if (row) { const item = dialog.items?.[row.index]; dialog.selected = row.index; if (item) runSettingsAction(item.id); }
			return true;
		}
		if (mouse.wheel && !mouse.release) {
			const inline = state.mouseZones.find((zone) => zone.action === "inline-tool" && mouse.x >= zone.x && mouse.x < zone.x + zone.width && mouse.y >= zone.y && mouse.y < zone.y + zone.height);
			if (inline) { state.liveTools.get(inline.toolId)?.scroll(-mouse.wheelDirection * 3); state.dirtyToolIds.add(inline.toolId); state.workflowRevision++; tui.requestRender(); return true; }
			if (dialog.kind === "status") {
				dialog.statusOffset = Math.max(0, Math.min(dialog.statusMaxOffset || 0, (dialog.statusOffset || 0) + mouse.wheelDirection * 3));
				tui.requestRender();
				return true;
			}
			dialog.selected = Math.max(0, Math.min(Math.max(0, dialog.options.length - 1), dialog.selected + mouse.wheelDirection));
			tui.requestRender();
			return true;
		}
		const onClose = dialog.mouseClose && mouse.x >= dialog.mouseClose.x && mouse.x < dialog.mouseClose.x + dialog.mouseClose.width &&
			mouse.y >= dialog.mouseClose.y && mouse.y < dialog.mouseClose.y + dialog.mouseClose.height;
		if (mouse.motion) {
			if (dialog.closeHovered !== Boolean(onClose)) {
				dialog.closeHovered = Boolean(onClose);
				tui.requestRender();
			}
			return true;
		}
		if (!mouse.left || mouse.release) return true;
		if (onClose) {
			finishDialog({ cancelled: true });
			return true;
		}
		if (dialog.mouseBox && (mouse.x < dialog.mouseBox.x || mouse.x >= dialog.mouseBox.x + dialog.mouseBox.width ||
			mouse.y < dialog.mouseBox.y || mouse.y >= dialog.mouseBox.y + dialog.mouseBox.height)) {
			finishDialog({ cancelled: true });
			return true;
		}
		const row = dialog.mouseRows?.find((item) => item.y === mouse.y);
		if (row && dialog.mouseBox && mouse.x >= dialog.mouseBox.x && mouse.x < dialog.mouseBox.x + dialog.mouseBox.width) {
			dialog.selected = row.index;
			const value = dialog.options[row.index];
			if (dialog.kind === "multi") toggleDialogOption(value);
			else finishDialog(dialog.kind === "confirm" ? { confirmed: value === dialog.options[0] } : { value });
		}
		return true;
	};

	const updateTranscriptFromScrollbar = (mouse, grabOffset) => {
		const bar = state.transcriptScrollbar;
		if (!bar?.metrics?.overflow) return false;
		const localRow = mouse.y - bar.y;
		setTranscriptOffset(scrollbarOffsetFromPointer(bar.metrics, localRow, grabOffset));
		return true;
	};

	const panelScrollKey = (panel) => panel === "files"
		? "fileScroll"
		: panel === "todo" ? "todoScroll" : "workflowScroll";

	const panelAtPoint = (mouse) => [...state.panelScrollbars.values()].reverse().find((bar) =>
		mouse.x >= bar.originX && mouse.x < bar.originX + bar.panelWidth &&
		mouse.y >= bar.originY && mouse.y < bar.originY + bar.panelHeight,
	)?.panel;

	const setPanelScroll = (panel, value) => {
		const bar = state.panelScrollbars.get(panel);
		if (!bar) return false;
		const key = panelScrollKey(panel);
		state[key] = Math.max(0, Math.min(bar.maxScroll, Math.floor(Number(value) || 0)));
		if (panel === "workflow") state.workflowFollowTail = state[key] >= bar.maxScroll;
		return true;
	};

	const updatePanelFromScrollbar = (mouse, drag) => {
		const bar = state.panelScrollbars.get(drag?.panel);
		if (!bar?.metrics?.overflow) return false;
		const localRow = mouse.y - bar.y;
		const bottomOffset = scrollbarOffsetFromPointer(bar.metrics, localRow, drag.grabOffset);
		return setPanelScroll(drag.panel, bar.maxScroll - bottomOffset);
	};

	const findMouseZone = (mouse) => [...state.mouseZones].reverse().find((candidate) =>
		mouse.x >= candidate.x && mouse.x < candidate.x + candidate.width &&
		mouse.y >= candidate.y && mouse.y < candidate.y + candidate.height,
	);

	const handleMouse = (mouse) => {
		// The app owns every control/composer gesture. Only an explicitly started
		// transcript gesture is allowed to fall through to TuiAltScreen's text
		// selector; this is what prevents touch taps from becoming drag selections.
		if (state.dialog) {
			if (!mouse.release && !mouse.motion && mouse.left) state.pointer.press("dialog", mouse.button);
			if (mouse.release) state.pointer.release(mouse.button);
			return handleDialogMouse(mouse);
		}
		if (mouse.middle && !mouse.release && !mouse.motion) {
			state.pointer.press("paste", mouse.button);
			if (!state.primaryPastePending) {
				state.primaryPastePending = true;
				void readPrimarySelection()
					.then((value) => {
						if (value) editor.insertTextAtCursor(value);
						tui.requestRender();
					})
					.catch((error) => toast(t("toast.primaryPaste", { reason: error.message || error }), "warning", 5_000))
					.finally(() => { state.primaryPastePending = false; state.pointer.cancel(); });
			}
			return true;
		}
		if (mouse.wheel && !mouse.release) {
			const queueZone = state.mouseZones.find((zone) => zone.action === "dock-queue" &&
				mouse.x >= zone.x && mouse.x < zone.x + zone.width && mouse.y >= zone.y && mouse.y < zone.y + zone.height);
			if (queueZone) {
				state.queueScroll = Math.max(0, Math.min(state.queueMaxScroll || 0, (state.queueScroll || 0) + mouse.wheelDirection * 2));
				tui.requestRender();
				return true;
			}
			const panel = panelAtPoint(mouse);
			if (panel) {
				const key = panelScrollKey(panel);
				setPanelScroll(panel, state[key] + mouse.wheelDirection * 3);
			} else if (!state.panelOverlay) {
				setTranscriptOffset(state.transcriptOffset - mouse.wheelDirection * 4);
			}
			tui.requestRender();
			return true;
		}

		if (state.pointer.isActive()) {
			const owner = state.pointer.owner;
			if (owner === "transcript-scrollbar") {
				const drag = state.transcriptScrollbarDrag;
				if (drag && state.pointer.matchesButton(mouse.button) && (mouse.motion || mouse.release)) {
					updateTranscriptFromScrollbar(mouse, drag.grabOffset);
					tui.requestRender();
				}
				if (mouse.release && state.pointer.matchesButton(mouse.button)) {
					state.pointer.release(mouse.button);
					state.transcriptScrollbarDrag = undefined;
				}
				return true;
			}
			if (owner === "panel-scrollbar") {
				const drag = state.panelScrollbarDrag;
				if (drag && state.pointer.matchesButton(mouse.button) && (mouse.motion || mouse.release)) {
					updatePanelFromScrollbar(mouse, drag);
					tui.requestRender();
				}
				if (mouse.release && state.pointer.matchesButton(mouse.button)) {
					state.pointer.release(mouse.button);
					state.panelScrollbarDrag = undefined;
				}
				return true;
			}
			if (mouse.release) state.pointer.release(mouse.button);
			if (owner === "transcript") return false;
			return true;
		}
		if (mouse.motion) {
			const zone = findMouseZone(mouse);
			const nextKey = zone?.key;
			if (state.hoveredZoneKey !== nextKey) {
				state.hoveredZoneKey = nextKey;
				tui.requestRender();
			}
			return state.touchMode || Boolean(zone) || Boolean(panelAtPoint(mouse));
		}
		if (!mouse.left) return state.touchMode;

		const zone = findMouseZone(mouse) || (panelAtPoint(mouse)
			? { action: "panel-body", panel: panelAtPoint(mouse) }
			: undefined);
		if (!zone) {
			if (state.touchMode) {
				state.pointer.press("touch", mouse.button);
				return true;
			}
			state.pointer.press("transcript", mouse.button);
			return false;
		}

		state.pointer.press(zone.action, mouse.button);
		switch (zone.action) {
			case "transcript-scrollbar": {
				const bar = state.transcriptScrollbar;
				const localRow = mouse.y - (bar?.y || 0);
				const metrics = bar?.metrics;
				const onThumb = Boolean(metrics?.overflow) &&
					localRow >= metrics.thumbStart && localRow < metrics.thumbStart + metrics.thumbLength;
				const grabOffset = onThumb ? localRow - metrics.thumbStart : (metrics?.thumbLength || 1) / 2;
				state.transcriptScrollbarDrag = { grabOffset };
				updateTranscriptFromScrollbar(mouse, grabOffset);
				break;
			}
			case "panel-scrollbar": {
				const bar = state.panelScrollbars.get(zone.panel);
				const localRow = mouse.y - (bar?.y || 0);
				const metrics = bar?.metrics;
				const onThumb = Boolean(metrics?.overflow) &&
					localRow >= metrics.thumbStart && localRow < metrics.thumbStart + metrics.thumbLength;
				const grabOffset = onThumb ? localRow - metrics.thumbStart : (metrics?.thumbLength || 1) / 2;
				state.panelScrollbarDrag = { panel: zone.panel, grabOffset };
				updatePanelFromScrollbar(mouse, state.panelScrollbarDrag);
				break;
			}
			case "hide-files":
				state.showFiles = false;
				if (state.panelOverlay === "files") state.panelOverlay = undefined;
				break;
			case "hide-workflow":
				state.showWorkflow = false;
				if (state.panelOverlay === "workflow") state.panelOverlay = undefined;
				break;
			case "hide-todos":
				state.showTodos = false;
				if (state.panelOverlay === "todo") state.panelOverlay = undefined;
				break;
			case "close-panel-overlay": state.panelOverlay = undefined; break;
			case "workflow-toggle":
				if (state.workflowExpanded.has(zone.itemId)) state.workflowExpanded.delete(zone.itemId);
				else state.workflowExpanded.add(zone.itemId);
				state.workflowFollowTail = false;
				break;
			case "dock-toggle": state.dockTasksExpanded = !state.dockTasksExpanded; break;
			case "dock-queue": {
				openLocalSelect({
					title: locale === "zh" ? "清空等待队列" : "Clear queued messages",
					message: locale === "zh" ? "Pi 仅支持清空整个队列，不能只移除一条。确定清空所有后续与纠正消息？" : "Pi can only clear the entire queue, not one entry. Remove all steering and follow-up messages?",
					kind: "confirm", options: [t("action.yes"), t("action.no")], selected: 1,
					onResolve: (result) => result?.confirmed && rpc.request({ type: "clear_queue" }, 10_000).catch((error) => toast(error?.message || String(error), "error")),
				});
				break;
			}
			case "timeline-turn": setTranscriptOffset(zone.offset); break;
			case "panel-body": break;
			case "composer": tui.setFocus(editor); break;
			case "abort": void rpc.request({ type: "abort" }, 30_000).catch(() => {}); break;
			case "inline-tool": {
				const tool = state.liveTools.get(zone.toolId);
				if (tool) {
					if (tool.details?.jobId && tool.details?.kind === "pty" && !tool.details?.endedAt && mouse.y === zone.footerY) {
						state.terminalJob = tool.details.jobId; tool.expanded = true;
						void taskClient.request("resize", { id: state.terminalJob, cols: Math.max(20, tui.terminal.columns - 12), rows: Math.max(8, Math.floor(tui.terminal.rows * 0.65)) }).catch(() => {});
						toast(locale === "zh" ? "终端输入已连接；Ctrl+] 返回聊天输入" : "Terminal attached; Ctrl+] returns to chat", "info");
					} else if (tool.offset) tool.offset = 0; else tool.expanded = !tool.expanded;
					state.dirtyToolIds.add(zone.toolId);
					state.workflowRevision++;
				}
				break;
			}
			case "mode": openModeSelector(); break;
			case "model": void openModelSelector().catch(() => {}); break;
			case "status": void openStatus(false); break;
			case "provider": void openProviderSelector().catch(() => {}); break;
			case "workspace": askShowFiles(); break;
			case "sessions": openSessionsDialog(); break;
			case "file":
				if (zone.item.dir) tree.toggle(zone.item.rel);
				else {
					const current = editor.getText();
					editor.setText(current.trim() ? `${current.replace(/\s+$/, "")} @${zone.item.rel} ` : `@${zone.item.rel} `);
				}
				break;
		}
		tui.requestRender();
		return true;
	};

	const inputListener = (data) => {
		// Application listeners run before pi's focused-component release guard.
		if (isKeyRelease(data)) return { consume: true };
		if (state.updating) return { consume: true };
		if (state.terminalJob && !parseSgrMouse(data) && data !== FOCUS_IN && data !== FOCUS_OUT) {
			if (matchesKey(data, "ctrl+]")) { state.terminalJob = undefined; tui.requestRender(); return { consume: true }; }
			let input = decodeKittyPrintable(data) ?? data;
			for (const [key, value] of [["enter", "\r"], ["backspace", "\x7f"], ["up", "\x1b[A"], ["down", "\x1b[B"], ["right", "\x1b[C"], ["left", "\x1b[D"], ["tab", "\t"], ["escape", "\x1b"], ["ctrl+c", "\x03"], ["ctrl+d", "\x04"]]) if (matchesKey(data, key)) input = value;
			void taskClient.request("input", { id: state.terminalJob, data: input }).catch((error) => { state.terminalJob = undefined; toast(error.message, "error"); });
			return { consume: true };
		}
		if (!state.dialog && keyMatches(data, "message.followUp")) {
			const value = editor.getText();
			if (value.trim()) { editor.setText(""); void runInput(value, "followUp"); }
			return { consume: true };
		}
		// Forced interject while a run is active (requires a terminal that can
		// distinguish ctrl+enter, e.g. Kitty/Ghostty/WezTerm). `/interrupt <text>`
		// is the portable equivalent.
		if (!state.dialog && keyMatches(data, "message.interrupt")) {
			const value = editor.getText();
			if (value.trim()) void interruptAndSend(value);
			return { consume: true };
		}
		if (data === FOCUS_OUT || data === FOCUS_IN) {
			state.pointer.cancel();
			state.transcriptScrollbarDrag = undefined;
			state.panelScrollbarDrag = undefined;
			state.hoveredZoneKey = undefined;
			// Leave focus reports for TuiAltScreen so it can also clear its
			// internal selection and auto-scroll state.
			return undefined;
		}
		const mouse = parseSgrMouse(data);
		// Some terminals can still send legacy X10 reports despite SGR mouse mode.
		// Consume reports the app cannot decode while a modal is open so pi-tui's
		// fullscreen selector cannot paint a range through dialog rows.
		if (state.dialog && !mouse && tui.isMouseSequence?.(data)) {
			clearTerminalSelection();
			return { consume: true };
		}
		if (mouse && handleMouse(mouse)) return { consume: true };
		if (editorInputFocused()) resetCursorBlink();
		if (handleDialogKey(data)) return { consume: true };
		if (matchesKey(data, "enter") && !state.active && !editor.getText()) {
			activate(); return { consume: true };
		}
		if (keyMatches(data, "palette.open")) { openPalette(); return { consume: true }; }
		if (keyMatches(data, "model.cycleForward")) { void cycleModel(1).catch(() => {}); return { consume: true }; }
		if (keyMatches(data, "model.cycleBackward")) { void cycleModel(-1).catch(() => {}); return { consume: true }; }
		if (keyMatches(data, "model.select")) { void openModelSelector().catch(() => {}); return { consume: true }; }
		if (keyMatches(data, "hub.open")) { openTeam(); return { consume: true }; }
		if (keyMatches(data, "sessions.open") && state.active) { void openSessionsDialog(); return { consume: true }; }
		if (keyMatches(data, "mode.toggle")) { void nextMode(); return { consume: true }; }
		if (keyMatches(data, "thinking.cycle")) { void cycleThinkingLevel().catch(() => {}); return { consume: true }; }
		if (keyMatches(data, "files.toggle")) {
			if (!state.workspaceDeclared) askShowFiles();
			else { activate(); togglePanel("files"); tui.requestRender(); }
			return { consume: true };
		}
		if (keyMatches(data, "workflow.toggle")) { activate(); togglePanel("workflow"); tui.requestRender(); return { consume: true }; }
		if (keyMatches(data, "todo.toggle")) { activate(); togglePanel("todo"); tui.requestRender(); return { consume: true }; }
		if (keyMatches(data, "thinking.toggle") && state.active) {
			const index = state.messages.findLastIndex((message) => message?.role === "assistant" && message.content?.some?.((part) => part.type === "thinking"));
			if (index >= 0) {
				if (state.thinkingExpanded.has(index)) state.thinkingExpanded.delete(index); else state.thinkingExpanded.add(index);
				tui.requestRender();
			}
			return { consume: true };
		}
		if (keyMatches(data, "tools.expand") && state.active) {
			const index = state.messages.findLastIndex((message) => message?.role === "assistant" && message.content?.some?.((part) => part.type === "toolCall"));
			if (index >= 0) {
				for (const part of state.messages[index]?.content || []) if (part?.type === "toolCall") {
					const id = part.id || part.toolCallId;
					if (!id) continue;
					if (state.inlineDiffExpanded.has(id)) state.inlineDiffExpanded.delete(id); else state.inlineDiffExpanded.add(id);
					const tool = state.liveTools.get(id);
					if (tool) { tool.expanded = !tool.expanded; state.dirtyToolIds.add(id); }
				}
				tui.requestRender();
			}
			return { consume: true };
		}
		if (matchesKey(data, "pageUp")) {
			setTranscriptOffset(state.transcriptOffset + Math.max(4, tui.terminal.rows - 10));
			tui.requestRender(); return { consume: true };
		}
		if (matchesKey(data, "pageDown")) {
			setTranscriptOffset(state.transcriptOffset - Math.max(4, tui.terminal.rows - 10));
			tui.requestRender(); return { consume: true };
		}
		if (matchesKey(data, "escape") && state.panelOverlay) {
			state.panelOverlay = undefined;
			tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "escape") && state.working) {
			void rpc.request({ type: "clear_queue" }, 10_000).finally(() => rpc.request({ type: "abort" }, 30_000).catch(() => {}));
			return { consume: true };
		}
		if (keyMatches(data, "thinking.expand") && state.active) {
			const index = state.messages.findLastIndex((message) => message?.role === "assistant");
			if (index >= 0) {
				if (state.thinkingExpanded.has(index)) state.thinkingExpanded.delete(index); else state.thinkingExpanded.add(index);
				for (const part of state.messages[index]?.content || []) if (part?.type === "toolCall") {
					const id = part.id || part.toolCallId;
					if (!id) continue;
					if (state.inlineDiffExpanded.has(id)) state.inlineDiffExpanded.delete(id); else state.inlineDiffExpanded.add(id);
				}
				tui.requestRender();
			}
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+c")) {
			if (state.working) void rpc.request({ type: "abort" }, 30_000).catch(() => {});
			else if (editor.getText()) editor.setText("");
			else shutdown(0);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d") && !editor.getText()) { shutdown(0); return { consume: true }; }

		return undefined;
	};

	// TuiAltScreen installs its text-selection mouse listener first and consumes
	// every mouse sequence. Put application hit-testing ahead of it, while still
	// forwarding unhandled drags/clicks for normal terminal text selection.
	if (tui.inputListeners instanceof Set) {
		const existing = [...tui.inputListeners];
		tui.inputListeners.clear();
		tui.inputListeners.add(inputListener);
		for (const listener of existing) tui.inputListeners.add(listener);
	} else {
		tui.addInputListener(inputListener);
	}

	let spinnerFrame = 0;
	// Single coalescing draw scheduler, modelled on Grok Build's Presenter:
	// every source (stream deltas, tool output, stats, spinner) only marks the
	// frame dirty; one timer emits at a bounded frame rate, and input preempts it.
	// This keeps keystrokes responsive during heavy streaming instead of queueing
	// behind a repaint storm.
	const MIN_FRAME_MS = 33;
	const MAX_ADAPTIVE_RENDER_MS = 200;
	let drawTimer;
	let drawDirty = false;
	let lastDrawAt = 0;
	// Tool output invalidates the static transcript cache, so only fold it in when
	// the frame actually draws; otherwise a burst of chunks would bump the revision
	// (and rewrap history) on every chunk even though no frame was emitted.
	let workflowDirty = false;
	const flushPendingRevisions = () => {
		if (workflowDirty) { workflowDirty = false; state.workflowRevision += 1; }
	};
	function requestDraw(immediate = false) {
		if (immediate) {
			if (drawTimer) { clearTimeout(drawTimer); drawTimer = undefined; }
			drawDirty = false;
			flushPendingRevisions();
			lastDrawAt = Date.now();
			tui.requestRender();
			return;
		}
		drawDirty = true;
		if (drawTimer) return;
		const delay = adaptiveFrameDelay({
			minIntervalMs: MIN_FRAME_MS,
			maxAdaptiveMs: MAX_ADAPTIVE_RENDER_MS,
			lastCostMs: lastFrameCostMs,
			elapsedMs: lastFrameEndAt ? performance.now() - lastFrameEndAt : 0,
		});
		drawTimer = setTimeout(() => {
			drawTimer = undefined;
			if (!drawDirty) return;
			drawDirty = false;
			flushPendingRevisions();
			lastDrawAt = Date.now();
			tui.requestRender();
		}, delay);
		drawTimer.unref?.();
	}
	const requestWorkflowRender = (immediate = false) => {
		workflowDirty = true;
		requestDraw(immediate);
	};
	const spinner = setInterval(() => {
		spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
		const now = Date.now();
		// Cursor blinking is handled by the terminal. While active, animation is
		// intentionally throttled; idle toasts repaint once when they expire.
		if (state.working || state.compacting) requestDraw(false);
		else if (!toastExpiryRendered && now >= state.toastUntil) {
			toastExpiryRendered = true;
			requestDraw(false);
		}
	}, 120);

	rpc.onStderr((line) => {
		if (/warning|deprecated/i.test(line)) toast(line, "warning", 6_000);
		else toast(line, "error", 8_000);
	});

	rpc.onExit(({ error, code, signal }) => {
		if (state.stopped) return;
		toast(error.message, code === 0 && !signal ? "info" : "error", 2_000);
		setTimeout(() => shutdown(code ?? 1), 250);
	});

		const updateWorkflow = (event, status, immediate = false) => {
		let liveChanged = false;
		let tool;
		if (event.toolCallId && event.toolName !== "todo") {
			tool = state.liveTools.get(event.toolCallId);
			if (!tool) { tool = new LiveTool(event.toolCallId); state.liveTools.set(event.toolCallId, tool); }
			liveChanged = tool.update(event);
			if (liveChanged) state.dirtyToolIds.add(event.toolCallId);
		}
		const result = event.result ?? event.partialResult;
		if (event.toolName === "todo") {
			const todos = result?.details?.todos ?? event.args?.todos;
			if (Array.isArray(todos)) state.todos = todos.map((todo) => ({ ...todo }));
			requestWorkflowRender(immediate);
			return;
		}
		let item = state.workflow.find((entry) => entry.id === event.toolCallId);
		let changed = false;
		// The live tool already sanitized this exact result; reuse it instead of
		// redacting and scanning a potentially megabyte-sized output twice.
		const nextOutput = result !== undefined && tool ? tool.output : clean(redactText(toolResultText(result)));
		if (!item) {
			const args = event.args || {};
			item = {
				id: event.toolCallId,
				name: event.toolName || "tool",
				args: redactText(JSON.stringify(args)) === JSON.stringify(args) ? args : { redacted: true },
				label: truncateToWidth(toolLabel(event.toolName || "tool", args, t), 60, "…"),
				summary: clean(redactText(args.command || args.path || args.filePath || args.action || args.query || args.pattern || "")),
				status,
				startedAt: Date.now(),
				output: nextOutput,
			};
			state.workflow.push(item);
			changed = true;
		} else {
			if (item.status !== status) {
				item.status = status;
				changed = true;
			}
			if (status === "running" && !item.startedAt) {
				item.startedAt = Date.now();
				changed = true;
			}
			if (nextOutput && item.output !== nextOutput) {
				item.output = nextOutput;
				changed = true;
			}
			if (event.args && !item.args) {
				item.args = event.args;
				changed = true;
			}
		}
		if (status !== "running" && !item.endedAt) {
			item.endedAt = Date.now();
			changed = true;
		}
		if (status === "error") {
			const nextError = nextOutput || redactText(event.error?.message || event.error || item.error || t("status.toolFailed"));
			if (item.error !== nextError) {
				item.error = String(nextError);
				changed = true;
			}
		}
		if (state.workflow.length > 80) {
			const removed = state.workflow.splice(0, state.workflow.length - 80);
			for (const entry of removed) state.workflowExpanded.delete(entry.id);
			changed = true;
		}
		// Tool output can arrive in tiny chunks. Coalesce its cache invalidation
		// instead of rewrapping the transcript for every single update.
		if (changed) {
			item.revision = (item.revision || 0) + 1;
			item.visualCache = undefined;
		}
		if (changed || liveChanged) requestWorkflowRender(immediate);
		if (status !== "running" && ["edit", "write", "bash"].includes(event.toolName)) refreshTree();
	};

	const handleExtensionUi = (event) => {
		if (event.method === "notify") {
			toast(event.message, event.notifyType || "info");
			return;
		}
		if (event.method === "setStatus") {
			if (event.statusText == null) state.statuses.delete(event.statusKey);
			else state.statuses.set(event.statusKey, event.statusText);
			if (event.statusKey === "tsukuyomi-compact") state.compactStatus = event.statusText || "";
			if (event.statusKey === "tsukuyomi-mode" && typeof event.statusText === "string") {
				const mode = event.statusText.toLowerCase();
				if (MODES.includes(mode)) state.mode = mode;
			}
			tui.requestRender(); return;
		}
		if (event.method === "setWidget") {
			if (event.widgetKey === STRUCTURED_WIDGET) {
				const metadata = readStructuredWidget(event.widgetLines);
				if (metadata) {
					pendingStructured.clear();
					pendingStructured.set(metadata.nonce, metadata);
				} else pendingStructured.clear();
				return;
			}
			if (event.widgetKey === "tsukuyomi-providers-payload" && Array.isArray(event.widgetLines)) {
				try {
					const payload = JSON.parse(event.widgetLines.join("\n"));
					if (payload.changed && !state.working && !state.compacting) {
						setTimeout(() => shutdown(0, { restart: "provider", ...(state.sessionFile ? { session: state.sessionFile } : {}) }), 180);
						return;
					}
				} catch {}
			}
			if (event.widgetKey === "tsukuyomi-agent-payload") {
				try { state.activeAgent = event.widgetLines ? JSON.parse(event.widgetLines.join("\n")) : undefined; } catch { state.activeAgent = undefined; }
				tui.requestRender();
				return;
			}
			if (event.widgetKey === "tsukuyomi-agents-payload") return;
			if (event.widgetKey === "tsukuyomi-team-payload") {
				try { state.team = event.widgetLines ? JSON.parse(event.widgetLines.join("\n")) : undefined; } catch { state.team = undefined; }
				if (state.team?.active) state.showWorkflow = true;
				refreshHubDialog();
				tui.requestRender();
				return;
			}
			if (event.widgetKey === "tsukuyomi-tools-payload" && Array.isArray(event.widgetLines)) {
				try {
					const payload = JSON.parse(event.widgetLines.join("\n"));
					state.tools = {
						available: Array.isArray(payload.available) ? payload.available : [],
						active: Array.isArray(payload.active) ? payload.active : [],
						disabled: Array.isArray(payload.disabled) ? payload.disabled : [],
						labels: payload.labels && typeof payload.labels === "object" ? payload.labels : {},
					};
					if (state.dialog?.kind === "multi" && state.dialog?.source === "tools") state.dialog.toggled.clear();
					tui.requestRender();
				} catch {
					// Malformed payloads are ignored.
				}
				return;
			}
			if (event.widgetLines == null) state.widgets.delete(event.widgetKey);
			else state.widgets.set(event.widgetKey, event.widgetLines);
			tui.requestRender(); return;
		}
		if (event.method === "setTitle") { terminal.setTitle(event.title || "Tsukuyomi"); return; }
		if (event.method === "set_editor_text") { editor.setText(event.text || ""); resetCursorBlink(); return; }
		if (!["select", "confirm", "input", "editor"].includes(event.method)) return;
		extensionDialogs.enqueue(event);
	};

	const handleRpcEvent = (event) => {
		switch (event.type) {
			case "agent_start":
				state.working = true;
				if (!state.runWorkSince) state.runWorkSince = Date.now();
				activate();
				break;
			case "agent_settled": {
				// Safety net for a failed turn whose `message_end` was not observed
				// (reconnect, extension replacement): re-check the run's last assistant
				// message. notifyTurnError dedupes, so a healthy turn stays silent.
				const settledAssistant = [...state.messages].reverse().find((message) => message?.role === "assistant");
				if (settledAssistant && (state.runStartAt == null || settledAssistant.timestamp == null || settledAssistant.timestamp >= state.runStartAt)) {
					notifyTurnError(settledAssistant);
				}
				if (state.runWorkSince) {
					if (state.thinkingPhaseStart != null) {
						state.runThoughtMs += Date.now() - state.thinkingPhaseStart;
						state.thinkingPhaseStart = undefined;
					}
					state.lastWorkMs = Date.now() - state.runWorkSince;
					state.lastThoughtMs = state.runThoughtMs;
					state.runWorkSince = undefined;
					state.runThoughtMs = 0;
				}
				state.working = false;
				settledTurns += 1;
				state.runStartIndex ??= resolveRunStartIndex();
				clearStream();
				tui.requestRender();
				if (messageLogNeedsReconcile || settledTurns % RECONCILE_EVERY_TURNS === 0) {
					void refreshMessages({ settleStream: true, forceSettle: true });
				}
				void refreshStats(); refreshTree(); break;
			}
			case "message_start":
				if (event.message?.role === "assistant") {
					clearStream();
					state.streamAssistantBaseline = state.assistantCount || 0;
					state.streamStartedAt = Date.now();
				}
				break;
			case "message_update": {
				const delta = event.assistantMessageEvent;
				if (delta?.type?.startsWith("toolcall_")) {
					const part = toolCallStream.accept(delta);
					if (part) {
						updateWorkflow({ type: "tool_preview", toolCallId: part.id, toolName: part.name, args: part.args }, "running");
						if (!state.stream.some((phase) => phase.id === part.id)) pushToolPhase({ toolCallId: part.id, toolName: part.name, args: part.args });
					}
				}
				if (delta?.type === "text_delta") {
					if (state.thinkingPhaseStart != null) {
						state.runThoughtMs += Date.now() - state.thinkingPhaseStart;
						state.thinkingPhaseStart = undefined;
					}
					pushStream("text", delta.delta || "");
				} else if (delta?.type === "thinking_delta") {
					if (state.thinkingPhaseStart == null) state.thinkingPhaseStart = Date.now();
					pushStream("thinking", delta.delta || "");
				}
				requestDraw(false);
				return;
			}
			case "message_end": {
				notifyTurnError(event.message);
				// Mirror the kernel's own append instead of asking it for the whole
				// transcript. This keeps long sessions responsive: a turn with many
				// tool calls no longer round-trips a full snapshot per message.
				appendFinalMessage(event.message);
				if (event.message?.role === "assistant") {
					state.streamStartedAt = undefined;
					clearStream();
				}
				requestDraw(false);
				break;
			}
			case "tool_execution_start": updateWorkflow(event, "running", true); pushToolPhase(event); break;
			case "tool_execution_update": updateWorkflow(event, "running"); return;
			case "tool_execution_end": updateWorkflow(event, event.isError ? "error" : "done", true); markToolPhase(event.toolCallId, event.isError); break;
			case "queue_update":
				state.queueItems = { steering: [...(event.steering || [])], followUp: [...(event.followUp || [])] };
				state.queued = state.queueItems.steering.length + state.queueItems.followUp.length;
				state.widgets.set("queue", [...(event.steering || []).map((s) => `↪ ${locale === "zh" ? "纠正" : "Steer"}: ${s}`), ...(event.followUp || []).map((s) => `+ ${locale === "zh" ? "后续" : "Follow-up"}: ${s}`)]);
				if (state.queueScroll > state.queueMaxScroll) state.queueScroll = state.queueMaxScroll;
				break;
			case "thinking_level_changed": if (event.level) state.thinking = event.level; break;
			case "compaction_start": state.compacting = true; state.compactStatus = `${event.reason} · ${t("status.compactingShort")}`; break;
			case "compaction_end":
				state.compacting = false;
				state.compactStatus = event.result ? `${event.reason} · ${t("status.checkpointSaved")}` : event.errorMessage || t("status.compactionFailed");
				toast(state.compactStatus, event.result ? "info" : "error", 6_000);
				void refreshMessages(); void refreshStats();
				break;
			case "extension_error": toast(`${basename(event.extensionPath || "extension")}: ${event.error}`, "error", 9_000); break;
			case "extension_ui_request": handleExtensionUi(event); break;
		}
		tui.requestRender();
	};
	rpc.onEvent(handleRpcEvent);
	const handleJob = (job) => {
		if (job.cwd !== cwd) return;
		if (job.teamId) { state.teamJobs.set(job.id, job); tui.requestRender(); }
		refreshHubDialog(job);
		if (!job.toolCallId) return;
		const toolName = job.kind === "pty" ? "pty" : "subagent";
		const result = { content: [{ type: "text", text: job.kind === "pty" && !job.endedAt ? job.screen || job.output : job.output }], details: { ...job, jobId: job.id } };
		updateWorkflow({ type: job.endedAt ? "tool_execution_end" : "tool_execution_update", toolName, toolCallId: job.toolCallId, args: { command: job.command }, result, isError: job.status === "error" || job.status === "cancelled" }, job.endedAt ? job.status : "running", Boolean(job.endedAt));
		if (!state.stream.some((phase) => phase.id === job.toolCallId) && !state.messages.some((m) => m.role === "assistant" && m.content?.some((p) => p.id === job.toolCallId))) pushToolPhase({ toolName, toolCallId: job.toolCallId, args: { command: job.command } });
		if (job.endedAt && state.terminalJob === job.id) state.terminalJob = undefined;
	};
	taskClient.onEvent((event) => { if (event.job && !state.stopped) handleJob(event.job); });

	const onSigint = () => shutdown(130);
	const onSigterm = () => shutdown(143);
	const onSighup = () => shutdown(129);
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	process.once("SIGHUP", onSighup);
	removeSignalHandlers = () => {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		process.off("SIGHUP", onSighup);
	};

	terminal.setTitle(`Tsukuyomi ${version}`);
	tui.start();
	// DECSCUSR 2 is a solid block cursor on terminals that support cursor
	// shape control. The hardware cursor remains at CURSOR_MARKER for IME use.
	terminal.write(CURSOR_BLOCK);
	rpc.start();

	try {
		const [session, messageData, commands, stats] = await Promise.all([
			request({ type: "get_state" }, { timeoutMs: 30_000 }),
			request({ type: "get_messages" }, { timeoutMs: 30_000 }),
			request({ type: "get_commands" }, { timeoutMs: 30_000 }),
			rpc.request({ type: "get_session_stats" }, 30_000).catch(() => undefined),
		]);
		state.model = session?.model;
		state.ready = true;
		state.thinking = session?.thinkingLevel || "off";
		state.sessionName = session?.sessionName || "";
		state.sessionFile = session?.sessionFile;
		state.working = Boolean(session?.isStreaming);
		state.compacting = Boolean(session?.isCompacting);
		replaceMessages(messageData?.messages);
		state.commands = Array.isArray(commands?.commands) ? commands.commands : [];
		state.contextPercent = stats?.contextUsage?.percent;
		state.contextTokens = stats?.contextUsage?.tokens;
		state.sessionTokens = {
			input: Number(stats?.tokens?.input) || 0,
			output: Number(stats?.tokens?.output) || 0,
			cacheRead: Number(stats?.tokens?.cacheRead) || 0,
			cacheWrite: Number(stats?.tokens?.cacheWrite) || 0,
			total: Number(stats?.tokens?.total) || 0,
			cost: Number(stats?.cost) || 0,
		};
		const explicitSession = args.some((arg) =>
			arg === "--continue" || arg === "-c" || arg === "--session" || arg.startsWith("--session=") ||
			arg === "--session-id" || arg.startsWith("--session-id="),
		);
		state.active = state.messages.length > 0 || explicitSession || workspaceExplicit;
		state.workspaceDeclared = workspaceExplicit;
		state.showFiles = false;
		if (!workspaceEntry?.state) resetTranscript();
		if (workspaceEntry?.pending.length) {
			clearStream();
			for (const event of workspaceEntry.pending.splice(0)) handleRpcEvent(event);
		}
		state.toast = "";
		state.toastUntil = 0;
		updateAutocomplete();
		if (env.TSUKUYOMI_TASK_SOCKET || env.KAGUYAPI_TASK_SOCKET) {
			try { for (const job of await taskClient.request("subscribe")) handleJob(job); } catch (error) { toast(error.message, "error"); }
		}
		tui.requestRender(true);
		setTimeout(() => { void promptForUpdate({ automatic: true }); }, 250);
		if (workspaceExplicit && !workspaceEntry?.state) {
			const askWhenReady = () => {
				if (state.stopped) return;
				if (state.dialog) setTimeout(askWhenReady, 100);
				else askShowFiles();
			};
			setTimeout(askWhenReady, 20);
		}
	} catch (error) {
		toast(`Could not initialize PI kernel: ${error.message}`, "error", 30_000);
	}

	return finished;
}
