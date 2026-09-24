/* Pure display helpers shared by TUI components; keep output stable while
 * splitting the interactive root into independently testable responsibilities. */

export function formatTime(value, locale = "en") {
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

export function formatAgo(value, locale = "en", now = Date.now()) {
	const seconds = Math.max(0, Math.floor((now - Number(value || 0)) / 1000));
	if (seconds < 60) return locale === "zh" ? "刚刚" : "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return locale === "zh" ? `${minutes} 分钟前` : `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return locale === "zh" ? `${hours} 小时前` : `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return locale === "zh" ? `${days} 天前` : `${days}d ago`;
}

export function formatDuration(totalSeconds, locale = "en") {
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

export const TOOL_LABEL_KEYS = Object.freeze({
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
});

export function toolLabel(name, args, translate = (key) => key) {
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
