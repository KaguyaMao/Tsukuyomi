#!/usr/bin/env node
/**
 * Deprecation shim: the `kaguyapi` command was renamed to `tsukuyomi`.
 *
 * This file exists only so existing shell aliases, desktop entries, and
 * packaged launchers keep working after the rename. It prints a one-line
 * deprecation notice and re-executes the real entry point, forwarding argv and
 * the exit code. New installs can delete it (and the `kaguyapi` entry in
 * package.json `bin`) to drop the alias entirely.
 *
 * Set TSUKUYOMI_QUIET_RENAME=1 to suppress the notice.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "tsukuyomi.mjs");
if (!process.env.TSUKUYOMI_QUIET_RENAME) {
	console.error("Tsukuyomi: `kaguyapi` was renamed to `tsukuyomi`; update your shortcut. (TSUKUYOMI_QUIET_RENAME=1 silences this.)");
}
const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
	stdio: "inherit",
	env: { ...process.env, TSUKUYOMI_RENAMED_FROM_KAGUYAPI: "1" },
});
process.exit(result.status === null ? 1 : result.status);
