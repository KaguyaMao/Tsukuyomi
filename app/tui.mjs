import { execFile } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync, appendFileSync, mkdirSync } from "node:fs";
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
	createLruCache,
	limitRows,
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
import { filterSessionCatalog, scanSessionCatalog, trashSession } from "./session-store.mjs";
import { removeProviderConfig, saveProviderConfig } from "./providers/config/opencode.mjs";
import { buildCustomProvider } from "./providers/config/discovery.mjs";
import { removeProviderFromModelsJson, syncProviderToModelsJson, toProviderConfigInput } from "./providers/config/sync.mjs";
import { ProviderUsageClient } from "./providers/usage.mjs";
import { renderMarkdown, inlineAnsi, highlight, langFromPath } from "./markdown.mjs";

const ESC = "\x1b[";
// Zero-width APC marker the bundled Editor emits at the hardware-cursor cell.
// Must match `CURSOR_MARKER` in the pi-tui runtime that owns the final frame.
const CURSOR_MARKER = "\x1b_pi:c\x07";
const FOCUS_OUT = "\x1b[O";
const FOCUS_IN = "\x1b[I";
const CURSOR_BAR = "\x1b[6 q";
const CURSOR_RESET = "\x1b[0 q";
const rgb = (r, g, b) => (value) => `${ESC}38;2;${r};${g};${b}m${value}${ESC}39m`;
// Grok Build's canvas is a warm charcoal rather than terminal black. Keep the
// explicit background on every composed row so terminal themes cannot tint it.
const BLACK_BACKGROUND = `${ESC}48;2;18;18;18m`;
const blackBackground = (value) => `${paintBackground(value, BLACK_BACKGROUND)}${ESC}49m`;
const bold = (value) => `${ESC}1m${value}${ESC}22m`;
const dim = (value) => `${ESC}2m${value}${ESC}22m`;
const modalGrayDim = rgb(88, 88, 88);
const modalPrimary = rgb(225, 225, 225);

const color = {
	text: rgb(235, 235, 235),
	muted: rgb(117, 117, 117),
	dim: rgb(82, 82, 82),
	accent: rgb(137, 200, 255),
	secondary: rgb(177, 142, 221),
	title: rgb(232, 174, 82),
	success: rgb(148, 210, 102),
	warning: rgb(232, 174, 82),
	error: rgb(255, 116, 139),
	border: rgb(68, 68, 72),
};
const DIM_OPEN = `${ESC}38;2;82;82;82m`;

const BAND_BACKGROUND = `${ESC}48;2;36;36;36m`;
const bandBackground = (value) => paintBackground(value, BAND_BACKGROUND);
const LIST_SELECTION_BACKGROUND = `${ESC}48;2;54;54;54m`;
const listSelection = (value) => paintBackground(value, LIST_SELECTION_BACKGROUND);
const PANEL_BACKGROUND = `${ESC}48;2;15;15;16m`;
const PANEL_HOVER_BACKGROUND = `${ESC}48;2;35;35;36m`;
const TOOL_BACKGROUND = BLACK_BACKGROUND;
const MENU_BACKGROUND = `${ESC}48;2;22;22;22m`;
const MENU_SELECTION_BACKGROUND = `${ESC}48;2;255;176;123m`;
const menuBackground = (value) => `${paintBackground(value, MENU_BACKGROUND)}${BLACK_BACKGROUND}`;
const menuSelection = (value) => `${paintBackground(rgb(25, 25, 25)(value), MENU_SELECTION_BACKGROUND)}${MENU_BACKGROUND}`;
const DIFF_ADD_BACKGROUND = `${ESC}48;2;0;58;20m`;
const DIFF_REMOVE_BACKGROUND = `${ESC}48;2;76;18;26m`;
// Panel rows are concatenated with the black session surface in wide layouts.
// End on an explicit black background so the outer row painter cannot carry a
// panel background through the separator and into the center column.
const panelBackground = (value) => `${paintBackground(value, PANEL_BACKGROUND)}${BLACK_BACKGROUND}`;
const panelHoverBackground = (value) => `${paintBackground(value, PANEL_HOVER_BACKGROUND)}${BLACK_BACKGROUND}`;
const toolBackground = (value) => `${paintBackground(value, TOOL_BACKGROUND)}${BLACK_BACKGROUND}`;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Keep the Tsukuyomi wordmark on the landing screen.  It intentionally uses the
// product gold while the rest of the interface follows Grok Build's restrained
// gray/blue palette.  ANSI Shadow glyphs, joined by one space per letter.
const TSUKUYOMI_LOGO = [
	"████████╗ ███████╗ ██╗   ██╗ ██╗  ██╗ ██╗   ██╗ ██╗   ██╗  ██████╗  ███╗   ███╗ ██╗",
	"╚══██╔══╝ ██╔════╝ ██║   ██║ ██║ ██╔╝ ██║   ██║ ╚██╗ ██╔╝ ██╔═══██╗ ████╗ ████║ ██║",
	"   ██║    ███████╗ ██║   ██║ █████╔╝  ██║   ██║  ╚████╔╝  ██║   ██║ ██╔████╔██║ ██║",
	"   ██║    ╚════██║ ██║   ██║ ██╔═██╗  ██║   ██║   ╚██╔╝   ██║   ██║ ██║╚██╔╝██║ ██║",
	"   ██║    ███████║ ╚██████╔╝ ██║  ██╗ ╚██████╔╝    ██║    ╚██████╔╝ ██║ ╚═╝ ██║ ██║",
	"   ╚═╝    ╚══════╝  ╚═════╝  ╚═╝  ╚═╝  ╚═════╝     ╚═╝     ╚═════╝  ╚═╝     ╚═╝ ╚═╝",
];

function formatTime(value, locale = "en") {
	const date = new Date(Number(value));
	if (!Number.isFinite(date.getTime())) return "";
	try {
		return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
			hour: "numeric",
			minute: "2-digit",
			hour12: locale !== "zh",
		}).format(date);
	} catch {
		const hour = locale === "zh" ? date.getHours() : ((date.getHours() + 11) % 12) + 1;
		const suffix = locale === "zh" ? "" : ` ${date.getHours() < 12 ? "AM" : "PM"}`;
		return `${hour}:${String(date.getMinutes()).padStart(2, "0")}${suffix}`;
	}
}

function formatAgo(value, locale = "en", now = Date.now()) {
	const seconds = Math.max(0, Math.floor((now - Number(value || 0)) / 1000));
	if (seconds < 60) return locale === "zh" ? "刚刚" : "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return locale === "zh" ? `${minutes} 分钟前` : `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return locale === "zh" ? `${hours} 小时前` : `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return locale === "zh" ? `${days} 天前` : `${days}d ago`;
}

