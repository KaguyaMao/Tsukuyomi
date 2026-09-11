import { spawn } from "node:child_process";

export function browserCommand(target, platform = process.platform) {
	if (platform === "darwin") return ["open", [target]];
	if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", target]];
	return ["xdg-open", [target]];
}

/** Open http(s) URLs in the desktop browser. Never uses a shell. */
export function openUrl(target) {
	const url = String(target || "").trim();
	if (!/^https?:\/\//i.test(url)) return false;
	const [cmd, args] = browserCommand(url);
	spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
	return true;
}
