/** Serialize Pi extension UI requests; each accepted request receives at most one
 * response, even if modal state is replaced or the application shuts down. */
export function createExtensionDialogQueue({ present, respond, isBusy, onExpired = () => {} }) {
	const pending = [];
	const ids = new Set();
	const timers = new Map();
	let active;
	let closed = false;
	const forget = (id) => { ids.delete(id); clearTimeout(timers.get(id)); timers.delete(id); };
	const cancelled = (id) => respond({ type: "extension_ui_response", id, cancelled: true });
	const expire = (id) => {
		if (!ids.has(id) || closed) return;
		if (active?.id === id) { active = undefined; onExpired(id); }
		else { const index = pending.findIndex((item) => item.id === id); if (index >= 0) pending.splice(index, 1); }
		forget(id); cancelled(id); queueMicrotask(pump);
	};
	const pump = () => {
		if (closed || active || isBusy()) return;
		while (pending.length) {
			const event = pending.shift();
			active = event;
			try { present(event); return; }
			catch { active = undefined; forget(event.id); cancelled(event.id); }
		}
	};
	return {
		enqueue(event) {
			if (closed || event?.id == null || ids.has(event.id)) return false;
			ids.add(event.id);
			pending.push(event);
			if (Number.isFinite(event.timeout) && event.timeout > 0) {
				// Expire locally before the RPC endpoint's timeout; never display a
				// stale permission dialog after the kernel has already moved on.
				const timer = setTimeout(() => expire(event.id), Math.max(1, event.timeout - 50));
				timer.unref?.(); timers.set(event.id, timer);
			}
			pump();
			return true;
		},
		complete(id, response) {
			if (!active || active.id !== id || !ids.has(id)) return false;
			active = undefined;
			forget(id);
			respond({ ...response, type: "extension_ui_response", id });
			// A dialog result callback can open another local modal synchronously.
			// Drain in a microtask so it never stomps on that modal.
			queueMicrotask(pump);
			return true;
		},
		available() { queueMicrotask(pump); },
		cancelActive() {
			if (!active) return false;
			const id = active.id;
			active = undefined;
			forget(id);
			cancelled(id);
			queueMicrotask(pump);
			return true;
		},
		close() {
			if (closed) return;
			closed = true;
			if (active) { cancelled(active.id); active = undefined; }
			for (const event of pending) cancelled(event.id);
			pending.length = 0;
			for (const id of ids) forget(id);
		},
		get length() { return pending.length + (active ? 1 : 0); },
	};
}
