import { lstatSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

const IGNORE = new Set([
	".git", "node_modules", "dist", "build", ".cache", "target", "__pycache__",
	".tsukuyomi", ".pi", ".next", ".turbo", "coverage",
]);

function ignored(name) {
	if (IGNORE.has(name) || name === ".DS_Store") return true;
	return name.startsWith(".") && ![".gitignore", ".env", ".editorconfig"].includes(name);
}

export class WorkspaceTree {
	constructor(cwd) {
		this.cwd = cwd;
		this.expanded = new Set();
		this.rows = [];
		this.revision = 0;
		this.refresh();
	}

	get label() {
		return basename(this.cwd) || this.cwd;
	}

	#read(abs, depth) {
		let names;
		try {
			names = readdirSync(abs);
		} catch {
			return [];
		}
		const result = [];
		for (const name of names) {
			if (ignored(name)) continue;
			const child = join(abs, name);
			let dir;
			try {
				// lstat deliberately prevents directory symlinks escaping the workspace.
				dir = lstatSync(child).isDirectory();
			} catch {
				continue;
			}
			result.push({ name, abs: child, rel: relative(this.cwd, child), dir, depth });
		}
		result.sort((a, b) => a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1);
		return result;
	}

	refresh() {
		const rows = [];
		const visit = (abs, depth) => {
			for (const item of this.#read(abs, depth)) {
				rows.push(item);
				if (item.dir && this.expanded.has(item.rel)) visit(item.abs, depth + 1);
				if (rows.length >= 800) return;
			}
		};
		visit(this.cwd, 0);
		this.rows = rows;
		this.revision += 1;
	}

	toggle(rel) {
		const row = this.rows.find((item) => item.rel === rel);
		if (!row?.dir) return false;
		if (this.expanded.has(rel)) this.expanded.delete(rel);
		else this.expanded.add(rel);
		this.refresh();
		return true;
	}
}
