import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

/**
 * Incremental newline-delimited JSON buffer.
 *
 * The RPC stream is one JSON object per line, but a single response (for example
 * `get_messages` on a long session) can be tens of megabytes. Accumulating the
 * response as a JS string and re-scanning it on every chunk is O(n^2): V8
 * flattens the growing rope on each `indexOf`, and each slice copies the tail.
 * This buffer keeps the incoming chunks in a queue, scans each chunk once with
 * the native Buffer search, and concatenates a line only when it is complete.
 */
export class LineBuffer {
	constructor() {
		this.chunks = [];
		this.scanIndex = 0;
		this.scanOffset = 0;
		this.lineIndex = 0;
		this.lineOffset = 0;
	}

	push(chunk) {
		if (chunk == null) return;
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
		if (buffer.length) this.chunks.push(buffer);
	}

	/**
	 * Take up to `maxLines` complete lines (or until `maxMs` elapses), preserving
	 * the trailing partial line for the next call. Returns whether complete lines
	 * may still be buffered so the caller can yield to the event loop.
	 */
	drain({ maxLines = 64, maxMs = 4 } = {}) {
		const startedAt = Date.now();
		const lines = [];
		let stoppedForBudget = false;
		for (;;) {
			if (lines.length >= maxLines || Date.now() - startedAt >= maxMs) {
				stoppedForBudget = true;
				break;
			}
			if (this.scanIndex >= this.chunks.length) break;
			const chunk = this.chunks[this.scanIndex];
			const newline = chunk.indexOf(0x0a, this.scanOffset);
			if (newline < 0) {
				this.scanOffset = 0;
				this.scanIndex += 1;
				continue;
			}
			lines.push(this.#line(newline).toString("utf8"));
			this.scanOffset = newline + 1;
			if (this.scanOffset >= chunk.length) {
				this.scanIndex += 1;
				this.scanOffset = 0;
			}
			this.lineIndex = this.scanIndex;
			this.lineOffset = this.scanOffset;
		}
		this.#compact();
		const more = stoppedForBudget && this.scanIndex < this.chunks.length;
		return { lines, more };
	}

	/** Concatenate the current line's chunks and the prefix ending at `endOffset`. */
	#line(endOffset) {
		const first = this.chunks[this.lineIndex];
		if (this.lineIndex === this.scanIndex) return first.subarray(this.lineOffset, endOffset);
		const parts = [];
		for (let index = this.lineIndex; index < this.scanIndex; index++) parts.push(this.chunks[index]);
		parts.push(this.chunks[this.scanIndex].subarray(this.lineOffset, endOffset));
		return Buffer.concat(parts);
	}

	#compact() {
		if (this.lineIndex > 0) {
			this.chunks.splice(0, this.lineIndex);
			this.scanIndex -= this.lineIndex;
			this.lineIndex = 0;
		}
		// Drop the consumed prefix of the current line's first chunk. The scan
		// cursor only moves with it when it points into that same chunk.
		if (this.lineOffset > 0 && this.chunks.length) {
			this.chunks[0] = this.chunks[0].subarray(this.lineOffset);
			if (this.scanIndex === 0) this.scanOffset -= this.lineOffset;
			this.lineOffset = 0;
		}
	}
}

export class PiRpc {
	constructor(piBin, args, env, cwd = process.cwd()) {
		this.piBin = piBin;
		this.args = args;
		this.env = env;
		this.cwd = cwd;
		this.child = undefined;
		this.lineBuffer = new LineBuffer();
		this.stdoutDrainScheduled = undefined;
		this.stderrBuffer = "";
		this.sequence = 0;
		this.pending = new Map();
		this.listeners = new Set();
		this.stderrListeners = new Set();
		this.exitListeners = new Set();
		this.stopping = false;
	}

