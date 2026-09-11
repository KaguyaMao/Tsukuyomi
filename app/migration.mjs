import { createHash } from "node:crypto";
import { existsSync, lstatSync, statSync, realpathSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, chmodSync, openSync, closeSync } from "node:fs";
import { dirname, join, resolve, relative, basename, isAbsolute } from "node:path";

const VERSION = 1;
const resources = ["extensions", "skills", "prompts", "themes", "packages"];
/**
 * Files renamed by the kaguyapi -> Tsukuyomi rename. Applied while importing so
 * a `~/.kaguyapi/agent` tree lands as a valid `~/.tsukuyomi/agent` tree without
 * the reader needing its own legacy fallback.
 */
const LEGACY_FILE_RENAMES = new Map([
	["kaguya.json", "tsukuyomi.json"],
	["kaguya-tools.json", "tsukuyomi-tools.json"],
	["kaguya-web.json", "tsukuyomi-web.json"],
]);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const inside = (root, path) => path === root || (!relative(root, path).startsWith("..") && !isAbsolute(relative(root, path)));
function json(path, fallback = {}) {
	try { return JSON.parse(readFileSync(path, "utf8")); }
	catch (error) { if (error.code === "ENOENT") return fallback; throw new Error(`Cannot read migration JSON: ${path} (${error.code || "invalid JSON"})`); }
}
function atomic(path, data, mode = 0o600) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.migration-tmp`;
	writeFileSync(temp, data, { mode }); chmodSync(temp, mode); renameSync(temp, path);
}
function merge(base, preferred) {
	if (!base || !preferred || typeof base !== "object" || typeof preferred !== "object" || Array.isArray(base) || Array.isArray(preferred)) return preferred;
	const out = { ...base };
	for (const [key, value] of Object.entries(preferred)) out[key] = key in out ? merge(out[key], value) : value;
	return out;
}

/** Copy-once importer. Source files are never changed; the ledger also records skips. */
export function migrate({ target, sources = [], appRoot, dryRun = false }) {
	target = resolve(target);
	sources = [...new Set(sources.map((path) => resolve(path)))].filter((path) => path !== target && existsSync(path) && (!existsSync(target) || realpathSync(path) !== realpathSync(target)));
	for (const source of sources) if (inside(source, target) || inside(target, source)) throw new Error("Migration source and target must be separate agent directories");
	const metadata = join(target, ".migration");
	const ledgerPath = join(metadata, "ledger.json");
	const ledger = json(ledgerPath, { version: VERSION, files: {}, sources: [] });
	const report = { version: VERSION, copied: [], conflicts: [], skipped: [], errors: [], dryRun };
	let lock;
	if (!dryRun) {
		mkdirSync(metadata, { recursive: true, mode: 0o700 });
		const lockPath = join(metadata, "lock");
		if (existsSync(lockPath)) {
			const owner = Number(readFileSync(lockPath, "utf8"));
			try { process.kill(owner, 0); throw new Error("Another migration is running"); }
			catch (error) { if (error.code !== "ESRCH") throw error; unlinkSync(lockPath); }
		}
		lock = openSync(lockPath, "wx", 0o600); writeFileSync(lock, String(process.pid));
	}
	const saveLedger = () => { if (!dryRun) atomic(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`); };
	const copiedPaths = new Map();
	const sessionHashes = new Set();
	const indexSessions = (directory) => {
		if (!existsSync(directory)) return;
		for (const name of readdirSync(directory)) {
			if (name === ".trash") continue;
			const path = join(directory, name), info = lstatSync(path);
			if (info.isDirectory()) indexSessions(path);
			else if (info.isFile() && name.endsWith(".jsonl")) sessionHashes.add(hash(readFileSync(path)));
		}
	};
	indexSessions(join(target, "sessions"));
	const copy = (source, destination, ancestors = new Set(), force = false) => {
		const key = `${source}\0${destination}`;
		if (!force && ledger.files[key]) return;
		let info, actual;
		try { info = statSync(source); actual = realpathSync(source); }
		catch (error) { report.errors.push({ path: source, error: error.code }); return; }
		if (ancestors.has(actual)) { report.errors.push({ path: source, error: "symlink cycle" }); return; }
		if (info.isDirectory()) {
			if (existsSync(destination) && !statSync(destination).isDirectory()) {
				destination = join(metadata, "conflicts", hash(source).slice(0, 16), basename(destination));
				report.conflicts.push({ source, saved: destination });
			}
			if (!dryRun) mkdirSync(destination, { recursive: true, mode: info.mode & 0o777 });
			const next = new Set([...ancestors, actual]);
			for (const name of readdirSync(source).sort()) {
				if (name === ".migration" || name.endsWith(".migration-tmp")) continue;
				copy(join(source, name), join(destination, name), next, force);
			}
			return;
		}
		if (!info.isFile()) { report.skipped.push(source); return; }
		const bytes = readFileSync(source), digest = hash(bytes);
		const session = inside(join(target, "sessions"), destination) && destination.endsWith(".jsonl") && !destination.includes("/.trash/");
		if (session && sessionHashes.has(digest)) { ledger.files[key] = digest; report.skipped.push(source); return; }
		let output = destination;
		if (existsSync(destination)) {
			const destInfo = statSync(destination);
			if (destInfo.isFile() && hash(readFileSync(destination)) === digest && !lstatSync(destination).isSymbolicLink()) {
				ledger.files[key] = digest; report.skipped.push(source); return;
			}
			if (!force) {
				output = session ? join(target, "sessions", "imported-conflicts", hash(source).slice(0, 16), basename(destination)) : join(metadata, "conflicts", hash(source).slice(0, 16), basename(destination));
				report.conflicts.push({ source, target: destination, saved: output });
			}
		}
		if (!dryRun) atomic(output, bytes, info.mode & 0o777);
		copiedPaths.set(source, output); ledger.files[key] = digest;
		if (session) sessionHashes.add(digest);
		report.copied.push({ source, target: output });
	};
	try {
		// Materialize old bootstrap links before merging so writes cannot affect pi.
		const detach = (directory, seen = new Set()) => {
			if (!existsSync(directory)) return;
			for (const name of readdirSync(directory)) {
				if (name === ".migration") continue;
				const path = join(directory, name), info = lstatSync(path);
				if (info.isSymbolicLink()) {
					let source; try { source = realpathSync(path); } catch { report.errors.push({ path, error: "broken symlink" }); continue; }
					if (seen.has(source)) continue;
					const staged = join(metadata, "materialized", hash(path).slice(0, 16));
					copy(source, staged, new Set(), true);
					if (!dryRun) { renameSync(path, join(metadata, `link-${hash(path).slice(0, 16)}`)); renameSync(staged, path); }
				} else if (info.isDirectory()) detach(path, seen);
			}
		};
		if (!ledger.detached) { detach(target); ledger.detached = true; }
		let settings = json(join(target, "settings.json"));
		// Backend-extension predicates, defined before the import loop so both the
		// loop and the appRoot block below can use them.
		const backend = appRoot ? join(appRoot, "src", "backend.ts") : undefined;
		const LEGACY_PACKAGE_NAMES = new Set(["tsukuyomi", "kaguyapi"]);
		const packageNameOf = (path) => {
			try { return json(join(path, "package.json")).name; } catch { return undefined; }
		};
		// A backend extension owned by this app or by a previous kaguyapi /
		// tsukuyomi install. Pruning these prevents a migrated config from loading
		// two backends (the old one would re-register the same tools).
		const legacyBackend = (entry) => {
			if (!appRoot || typeof entry !== "string" || /^[!+-]/.test(entry)) return false;
			if ([join(appRoot, "src"), join(appRoot, "src/index.ts"), backend].includes(entry)) return true;
			const parent = entry.endsWith("/src") ? dirname(entry) : dirname(dirname(entry));
			try {
				return /\/src(?:\/index\.ts|\/backend\.ts)?$/.test(entry) && LEGACY_PACKAGE_NAMES.has(packageNameOf(parent));
			} catch { return false; }
		};
		// A backend copied into `imported/<hash>/backend.ts` from a foreign install.
		// Matched by name so an old absolute path that pointed outside the source
		// tree is pruned even after being rewritten.
		const foreignBackend = (entry) =>
			Boolean(appRoot) &&
			typeof entry === "string" &&
			!/^[!+-]/.test(entry) &&
			/\/(?:src\/)?backend\.ts$/.test(entry.replace(/\\/g, "/")) &&
			resolve(target, entry) !== backend;
		// Preserve the pre-migration settings.json exactly once. The flag is set
		// even when the file is absent, so a later run does not mistake the
		// settings.json we just wrote for a user original.
		if (!ledger.originalSaved) {
			if (existsSync(join(target, "settings.json"))) {
				copy(join(target, "settings.json"), join(metadata, "originals", "tsukuyomi-settings.json"));
			}
			ledger.originalSaved = true;
		}
		const pendingSources = sources.filter((source) => !ledger.sources.includes(source));
		for (const source of pendingSources) {
			for (const name of readdirSync(source).sort()) {
				if (name === ".migration") continue;
				if (name === "settings.json") continue;
				const targetName = LEGACY_FILE_RENAMES.get(name) ?? name;
				const from = join(source, name), to = join(target, targetName);
				// Merge independent provider/settings keys, retaining both originals.
				if (["auth.json", "models.json", "models-store.json", "keybindings.json", "trust.json"].includes(name) && existsSync(to)) {
					copy(from, join(metadata, "originals", hash(source).slice(0, 12), name));
					copy(to, join(metadata, "originals", "tsukuyomi", name));
					const value = merge(json(from), json(to));
					if (!dryRun) atomic(to, `${JSON.stringify(value, null, 2)}\n`);
				} else copy(from, to);
			}
			const imported = json(join(source, "settings.json"));
			if (existsSync(join(source, "settings.json"))) copy(join(source, "settings.json"), join(metadata, "originals", hash(source).slice(0, 12), "settings.json"));
			const rewrite = (entry, resource) => {
				if (typeof entry !== "string") return entry && typeof entry === "object" ? { ...entry, source: rewrite(entry.source, "packages") } : entry;
				const prefix = /^[!+-]/.test(entry) ? entry[0] : "";
				let value = entry.slice(prefix.length), file = value.startsWith("file:");
				if (file) value = value.slice(5);
				if (resource === "packages" && !file && !value.startsWith(".") && !value.startsWith("/") && !value.startsWith("~")) return entry;
				const absolute = value.startsWith("~/") ? resolve(dirname(dirname(source)), value.slice(2)) : resolve(source, value);
				let destination = inside(source, absolute) ? join(target, relative(source, absolute)) : join(target, "imported", hash(absolute).slice(0, 12), basename(absolute));
				if (!inside(source, absolute) && existsSync(absolute)) copy(absolute, destination);
				// Existing bootstrap paths to the source must point to the new owner.
				return `${prefix}${file ? "file:" : ""}${destination}`;
			};
			const next = merge(imported, settings);
			for (const resource of resources) {
				const existing = (settings[resource] || []).map((entry) => {
					if (typeof entry === "string" && entry.includes(source)) return entry.replace(source, target);
					return entry;
				});
				// Never import a foreign/legacy backend extension; the app appends
				// its own below.
				const importedEntries = (imported[resource] || [])
					.filter((entry) => resource !== "extensions" || !legacyBackend(entry))
					.map((entry) => rewrite(entry, resource));
				const combined = [...importedEntries, ...existing];
				const unique = new Map();
				for (const entry of combined) {
					const id = typeof entry === "string" ? entry : entry.source;
					if (id === join(target, resource)) continue; // already auto-discovered
					unique.set(id, entry);
				}
				next[resource] = [...unique.values()];
			}
			settings = next;
			ledger.sources.push(source);
		}
		if (appRoot) {
			settings.extensions = [...new Set((settings.extensions || []).filter((entry) => !legacyBackend(entry) && !foreignBackend(entry))), backend];
			// pi auto-discovers these files; deduplicate identical plugin trees without deleting copies.
			const candidates = [];
			const auto = join(target, "extensions");
			if (existsSync(auto)) for (const name of readdirSync(auto)) {
				const path = join(auto, name);
				if (/\.[cm]?[jt]s$/.test(name) || statSync(path).isDirectory()) candidates.push(path);
			}
			for (const entry of settings.extensions) if (typeof entry === "string" && !/^[!+-]/.test(entry) && existsSync(resolve(target, entry)) && !candidates.includes(resolve(target, entry))) candidates.push(resolve(target, entry));
		const fingerprint = (path, seen = new Set()) => {
			const actual = realpathSync(path); if (seen.has(actual)) return "cycle";
			const next = new Set([...seen, actual]);
			if (statSync(path).isFile()) return hash(readFileSync(path));
			return hash(readdirSync(path).sort().filter((name) => !["node_modules", ".git"].includes(name)).map((name) => `${name}:${fingerprint(join(path, name), next)}`).join("\n"));
		};
		const known = new Map();
			const officialPath = join(appRoot, "src/vendor/plan-mode/index.ts");
			const officialHash = existsSync(officialPath) ? hash(readFileSync(officialPath)) : undefined;
			for (const path of candidates) {
				if (path === backend) continue;
				const key = fingerprint(path), entry = statSync(path).isDirectory() ? join(path, "index.ts") : path;
				const official = officialHash && existsSync(entry) && hash(readFileSync(entry)) === officialHash;
				if (official || known.has(key)) {
					settings.extensions = settings.extensions.filter((value) => typeof value !== "string" || /^[!+-]/.test(value) || resolve(target, value) !== path);
					settings.extensions.push(`!${path}`); report.skipped.push(path);
				} else known.set(key, path);
			}
			// Remove explicit auto-discovery duplicates left by older bootstraps.
			for (const key of resources) settings[key] = (settings[key] || []).filter((entry) => entry !== join(target, key));
		}
		if (report.errors.length) throw new Error(`Migration incomplete: ${report.errors.map((item) => `${item.path}: ${item.error}`).join("; ")}`);
		if (!dryRun) {
			for (const directory of ["sessions", "extensions", "themes"]) mkdirSync(join(target, directory), { recursive: true, mode: 0o700 });
			atomic(join(target, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
			saveLedger(); atomic(join(metadata, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
		}
		return report;
	} finally {
		if (lock !== undefined) { closeSync(lock); unlinkSync(join(metadata, "lock")); }
	}
}