function formatDuration(totalSeconds, locale = "en") {
	if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "";
	const seconds = totalSeconds;
	if (locale === "zh") {
		if (seconds < 60) return `${seconds % 1 ? seconds.toFixed(1) : Math.round(seconds)}秒`;
		const minutes = Math.floor(seconds / 60);
		const rest = Math.round(seconds % 60);
		return rest ? `${minutes}分${rest}秒` : `${minutes}分`;
	}
	if (seconds < 60) return seconds % 1 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m${rest}s`;
}

const TOOL_LABEL_KEYS = {
	read: "tools.read",
	edit: "tools.edit",
	write: "tools.write",
	bash: "tools.bash",
	powershell: "tools.powershell",
	glob: "tools.glob",
	grep: "tools.grep",
	list: "tools.list",
	ls: "tools.list",
	find: "tools.find",
	todo: "tools.todo",
	web_fetch: "tools.webFetch",
	web_search: "tools.webSearch",
	apply_patch: "tools.applyPatch",
};

function toolLabel(name, args, translate = (key) => key) {
	const argText = (key) => {
		const value = args?.[key];
		if (typeof value === "string" && value.trim()) return value;
		if (value != null && typeof value !== "object") return String(value);
		return "";
	};
	switch (name) {
		case "read":
		case "write":
		case "edit": {
			const target = argText("path") || argText("filePath") || argText("file");
			if (!target) return translate(TOOL_LABEL_KEYS[name] || name);
			const verbKey = name === "read" ? "toolVerb.read" : name === "write" ? "toolVerb.write" : "toolVerb.edit";
			return `${translate(verbKey)} ${target}`;
		}
		case "bash": {
			const command = argText("command") || argText("cmd");
			return command ? `${translate("toolVerb.run")} ${command}` : translate("toolVerb.run");
		}
		case "grep":
		case "search": {
			const pattern = argText("pattern") || argText("query");
			return pattern ? `${translate("toolVerb.search")} ${pattern}` : translate("toolVerb.search");
		}
		case "glob": {
			const glob = argText("glob") || argText("pattern");
			return glob ? `${translate("toolVerb.list")} ${glob}` : translate("toolVerb.list");
		}
		case "list": {
			const target = argText("path") || argText("dir") || argText("dirPath");
			return target ? `${translate("toolVerb.list")} ${target}` : translate("toolVerb.list");
		}
		case "web_fetch": {
			const target = argText("url");
			return target ? `${translate("toolVerb.fetch")} ${target}` : translate("tools.webFetch");
		}
		case "web_search": {
			const query = argText("query");
			return query ? `${translate("toolVerb.search")} ${query}` : translate("tools.webSearch");
		}
		default: {
			const summary = argText("command") || argText("path") || argText("action") || argText("query") || argText("pattern") || argText("filePath");
			return summary ? `${translate(TOOL_LABEL_KEYS[name] || name)} ${summary}` : translate(TOOL_LABEL_KEYS[name] || name);
		}
	}
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
	// below; the terminal cursor is configured as a blinking bar instead.
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
			join(process.env.TSUKUYOMI_DIR || process.env.KAGUYAPI_DIR || process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || "", ".tsukuyomi", "agent"), "perf.log");
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
	const gitBranch = readBranch(cwd);
	// Single agent directory owns auth.json / providers.json / models.json.
	const agentDir = env?.PI_CODING_AGENT_DIR;
	const preferences = loadPreferences(agentDir);
	const configuredLocale = normalizeLocale(env?.TSUKUYOMI_LANG || env?.KAGUYAPI_LANG) || normalizeLocale(preferences.language);
	let locale = configuredLocale || detectLocale({ ...process.env, ...env });
	let t = createTranslator(locale);
	const usageClient = new ProviderUsageClient({ agentDir, env, resolveAuth: (model) => providers().getAuth(model) });
	let providerRuntime;
	const providers = () => providerRuntime ||= createProviderRuntime({ piRoot, agentDir });

	const state = {
		active: false,
		ready: false,
		homeSelected: 0,
		working: false,
		compacting: false,
		compactStatus: "",
		messages: [],
		messageRevision: 0,
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
		workspaceDeclared: workspaceExplicit,
		showFiles: false,
		showWorkflow: preferences.rightSidebarDefault !== false,
		showTodos: preferences.rightSidebarDefault !== false,
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
		toast: t("toast.starting"),
		toastType: "info",
		toastUntil: Date.now() + 10_000,
		dialog: undefined,
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
		userTurnCount: 0,
		dirtyToolIds: new Set(),
		mouseZones: [],
		primaryPastePending: false,
		stopped: false,
	};
	if ((process.env.TSUKUYOMI_PERF ?? process.env.KAGUYAPI_PERF) === "1") startPerfLog();

	const editorTheme = {
		borderColor: color.border,
		selectList: {
			selectedPrefix: color.accent,
			selectedText: (value) => bold(color.text(value)),
			description: color.muted,
			scrollInfo: color.dim,
			noMatch: color.warning,
		},
	};
	const editor = new Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
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
		const key = `${width}|${editorRevision}|${editorInputFocused() ? 1 : 0}|${state.dialog?.secret ? 1 : 0}|${editor.getText().length}`;
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

	let toastExpiryRendered = false;
	const toast = (message, type = "info", duration = 4_000) => {
		state.toast = clean(redactText(message));
		state.toastType = type;
		state.toastUntil = Date.now() + duration;
		toastExpiryRendered = false;
		tui.requestRender();
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
		state.userTurnCount = state.messages.filter((message) => message?.role === "user").length;
		state.todos = latestTodos(state.messages);
		rebuildWorkflowHistory(state.messages);
	};

	const clearStream = () => {
		if (!state.stream.length && !state.streamingText && !state.streamingThinking && state.streamStartedAt == null) return;
		state.stream = [];
		state.streamingText = "";
		state.streamingThinking = "";
		state.streamStartedAt = undefined;
		state.streamRevision += 1;
	};

	const streamIsCommitted = () => {
		const assistantCount = state.messages.filter((message) => message?.role === "assistant").length;
		if (assistantCount > state.streamAssistantBaseline) return true;
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
		"new", "compact", "mode", "workspace", "files", "workflow", "todo", "sidebar", "model", "provider",
		"thinking", "tools", "sessions", "language", "status", "touch", "help", "perf", "quit",
	];
	const makeBuiltins = () => builtinNames.map((name) => ({
		name,
		description: t(`command.${name}`),
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
		savePreferences(env?.PI_CODING_AGENT_DIR, { language: next });
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
		state.dialog = {
			source: "status",
			kind: "status",
			title: t("status.title"),
			message: t("status.loading"),
		};
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
		if (result?.cancelled) rpc.respond({ type: "extension_ui_response", id: dialog.id, cancelled: true });
		else if (dialog.kind === "confirm") {
			rpc.respond({ type: "extension_ui_response", id: dialog.id, confirmed: Boolean(result?.confirmed) });
		} else {
			rpc.respond({ type: "extension_ui_response", id: dialog.id, value: result?.value });
		}
		tui.requestRender();
	};

	const openPalette = () => {
		clearTerminalSelection();
		state.pointer.cancel();
		const items = [...builtins, ...state.commands]
			.filter((item, index, list) => list.findIndex((other) => other.name === item.name) === index)
			.slice(0, 30);
		state.dialog = {
			source: "palette",
			kind: "select",
			title: t("dialog.commands"),
			options: items.map((item) => item.name),
			descriptions: new Map(items.map((item) => [item.name, item.description || ""])),
			selected: 0,
		};
		resetCursorBlink();
		tui.requestRender();
	};

	const openLocalSelect = ({ title, message, options, descriptions, selected = 0, kind = "select", onResolve, searchable = false, sections }) => {
		clearTerminalSelection();
		state.pointer.cancel();
		state.dialog = {
			source: "local",
			kind,
			title,
			message,
			options,
			allOptions: [...options],
			descriptions,
			sections,
			searchable,
			query: "",
			selected: Math.max(0, Math.min(options.length - 1, selected)),
			onResolve,
		};
		resetCursorBlink();
		tui.requestRender();
	};
	const openLocalInput = ({ title, message, prefill = "", secret = false, onResolve }) => {
		clearTerminalSelection();
		state.pointer.cancel();
		state.dialog = { source: "local", kind: "input", title, message, options: [], selected: 0, savedText: editor.getText(), secret, onResolve };
		editor.setText(prefill); tui.setFocus(editor); resetCursorBlink(); tui.requestRender();
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
		const agentDir = env.PI_CODING_AGENT_DIR || join(process.env.HOME || "", ".tsukuyomi/agent");
		return join(agentDir, "sessions");
	};

	const openToolsDialog = () => {
		const fallback = Object.keys(TOOL_LABEL_KEYS);
		const options = state.tools.available.length ? [...state.tools.available] : fallback;
		clearTerminalSelection();
		state.pointer.cancel();
		state.dialog = {
			source: "tools",
			kind: "multi",
			title: t("dialog.tools"),
			message: t("dialog.toolsMessage"),
			options,
			descriptions: new Map(options.map((name) => [name, state.tools.labels[name] || t(TOOL_LABEL_KEYS[name] || name)])),
			selected: 0,
			toggled: new Map(),
		};
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
		state.dialog = {
			source: "local",
			kind: "sessions",
			title: t("dialog.sessions"),
			query: "",
			currentOnly: false,
			selected: Math.max(0, currentIndex),
			items,
		};
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

	const openModelSelector = async () => {
		toast(t("toast.loadingModels"), "info", 2_000);
		const models = await availableModels();
		if (!models.length) {
			toast(t("toast.noModels"), "warning");
			return;
		}
		const labels = models.map((model) => `${model.provider}/${model.id}`);
		const descriptions = new Map(models.map((model, index) => [
			labels[index],
			`${model.name || model.id}${model.contextWindow ? ` · ${formatTokens(model.contextWindow, locale)} ${t("status.contextWindow").toLowerCase()}` : ""}`,
		]));
		const current = labels.findIndex((label) => label === `${state.model?.provider}/${state.model?.id}`);
		openLocalSelect({
			title: t("dialog.model"),
			message: t("dialog.modelMessage", { count: formatNumber(models.length, locale) }),
			options: labels,
			descriptions,
			selected: current >= 0 ? current : 0,
			onResolve: (result) => {
				const index = labels.indexOf(result?.value);
				if (index >= 0) return applyModel(models[index]);
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
				state.dialog = undefined; tui.requestRender();
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
		} else openLocalInput({ title: t("dialog.providerSignIn"), message: prompt.message, secret: prompt.type === "secret" || prompt.type === "manual_code", onResolve: done });
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
			if (state.dialog?.source === "auth" || state.dialog?.authPrompt) state.dialog = undefined;
		};
		const showAuthProgress = ({ url, code, instructions }) => {
			if (url) openUrl(url);
			const lines = [
				url ? `${t("auth.openUrl")} ${url}` : "",
				code ? t("auth.deviceCode", { code, url: url || "" }) : "",
				instructions || t("auth.waiting"),
			].filter(Boolean);
			state.dialog = {
				kind: "select",
				source: "auth",
				title: t("dialog.providerSignIn"),
				message: lines.join("\n"),
				options: [t("action.cancel")],
				selected: 0,
				onResolve: (result) => {
					if (result?.cancelled || result?.value) controller.abort();
				},
			};
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
					prompt: authPrompt,
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
	const localSelectValue = (title, options) => new Promise((resolve, reject) => openLocalSelect({ title, options, descriptions: new Map(), onResolve: (result) => result?.cancelled ? reject(new Error("Cancelled")) : resolve(result?.value) }));
	const addCustomProvider = async () => {
		try {
			const id = await localInputValue(t("custom.id"), t("custom.idHint"));
			const name = await localInputValue(t("custom.name"), t("custom.nameHint"), { prefill: id });
			const baseUrl = await localInputValue(t("custom.baseUrl"), t("custom.baseUrlHint"), { prefill: "https://" });
			const apiKey = await localInputValue(t("custom.apiKey"), t("custom.apiKeyHint"), { secret: true });
			// Discovery validates and fills in the model list; nothing is written
			// until it succeeds, so a failed discovery leaves no partial config.
			const config = await buildCustomProvider({ id, name, baseUrl, apiKey }, { env });
			saveProviderConfig(agentDir, id, config);
			syncProviderToModelsJson(agentDir, id, config);
			await providers().registerProvider(id, toProviderConfigInput(config));
			await providers().saveApiKey(id, apiKey);
			toast(t("custom.saved", { provider: name }), "info");
			setTimeout(() => shutdown(0, { restart: "provider", ...(state.sessionFile ? { session: state.sessionFile } : {}) }), 180);
		} catch (error) { if (error?.message !== "Cancelled") toast(error?.message || String(error), "error"); }
	};

	const openProviderSelector = async () => {
		if (state.working || state.compacting) { toast(t("toast.abortWorkspace"), "warning"); return; }
		toast(t("toast.loadingModels"), "info", 2_000);
		// The registry derives auth methods, auth status, grouping, and order
		// from PI; the UI only renders the result.
		const list = await loadProviderCatalog(providers(), { currentProviderId: state.model?.provider });
		if (!list.length) { toast(t("toast.noModels"), "warning"); return; }
		const providerAuth = (provider) => {
			const status = provider.status ?? providers().authStatus(provider.id) ?? {};
			const configured = status.configured === true || provider.configured === true;
			return { configured, kind: status.source || (configured ? "configured" : "none"), label: status.label };
		};
		const labels = list.map((provider) => `${provider.name} · ${provider.id}`);
		const addLabel = t("custom.add"); labels.push(addLabel);
		const descriptions = new Map(list.map((provider) => {
			const auth = providerAuth(provider);
			const mark = auth.configured ? "✓" : "✗";
			const availability = provider.models.length
				? `${provider.models.length} ${t("provider.models")}`
				: auth.configured ? t("provider.loadModels") : t("dialog.providerSignIn");
			return [labels[list.indexOf(provider)], `${mark} ${auth.kind || (auth.configured ? "environment" : "none")} · ${availability}`];
		}));
		descriptions.set(addLabel, t("custom.addHint"));
		const sections = new Map(list.map((provider, index) => [labels[index], t(`provider.group.${provider.group || "other"}`)])); sections.set(addLabel, t("provider.group.custom"));
		openLocalSelect({ title: t("dialog.provider"), message: t("dialog.providerMessage"), options: labels, descriptions,
			selected: Math.max(0, list.findIndex((provider) => provider.id === state.model?.provider)), onResolve: async (result) => {
				if (result?.value === addLabel) { await addCustomProvider(); return; }
				const provider = list[labels.indexOf(result?.value)];
				if (!provider) return;
				const auth = providerAuth(provider);
				if (!auth.configured) { openProviderAuth(provider); return; }
				const models = await providers().getModels(provider.id);
				if (!models.length) { openProviderAuth(provider); return; }
				const modelLabels = models.map((model) => `${model.provider}/${model.id}`);
				const signIn = t("dialog.providerSignIn");
				const signOut = t("auth.signOut");
				const remove = provider.custom ? t("custom.remove") : undefined;
				const options = [...modelLabels, signIn, signOut, ...(remove ? [remove] : [])];
				const descriptions = new Map([
					...models.map((model, index) => [modelLabels[index], model.name || model.id]),
					[signIn, t("auth.accountLogin")],
					[signOut, t("auth.signOutHint")],
					...(remove ? [[remove, t("custom.removeHint")]] : []),
				]);
				openLocalSelect({ title: t("dialog.model"), message: t("dialog.modelMessage", { count: formatNumber(models.length, locale) }), options, descriptions,
					selected: Math.max(0, modelLabels.indexOf(`${state.model?.provider}/${state.model?.id}`)),
					onResolve: async (choice) => {
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
						applyModel(models[modelLabels.indexOf(choice?.value)]);
					}, searchable: true });
			}, searchable: true, sections });
	};

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
			try {
				const jobs = await taskClient.request("list");
				const labels = jobs.map((job) => `${job.status} · ${job.kind} · ${job.command} · ${job.cwd}`);
				openLocalSelect({ title: locale === "zh" ? "任务" : "Tasks", options: labels, onResolve: (result) => {
					const job = jobs[labels.indexOf(result?.value)]; if (!job) return;
					openLocalSelect({ title: job.command, options: ["View / 查看", "Cancel / 取消", "Steer / 纠正"], onResolve: async (choice) => {
						if (choice?.value?.startsWith("Cancel")) await taskClient.request("cancel", { id: job.id });
						else if (choice?.value?.startsWith("Steer")) openLocalInput({ title: "Steer / 纠正", onResolve: (input) => input?.value && taskClient.request("steer", { id: job.id, message: input.value }) });
						else if (choice?.value) {
							if (job.cwd !== cwd) chooseWorkspace(job.cwd);
							else { const tool = state.liveTools.get(job.toolCallId); if (tool) { tool.expanded = true; tool.offset = 0; state.dirtyToolIds.add(job.toolCallId); state.workflowRevision++; } resetTranscript(); }
						}
					} });
				} });
			} catch (error) { toast(error.message, "error"); }
			return;
		}
		if (command === "followup") return runInput(rest, "followUp");
		if (command === "steer") return runInput(rest, "steer");
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
		if (command === "provider") { try { await openProviderSelector(); } catch (error) { toast(redactText(error?.message || String(error)), "error"); } return; }
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
			await refreshMessages();
		} catch { editor.setText(raw); }
	};

	editor.onChange = () => resetCursorBlink();
	editor.onSubmit = (value) => { void runInput(value); };

	const openSettings = () => {
		const options = [t("settings.language"), t("settings.rightSidebar"), t("settings.thinking"), t("settings.touch"), t("settings.markdown")];
		openLocalSelect({ title: t("settings.title"), message: t("settings.message"), options,
			descriptions: new Map([
				[options[0], languageName()],
				[options[1], state.showWorkflow || state.showTodos ? t("settings.on") : t("settings.off")],
				[options[2], state.thinkingAutoCollapse ? t("settings.on") : t("settings.off")],
				[options[3], state.touchMode ? t("settings.on") : t("settings.off")],
				[options[4], state.markdown ? t("settings.on") : t("settings.off")],
			]), onResolve: (result) => {
				const index = options.indexOf(result?.value);
				if (index === 0) openLanguageSelector();
				if (index === 1) { const next = !(state.showWorkflow || state.showTodos); state.showWorkflow = next; state.showTodos = next; savePreferences(env?.PI_CODING_AGENT_DIR, { rightSidebarDefault: next }); }
				if (index === 2) { state.thinkingAutoCollapse = !state.thinkingAutoCollapse; savePreferences(env?.PI_CODING_AGENT_DIR, { thinkingAutoCollapse: state.thinkingAutoCollapse }); }
				if (index === 3) { state.touchMode = !state.touchMode; savePreferences(env?.PI_CODING_AGENT_DIR, { touchMode: state.touchMode }); }
				if (index === 4) { state.markdown = !state.markdown; savePreferences(env?.PI_CODING_AGENT_DIR, { markdown: state.markdown }); }
			},
		});
	};
	const homeActionIds = ["new", "resume", "workspace", "provider", "settings", "quit"];
	const runHomeAction = async (id) => {
		if (!state.ready && id !== "quit") return;
		if (id === "new") { if (state.messages.length) await runInput("/new"); else activate(); tui.requestRender(); }
		else if (id === "resume") await openSessionsDialog();
		else if (id === "workspace") openLocalInput({ title: t("dialog.switchWorkspace"), message: t("home.workspacePrompt"), prefill: cwd, onResolve: (result) => result?.value && chooseWorkspace(result.value) });
		else if (id === "provider") await openProviderSelector();
		else if (id === "settings") openSettings();
		else if (id === "quit") shutdown(0);
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
			const bandWidth = Math.max(1, width - 2);
			const prefix = this.#promptPrefix(Math.max(1, Math.floor(bandWidth * 0.45)));
			const prefixWidth = visibleWidth(prefix);
			const timeText = timestamp != null ? ` ${formatTime(timestamp, locale)}` : "";
			const timeWidth = visibleWidth(timeText);
			const promptWidth = Math.max(1, bandWidth - prefixWidth - 1 - timeWidth);
			const rows = [];
			const { rows: lines, sgr } = textRows(owner, "band", prompt, promptWidth);
			for (let index = 0; index < lines.length; index++) {
				let row = index > 0
					? `${" ".repeat(prefixWidth + 1)}${sgr ? lines[index] : color.text(lines[index])}`
					: `${prefix} ${sgr ? (lines[0] || " ") : color.text(lines[0] || " ")}`;
				if (index === 0 && timeWidth > 0) {
					row = pad(row, Math.max(2, bandWidth - timeWidth - 1)) + timeText;
				}
				rows.push(bandBackground(pad(row, bandWidth)));
			}
			const blank = bandBackground(" ".repeat(bandWidth));
			const content = rows.length ? rows : [bandBackground(pad(`${prefix} `, bandWidth))];
			// Grok Build gives every user turn a full row of breathing room above
			// and below the prompt, even when the prompt itself occupies one row.
			return [blank, ...content, blank];
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
				for (const row of tool.rows(locale, tui.terminal.rows)) {
					const painter = toolRowPaint(row);
					const mark = row.kind === "header" ? "╭" : row.kind === "footer" ? "╰" : "│";
					const text = truncateToWidth(toolRowContent(row, tool, name), Math.max(1, inner - 3), "…");
					rows.push(`  ${color.border(mark)} ${painter(text)}`);
				}
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
						for (const row of tool.rows(locale, tui.terminal.rows)) {
							const painter = toolRowPaint(row);
							const mark = row.kind === "header" ? "╭" : row.kind === "footer" ? "╰" : "│";
							const text = truncateToWidth(toolRowContent(row, tool, part.name), Math.max(1, inner - 3), "…");
							lines.push(`  ${color.border(mark)} ${painter(text)}`);
						}
						localToolRanges.push({ id, start, end: lines.length });
					}
				}
				if (isLastAssistant && state.lastWorkMs != null && state.lastWorkMs > 0) {
					lines.push(`  ${color.muted(t("status.workedFor", { duration: formatDuration(state.lastWorkMs / 1000, locale) }))}`);
				}
				lines.push("");
			} else if (message.role === "custom" && message.display !== false) {
				for (const line of wrapCached(message, "custom", `✦ ${textOfContent(message.content)}`, inner)) lines.push(`  ${color.warning(line)}`);
			} else if (message.role === "bashExecution") {
				for (const line of wrapCached(message, "bashCmd", `$ ${message.command || ""}`, inner)) lines.push(`  ${color.warning(line)}`);
				if (message.output) {
					for (const line of wrapCached(message, "bashOut", message.output, inner - 2).slice(0, 6)) lines.push(`  ${color.dim(line || " ")}`);
				}
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
			for (const [key, status] of state.statuses) {
				if (key === "tsukuyomi-mode" || key === "tsukuyomi-compact") continue;
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
			lines.push(this.#panelRow(`  ${status} ${color.dim("· Ctrl+O")}`, width));
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
			lines.push(this.#panelRow(`  ${color.muted(summary)} ${color.dim("· Ctrl+T")}`, width));
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

		#drawDialog(screen, width, height) {
			const dialog = state.dialog;
			if (!dialog || width < 6 || height < 3) return screen;
			if (dialog.kind === "sessions") return this.#drawSessions(screen, width, height, dialog);
			if (dialog.closeHovered == null) dialog.closeHovered = false;
			const preferredWidth = dialog.searchable ? 64 : 140;
			const boxWidth = Math.max(1, Math.min(width, Math.max(60, Math.floor(width * 0.9)), Math.min(preferredWidth, Math.max(20, width - 4))));
			const innerWidth = boxWidth - 4;
			const content = [];
			const optionRows = [];
			if (dialog.message && dialog.kind !== "status" && !dialog.searchable) content.push(...wrap(dialog.message, innerWidth), "");
			if (dialog.searchable) {
				content.push(
					"",
					` ${bold(color.text(t("provider.searchLabel")))}${dialog.query ? ` ${color.text(dialog.query)}` : ""}`,
					"",
				);
			}
			if (dialog.kind === "select" || dialog.kind === "confirm") {
				const visibleOptions = Math.max(3, Math.min(dialog.searchable ? 6 : 12, height - 8));
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
					content.push(selected && dialog.searchable
						? menuSelection(pad(optionLine, innerWidth))
						: `${selected ? color.accent("❯") : " "} ${selected ? bold(color.text(option)) : color.muted(option)}`);
					const description = dialog.descriptions?.get(option);
					if (description && selected && !dialog.searchable) {
						const shown = state.markdown ? inlineAnsi(description, DIM_OPEN) : description;
						content.push(`  ${color.dim(shown)}`);
					}
				}
				if (last < dialog.options.length) content.push(color.dim(`  ${t("dialog.moreDown", { count: dialog.options.length - last })}`));
			} else if (dialog.kind === "multi") {
				const visibleOptions = Math.max(3, Math.min(12, height - 8));
				const first = Math.max(0, Math.min(
					dialog.options.length - visibleOptions,
					dialog.selected - Math.floor(visibleOptions / 2),
				));
				const last = Math.min(dialog.options.length, first + visibleOptions);
				if (first > 0) content.push(color.dim(`  ${t("dialog.moreUp", { count: first })}`));
				for (let index = first; index < last; index++) {
					const option = dialog.options[index];
					const selected = index === dialog.selected;
					const on = toolEnabled(option);
					const marker = on ? bold(color.success("[x]")) : color.dim("[ ]");
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
			} else {
				content.push(color.muted(t("dialog.valueHint")));
			}
			const boxHeight = dialog.searchable
				? Math.min(height, Math.max(6, content.length + 2))
				: Math.min(height - 2, Math.max(5, content.length + 4));
			const top = Math.max(0, Math.floor((height - boxHeight) / 2));
			const left = Math.max(0, Math.floor((width - boxWidth) / 2));
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
				// A modal owns its complete row span. Clear the underlying transcript
				// first so a user-message background cannot continue past its border.
				for (let row = top; row < Math.min(height, top + boxHeight); row++) next[row] = blackBackground(" ".repeat(width));
				for (let row = 0; row < box.length && top + row < height; row++) {
					next[top + row] = compositeTuiLine(next[top + row] || "", box[row], left, boxWidth, width);
				}
				dialog.mouseClose = { x: left + Math.max(0, boxWidth - 7), y: top, width: 5, height: 1 };
				return next;
			}
			const closeX = boxWidth - 7;
			dialog.mouseClose = { x: left + closeX, y: top, width: 5, height: 1 };
			const title = truncateToWidth(dialog.title || "Tsukuyomi", Math.max(4, boxWidth - 11), "…");
			const headerPrefix = `╭─ ${color.text(bold(title))} `;
			const headerFill = Math.max(0, closeX - visibleWidth(headerPrefix));
			const header = color.border(`${headerPrefix}${"─".repeat(headerFill)}     ╮`);
			const close = dialog.closeHovered ? bold(modalPrimary("[✗]")) : modalGrayDim("[✗]");
			// Dialog rows must be opaque. Without an explicit background, an
			// overlaid row inherits a user-message band from the screen beneath it.
			const boxPainter = menuBackground;
			const boxRow = (line) => boxPainter(
				`${color.border("│")} ${pad(line, innerWidth)}${MENU_BACKGROUND} ${color.border("│")}`,
			);
			const box = [boxPainter(compositeTuiLine(header, close, closeX + 1, 3, boxWidth))];
			for (const line of content.slice(0, boxHeight - 2)) box.push(boxRow(line));
			while (box.length < boxHeight - 1) box.push(boxRow(""));
			box.push(boxPainter(color.border(`╰${"─".repeat(boxWidth - 2)}╯`)));
			const next = [...screen];
			for (let row = top; row < Math.min(height, top + boxHeight); row++) next[row] = blackBackground(" ".repeat(width));
			for (let row = 0; row < box.length && top + row < height; row++) {
				next[top + row] = compositeTuiLine(next[top + row] || "", box[row], left, boxWidth, width);
			}
			return next;
		}

		#home(width, height) {
			const lines = Array.from({ length: height }, () => "");
			const compactHome = width < 80 || height < 22;
			const composerWidth = width >= 12 ? width - 4 : Math.max(1, width);
			const homeEditorWidth = Math.max(1, composerWidth - 6);
			const composer = this.#grokComposer(composerWidth, editorLinesFor(homeEditorWidth), compactHome ? 3 : 5);
			const editorTop = Math.max(0, height - composer.lines.length - 2);
			const editorLeft = Math.max(0, Math.floor((width - composerWidth) / 2));

			if (height > 2) lines[0] = ` ${color.dim(compactPath(cwd))}`;
			const fullLogo = width >= visibleWidth(TSUKUYOMI_LOGO[0]) + 4
				&& editorTop >= TSUKUYOMI_LOGO.length + 11;
			const logoRows = fullLogo
				? TSUKUYOMI_LOGO.map((row) => bold(color.title(row)))
				: [bold(color.title("T S U K U Y O M I"))];
			const logoTop = Math.max(1, Math.min(
				Math.floor(editorTop * (fullLogo ? 0.15 : 0.08)),
				Math.max(1, editorTop - logoRows.length - 4),
			));
			for (let row = 0; row < logoRows.length && logoTop + row < editorTop; row++) {
				lines[logoTop + row] = pad(logoRows[row], width, "center");
			}
			const subtitleY = logoTop + logoRows.length;
			if (subtitleY < editorTop) {
				lines[subtitleY] = pad(
					`${color.dim(`v${version}`)} ${color.dim("·")} ${color.muted(t("home.greeting"))}`,
					width,
					"center",
				);
			}

			// The welcome actions are deliberately a separate, compact multi-line
			// hint card between the product mark and the bottom composer.
			const cardWidth = Math.max(18, Math.min(width - 4, compactHome ? 58 : 72));
			const cardLeft = Math.max(0, Math.floor((width - cardWidth) / 2));
			const inner = Math.max(1, cardWidth - 4);
			const cardRoom = Math.max(0, editorTop - subtitleY - 1);
			const cardHeight = Math.min(11, cardRoom);
			if (cardHeight >= 3) {
				const actionShortcuts = ["Enter", "Ctrl+S", "Ctrl+W", "", "", "Ctrl+Q"];
				const hintLines = cardHeight >= 9
					? wrap(t("home.startHint"), Math.max(1, inner - 2)).slice(0, 2)
					: [];
				const actionSlots = Math.max(1, cardHeight - 2 - hintLines.length - (hintLines.length ? 1 : 0));
				const firstAction = Math.max(0, Math.min(
					homeActionIds.length - actionSlots,
					state.homeSelected - Math.floor(actionSlots / 2),
				));
				const bodyRows = hintLines.map((line) => ` ${color.muted(line)}`);
				if (hintLines.length) bodyRows.push("");
				for (let slot = 0; slot < actionSlots; slot++) {
					const actionIndex = firstAction + slot;
					if (actionIndex >= homeActionIds.length) break;
					const id = homeActionIds[actionIndex];
					const selected = actionIndex === state.homeSelected;
					const label = t(`home.action.${id}`);
					const shortcut = actionShortcuts[actionIndex] || "";
					const lead = `${selected ? color.accent("❯") : " "} ${selected ? bold(color.text(label)) : color.muted(label)}`;
					const gap = shortcut ? Math.max(1, inner - visibleWidth(lead) - visibleWidth(shortcut)) : 0;
					bodyRows.push(`${lead}${" ".repeat(gap)}${shortcut ? color.muted(shortcut) : ""}`);
				}
				while (bodyRows.length < cardHeight - 2) bodyRows.push("");
				const cardTop = Math.min(
					editorTop - cardHeight,
					subtitleY + 1 + Math.max(0, Math.floor((cardRoom - cardHeight) / 2)),
				);
				const card = [color.border(`╭${"─".repeat(Math.max(0, cardWidth - 2))}╮`)];
				for (const row of bodyRows.slice(0, cardHeight - 2)) {
					card.push(`${color.border("│")} ${pad(row, inner)} ${color.border("│")}`);
				}
				card.push(color.border(`╰${"─".repeat(Math.max(0, cardWidth - 2))}╯`));
				for (let row = 0; row < card.length && cardTop + row < editorTop; row++) {
					lines[cardTop + row] = compositeTuiLine(lines[cardTop + row], card[row], cardLeft, cardWidth, width);
				}
				const actionStartY = cardTop + 1 + hintLines.length + (hintLines.length ? 1 : 0);
				for (let slot = 0; slot < actionSlots; slot++) {
					const actionIndex = firstAction + slot;
					if (actionIndex >= homeActionIds.length) break;
					state.mouseZones.push({
						key: `home:${homeActionIds[actionIndex]}`,
						x: cardLeft + 2,
						y: actionStartY + slot,
						width: inner,
						height: 1,
						action: "home-action",
						homeAction: homeActionIds[actionIndex],
					});
				}
			}

			for (let row = 0; row < composer.lines.length && editorTop + row < height; row++) {
				lines[editorTop + row] = compositeTuiLine(lines[editorTop + row], " ".repeat(composerWidth), editorLeft, composerWidth, width);
				lines[editorTop + row] = compositeTuiLine(lines[editorTop + row], composer.lines[row], editorLeft, composerWidth, width);
			}
			state.mouseZones.push({ x: editorLeft, y: editorTop, width: composerWidth, height: composer.lines.length, action: "composer" });
			if (Date.now() < state.toastUntil && height > 1) {
				const painter = state.toastType === "error" ? color.error : state.toastType === "warning" ? color.warning : color.muted;
				// The home layout reserves two rows beneath the composer; keep transient
				// startup messages there so they never erase the hint card or its border.
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
			return rows;
		}

		#grokComposer(width, editorLines, maxRows) {
			const columns = Math.max(1, width);
			if (columns < 7 || maxRows < 3) {
				const editorLine = editorLines.findLast((line) => visibleWidth(line) > 0) || "";
				return {
					lines: [pad(`${color.accent("❯")} ${editorLine}`, columns)],
					metaRow: 0,
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
			const contentBudget = Math.max(1, maxRows - 2);
			const filteredEditor = editorLines.filter((line) => !isEditorRule(line));
			// The cursor marker must survive into the final frame or the hardware
			// cursor (and IME preedit) is misplaced. Tail-trimming can drop a marker
			// that sits on an early line, so pick the window that keeps it.
			const markerIndex = filteredEditor.findIndex((line) => line.includes(CURSOR_MARKER));
			const content = markerIndex >= contentBudget
				? filteredEditor.slice(Math.max(0, filteredEditor.length - contentBudget))
				: limitRows(filteredEditor, contentBudget);
			const captionRaw = clean(state.sessionName || "");
			const caption = captionRaw ? truncateToWidth(` ${captionRaw} `, Math.max(0, columns - 6), "…") : "";
			const captionWidth = visibleWidth(caption);
			const topInside = caption
				? `${"─".repeat(Math.max(2, columns - captionWidth - 4))}${color.muted(caption)}──`
				: "─".repeat(Math.max(0, columns - 2));
			const borderPainter = color.border;
			const lines = [`${borderPainter("╭")}${borderPainter(topInside)}${borderPainter("╮")}`];
			const bodyWidth = Math.max(1, columns - 6);
			for (let index = 0; index < content.length; index++) {
				const prefix = index === 0 ? color.accent("❯") : " ";
				const rail = editorInputFocused() ? color.accent("▏") : borderPainter("│");
				lines.push(`${rail} ${prefix} ${toolBackground(pad(content[index], bodyWidth))} ${borderPainter("│")}`);
			}

			const modelId = state.model?.id || state.model?.name || t("status.noModel");
			const providerText = state.model?.provider || t("status.provider");
			const modelText = modelId;
			const modeText = `${t(`mode.${state.mode}`)}${state.thinking !== "off" ? ` · ${state.thinking}` : ""}`;
			const contextRaw = state.contextPercent == null ? t("status.contextUnknown") : `${formatPercent(state.contextPercent, locale)}%`;
			const metaRaw = ` ${contextRaw} · ${providerText}/${modelText} · ${modeText} `;
			const insideBudget = Math.max(1, columns - 4);
			const metaText = truncateToWidth(metaRaw, Math.max(1, Math.min(insideBudget - 1, Math.floor(insideBudget * 0.72))), "…");
			const fillWidth = Math.max(1, insideBudget - visibleWidth(metaText));
			const meta = state.contextPercent != null && state.contextPercent >= 85 ? color.error(metaText) : color.muted(metaText);
			lines.push(`${borderPainter("╰─")}${borderPainter("─".repeat(fillWidth))}${meta}${borderPainter("─╯")}`);
			const metaStart = 2 + fillWidth;
			const providerOffset = Math.max(0, metaText.indexOf(providerText));
			const modelOffset = Math.max(providerOffset, metaText.indexOf(modelText));
			const modeOffset = Math.max(modelOffset, metaText.indexOf(modeText));
			const providerWidth = Math.min(visibleWidth(providerText) + 1, Math.max(0, visibleWidth(metaText) - providerOffset));
			const modelWidth = Math.min(visibleWidth(modelText) + 1, Math.max(0, visibleWidth(metaText) - modelOffset));
			const modeWidth = Math.min(visibleWidth(modeText), Math.max(0, visibleWidth(metaText) - modeOffset));
			return {
				lines: lines.slice(0, Math.max(1, maxRows)),
				metaRow: lines.length - 1,
				providerX: metaStart + providerOffset,
				providerWidth,
				modelX: metaStart + modelOffset,
				modelWidth,
				modeX: metaStart + modeOffset,
				modeWidth,
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
			const initialEditorWidth = Math.max(1, estimatedInnerWidth - 6);
			const initialEditorLines = editorLinesFor(initialEditorWidth);
			const initialComposer = this.#grokComposer(estimatedInnerWidth, initialEditorLines, 13);
			const desiredPromptHeight = Math.max(1, Math.min(13, initialComposer.lines.length));
			const layout = computeAgentLayout({
				width: centerWidth,
				height,
				promptHeight: desiredPromptHeight,
				dockHeight: firstDock.length,
				// Progress belongs to the transcript in the Grok layout. Reserving a
				// second fixed status row produced the old duplicated "responding" bar.
				turnStatusHeight: 0,
				shortcutsHeight: 1,
			});
			const editorWidth = Math.max(1, layout.prompt.width - 6);
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
			const timelineCandidate = userTurnCount >= 2 && layout.scrollback.width >= 60;
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
		if (item.path === state.sessionFile) { toast(t("toast.alreadySession"), "info"); state.dialog = undefined; return; }
		toast(t("toast.restoring", { name: item.name || t("session.empty") }), "info");
		state.dialog = undefined;
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
				state.dialog = browser; tui.requestRender();
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
		if (dialog.searchable && matchesKey(data, "escape") && dialog.query) {
			dialog.query = ""; dialog.options = [...dialog.allOptions]; dialog.selected = 0; tui.requestRender(); return true;
		}
		if (matchesKey(data, "escape")) {
			finishDialog({ cancelled: true });
			return true;
		}
		if (dialog.kind === "input" || dialog.kind === "editor") return false;
		if (dialog.searchable && matchesKey(data, "backspace")) {
			dialog.query = [...dialog.query].slice(0, -1).join("");
			const needle = dialog.query.toLocaleLowerCase(); dialog.options = dialog.allOptions.filter((option) => `${option} ${dialog.descriptions?.get(option) || ""}`.toLocaleLowerCase().includes(needle)); dialog.selected = 0; tui.requestRender(); return true;
		}
		if (dialog.searchable && !data.includes("\x1b") && !/[\u0000-\u001f\u007f]/.test(data)) {
			dialog.query += data; const needle = dialog.query.toLocaleLowerCase(); dialog.options = dialog.allOptions.filter((option) => `${option} ${dialog.descriptions?.get(option) || ""}`.toLocaleLowerCase().includes(needle)); dialog.selected = 0; tui.requestRender(); return true;
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
			dialog.selected = (dialog.selected - 1 + dialog.options.length) % dialog.options.length;
			tui.requestRender(); return true;
		}
		if (matchesKey(data, "down") || matchesKey(data, "tab")) {
			dialog.selected = (dialog.selected + 1) % dialog.options.length;
			tui.requestRender(); return true;
		}
		if (dialog.kind === "multi") {
			const option = dialog.options[dialog.selected];
			if (matchesKey(data, "enter") || data === " ") toggleDialogTool(option);
			return true;
		}
		if (matchesKey(data, "enter")) {
			const value = dialog.options[dialog.selected];
			finishDialog(dialog.kind === "confirm" ? { confirmed: value === dialog.options[0] } : { value });
			return true;
		}
		return true;
	};

	const handleDialogMouse = (mouse) => {
		const dialog = state.dialog;
		if (!dialog) return false;
		if (dialog.kind === "sessions") {
			if (mouse.wheel && !mouse.release) { dialog.selected = Math.max(0, Math.min(Math.max(0, (dialog.visibleItems?.length || 1) - 1), dialog.selected + mouse.wheelDirection * 3)); tui.requestRender(); return true; }
			if (mouse.motion || mouse.release || !mouse.left) return true;
			if (dialog.mouseClose && mouse.x >= dialog.mouseClose.x && mouse.x < dialog.mouseClose.x + dialog.mouseClose.width && mouse.y === 0) { finishDialog({ cancelled: true }); return true; }
			const row = dialog.mouseRows?.find((entry) => entry.y === mouse.y);
			if (row) { dialog.selected = row.index; restoreSessionItem(dialog.visibleItems?.[row.index]); }
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
			dialog.selected = Math.max(0, Math.min(dialog.options.length - 1, dialog.selected + mouse.wheelDirection));
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
			if (dialog.kind === "multi") toggleDialogTool(value);
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
			case "timeline-turn": setTranscriptOffset(zone.offset); break;
			case "panel-body": break;
			case "composer": tui.setFocus(editor); break;
			case "home-action": void runHomeAction(zone.homeAction).catch((error) => toast(error?.message || String(error), "error")); break;
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
		if (state.terminalJob && !parseSgrMouse(data) && data !== FOCUS_IN && data !== FOCUS_OUT) {
			if (matchesKey(data, "ctrl+]")) { state.terminalJob = undefined; tui.requestRender(); return { consume: true }; }
			let input = decodeKittyPrintable(data) ?? data;
			for (const [key, value] of [["enter", "\r"], ["backspace", "\x7f"], ["up", "\x1b[A"], ["down", "\x1b[B"], ["right", "\x1b[C"], ["left", "\x1b[D"], ["tab", "\t"], ["escape", "\x1b"], ["ctrl+c", "\x03"], ["ctrl+d", "\x04"]]) if (matchesKey(data, key)) input = value;
			void taskClient.request("input", { id: state.terminalJob, data: input }).catch((error) => { state.terminalJob = undefined; toast(error.message, "error"); });
			return { consume: true };
		}
		if (!state.dialog && matchesKey(data, "alt+enter")) {
			const value = editor.getText();
			if (value.trim()) { editor.setText(""); void runInput(value, "followUp"); }
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
		if (!state.active && !editor.getText() && (matchesKey(data, "up") || matchesKey(data, "shift+tab"))) {
			state.homeSelected = (state.homeSelected - 1 + homeActionIds.length) % homeActionIds.length; tui.requestRender(); return { consume: true };
		}
		if (!state.active && !editor.getText() && matchesKey(data, "down")) {
			state.homeSelected = (state.homeSelected + 1) % homeActionIds.length; tui.requestRender(); return { consume: true };
		}
		if (matchesKey(data, "enter") && !state.active && !editor.getText()) {
			void runHomeAction(homeActionIds[state.homeSelected]).catch((error) => toast(error?.message || String(error), "error")); return { consume: true };
		}
		if (matchesKey(data, "ctrl+p")) { openPalette(); return { consume: true }; }
		if (matchesKey(data, "ctrl+s") && state.active) { openSessionsDialog(); return { consume: true }; }
		if (matchesKey(data, "shift+tab")) { void nextMode(); return { consume: true }; }
		if (matchesKey(data, "ctrl+b")) {
			if (!state.workspaceDeclared) askShowFiles();
			else { activate(); togglePanel("files"); tui.requestRender(); }
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+o")) { activate(); togglePanel("workflow"); tui.requestRender(); return { consume: true }; }
		if (matchesKey(data, "ctrl+t")) { activate(); togglePanel("todo"); tui.requestRender(); return { consume: true }; }
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
		if (matchesKey(data, "ctrl+e") && state.active) {
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
		if (event.toolCallId && event.toolName !== "todo") {
			let tool = state.liveTools.get(event.toolCallId);
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
		const nextOutput = clean(redactText(toolResultText(result)));
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
		if (status !== "running" && ["edit", "write", "bash"].includes(event.toolName)) tree.refresh();
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
			if (event.widgetKey === "tsukuyomi-providers-payload" && Array.isArray(event.widgetLines)) {
				try {
					const payload = JSON.parse(event.widgetLines.join("\n"));
					if (payload.changed && !state.working && !state.compacting) {
						setTimeout(() => shutdown(0, { restart: "provider", ...(state.sessionFile ? { session: state.sessionFile } : {}) }), 180);
						return;
					}
				} catch {}
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
		const kind = event.method;
		const options = kind === "confirm" ? [t("action.yes"), t("action.no")] : (event.options || []);
		clearTerminalSelection();
		state.dialog = {
			source: "pi",
			id: event.id,
			kind,
			title: event.title || t("dialog.plugin"),
			message: event.message || (kind === "input" ? event.placeholder : undefined),
			options,
			selected: 0,
			savedText: editor.getText(),
		};
		if (kind === "input") editor.setText("");
		if (kind === "editor") editor.setText(event.prefill || "");
		tui.requestRender();
	};

	const handleRpcEvent = (event) => {
		switch (event.type) {
			case "agent_start":
				state.working = true;
				if (!state.runWorkSince) state.runWorkSince = Date.now();
				activate();
				break;
			case "agent_settled":
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
				void refreshMessages({ settleStream: true, forceSettle: true }).finally(() => {
					if (!state.working) {
						clearStream();
						tui.requestRender();
					}
				});
				void refreshStats(); tree.refresh(); break;
			case "message_start":
				if (event.message?.role === "assistant") {
					clearStream();
					state.streamAssistantBaseline = state.messages.filter((message) => message?.role === "assistant").length;
					state.streamStartedAt = Date.now();
				}
				break;
			case "message_update": {
				const delta = event.assistantMessageEvent;
				if (delta?.type === "toolcall_delta" || delta?.type === "toolcall_start") {
					const part = delta.partial?.content?.[delta.contentIndex];
					if (part?.id && part.name) {
						updateWorkflow({ type: "tool_preview", toolCallId: part.id, toolName: part.name, args: part.arguments || {} }, "running");
						if (!state.stream.some((phase) => phase.id === part.id)) pushToolPhase({ toolCallId: part.id, toolName: part.name, args: part.arguments || {} });
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
			case "message_end":
				void refreshMessages({ settleStream: true }); break;
			case "tool_execution_start": updateWorkflow(event, "running", true); pushToolPhase(event); break;
			case "tool_execution_update": updateWorkflow(event, "running"); return;
			case "tool_execution_end": updateWorkflow(event, event.isError ? "error" : "done", true); markToolPhase(event.toolCallId, event.isError); break;
			case "queue_update":
				state.queued = (event.steering?.length || 0) + (event.followUp?.length || 0);
				state.widgets.set("queue", [...(event.steering || []).map((s) => `↪ ${locale === "zh" ? "纠正" : "Steer"}: ${s}`), ...(event.followUp || []).map((s) => `+ ${locale === "zh" ? "后续" : "Follow-up"}: ${s}`)]);
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
		if (job.cwd !== cwd || !job.toolCallId) return;
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
	// DECSCUSR 6 is a blinking vertical bar on terminals that support cursor
	// shape control. The hardware cursor remains at CURSOR_MARKER for IME use.
	terminal.write(CURSOR_BAR);
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
