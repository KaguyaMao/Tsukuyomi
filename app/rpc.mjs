import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

export class PiRpc {
	constructor(piBin, args, env, cwd = process.cwd()) {
		this.piBin = piBin;
		this.args = args;
		this.env = env;
		this.cwd = cwd;
		this.child = undefined;
		this.stdoutBuffer = "";
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
		const socat = process.env.TSUKUYOMI_SOCAT || process.env.KAGUYAPI_SOCAT || "/usr/bin/socat";
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
		this.child.stdout.setEncoding("utf8");
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
		this.stdoutBuffer += chunk;
		if (this.stdoutDrainScheduled) return;
		const startedAt = Date.now();
		let drained = 0;
		for (;;) {
			// Match Grok Build's bounded stream drain: a large RPC read must not
			// monopolize the JS turn while keyboard data is waiting in the terminal
			// pipe. Preserve ordering, but yield after one small batch/time slice.
			if (drained >= 32 || Date.now() - startedAt >= 4) {
				if (this.stdoutBuffer.includes("\n")) {
					this.stdoutDrainScheduled = setImmediate(() => {
						this.stdoutDrainScheduled = undefined;
						this.#consumeStdout("");
					});
					this.stdoutDrainScheduled.unref?.();
				}
				break;
			}
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline < 0) break;
			let line = this.stdoutBuffer.slice(0, newline);
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			drained += 1;
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) continue;
			let value;
			try {
				value = JSON.parse(line);
			} catch {
				this.#emitStderr(`Non-JSON output from PI: ${line}`);
				continue;
			}
			if (value.type === "response" && value.id && this.pending.has(value.id)) {
				const pending = this.pending.get(value.id);
				this.pending.delete(value.id);
				clearTimeout(pending.timer);
				if (value.success) pending.resolve(value.data);
				else pending.reject(new Error(value.error || `${value.command || "RPC"} failed`));
				continue;
			}
			for (const listener of this.listeners) listener(value);
		}
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
