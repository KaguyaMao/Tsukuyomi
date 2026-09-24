// Include nested TUI and provider modules without relying on Unix shell globs.
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function* sources(directory) {
	for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) yield* sources(path);
		else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) yield path;
	}
}
for (const file of [...sources("bin"), ...sources("app")]) {
	const child = spawnSync(process.execPath, ["--check", join(root, file)], { stdio: "inherit" });
	if (child.error) throw child.error;
	if (child.status !== 0) process.exit(child.status ?? 1);
}