	onEvent(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onStderr(listener) {
		this.stderrListeners.add(listener);
		return () => this.stderrListeners.delete(listener);
	}

	onExit(listener) {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	start() {
		if (this.child) return;
		// Only use socat when explicitly configured. Its EXEC address parser cannot
		// reliably pass JavaScript paths containing non-ASCII characters (for
		// example this project's `/文档/` path), which makes every worker exit
		// before PI starts. Node's pipes are sufficient for the RPC stream and are
		// the portable default; set TSUKUYOMI_SOCAT to opt into a PTY when needed.
		const socat = process.env.TSUKUYOMI_SOCAT || process.env.KAGUYAPI_SOCAT;
		// npm exposes pi through a shell shim. Running the resolved JavaScript
		// entry with this Node executable also works in packaged environments
		// whose PATH intentionally omits node.
		let executable = this.piBin;
		try {
			const resolved = realpathSync(this.piBin);
			if (/\.[cm]?js$/.test(resolved)) executable = process.execPath;
		} catch {}
		const piCommand = executable === process.execPath ? [executable, realpathSync(this.piBin)] : [executable];
		if (existsSync(socat)) {
			// A PTY keeps the RPC stream live on installations where PI pauses a
			// plain child-process stdin during async startup.
			const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
			const command = [...piCommand, "--mode", "rpc", ...this.args].map(quote).join(" ");
			this.child = spawn(socat, ["-", `EXEC:${command},pty,rawer,echo=0`], {
				stdio: ["pipe", "pipe", "pipe"],
				env: this.env,
				cwd: this.cwd,
			});
		} else {
			// Node's direct pipes are enough for current PI releases and avoid a
			// mandatory system package on minimal containers and Flatpak hosts.
			this.child = spawn(executable, [...piCommand.slice(1), "--mode", "rpc", ...this.args], {
				stdio: ["pipe", "pipe", "pipe"],
				env: this.env,
				cwd: this.cwd,
			});
		}
		// stdout stays as Buffers so LineBuffer can scan each chunk natively and
		// only decode a line once it is complete (multi-byte safe across chunks).
		this.child.stderr.setEncoding("utf8");
		// A kernel can exit between request scheduling and stdin.write(). Keep the
		// resulting broken pipe inside the RPC lifecycle instead of crashing Node.
		this.child.stdin.on("error", (error) => this.#finish(error));
		this.child.stdout.on("data", (chunk) => this.#consumeStdout(chunk));
		this.child.stderr.on("data", (chunk) => this.#consumeStderr(chunk));
		this.child.on("error", (error) => this.#finish(error));
		this.child.on("exit", (code, signal) => this.#finish(
			new Error(signal ? `PI kernel exited with ${signal}` : `PI kernel exited with code ${code ?? 1}`),
			code,
			signal,
		));
	}

	#consumeStdout(chunk) {
		this.lineBuffer.push(chunk);
		if (this.stdoutDrainScheduled) return;
		// Match Grok Build's bounded stream drain: a large RPC read must not
		// monopolize the JS turn while keyboard data is waiting in the terminal
		// pipe. Preserve ordering, but yield after one small batch/time slice.
		const { lines, more } = this.lineBuffer.drain({ maxLines: 32, maxMs: 4 });
		for (const line of lines) this.#handleStdoutLine(line);
		if (more) {
			this.stdoutDrainScheduled = setImmediate(() => {
				this.stdoutDrainScheduled = undefined;
				this.#consumeStdout("");
			});
			this.stdoutDrainScheduled.unref?.();
		}
	}

	#handleStdoutLine(line) {
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line) return;
		let value;
		try {
			value = JSON.parse(line);
		} catch {
			this.#emitStderr(`Non-JSON output from PI: ${line}`);
			return;
		}
		if (value.type === "response" && value.id && this.pending.has(value.id)) {
			const pending = this.pending.get(value.id);
			this.pending.delete(value.id);
			clearTimeout(pending.timer);
			if (value.success) pending.resolve(value.data);
			else pending.reject(new Error(value.error || `${value.command || "RPC"} failed`));
			return;
		}
		for (const listener of this.listeners) listener(value);
	}

	#consumeStderr(chunk) {
		if (this.stopping) return;
		this.stderrBuffer += chunk;
		for (;;) {
			const newline = this.stderrBuffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.stderrBuffer.slice(0, newline).replace(/\r$/, "");
			this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
			if (line.trim()) this.#emitStderr(line);
		}
	}

	#emitStderr(line) {
		for (const listener of this.stderrListeners) listener(line);
	}

	#finish(error, code, signal) {
		if (!this.child) return;
		this.child = undefined;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		if (!this.stopping) {
			for (const listener of this.exitListeners) listener({ error, code, signal });
		}
	}

	write(value) {
		if (!this.child?.stdin.writable) throw new Error("PI kernel is not running");
		this.child.stdin.write(`${JSON.stringify(value)}\n`);
	}

	request(command, timeoutMs = 10 * 60_000) {
		const id = `tsukuyomi-${++this.sequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${command.type} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.write({ ...command, id });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	respond(value) {
		this.write(value);
	}

	stop() {
		const child = this.child;
		if (!child) return;
		this.stopping = true;
		child.kill("SIGTERM");
		setTimeout(() => {
			if (this.child === child) child.kill("SIGKILL");
		}, 300).unref();
	}
}
