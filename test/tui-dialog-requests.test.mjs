import test from "node:test";
import assert from "node:assert/strict";
import { createExtensionDialogQueue } from "../app/tui/dialog-requests.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup() {
	let busy = false;
	const shown = [];
	const responses = [];
	const broker = createExtensionDialogQueue({
		isBusy: () => busy,
		present: (request) => shown.push(request.id),
		respond: (response) => responses.push(response),
	});
	return { broker, shown, responses, setBusy: (value) => { busy = value; } };
}

test("PI extension requests queue behind local dialogs and answer FIFO once", async () => {
	const { broker, shown, responses, setBusy } = setup();
	setBusy(true);
	assert.equal(broker.enqueue({ id: "a", method: "select" }), true);
	assert.equal(broker.enqueue({ id: "b", method: "confirm" }), true);
	assert.deepEqual(shown, []);
	setBusy(false); broker.available(); await tick();
	assert.deepEqual(shown, ["a"]);
	assert.equal(broker.complete("b", { value: "wrong owner" }), false);
	assert.equal(broker.complete("a", { value: "yes", id: "forged" }), true);
	await tick();
	assert.deepEqual(shown, ["a", "b"]);
	assert.equal(broker.complete("b", { confirmed: false }), true);
	assert.equal(broker.complete("b", { confirmed: true }), false);
	assert.deepEqual(responses, [
		{ type: "extension_ui_response", id: "a", value: "yes" },
		{ type: "extension_ui_response", id: "b", confirmed: false },
	]);
});

test("replaced dialog cancels its owner without discarding queued requests", async () => {
	const { broker, shown, responses, setBusy } = setup();
	broker.enqueue({ id: 1 }); broker.enqueue({ id: 2 });
	setBusy(true);
	assert.equal(broker.cancelActive(), true);
	assert.equal(broker.cancelActive(), false);
	await tick();
	assert.deepEqual(shown, [1]);
	assert.deepEqual(responses, [{ type: "extension_ui_response", id: 1, cancelled: true }]);
	setBusy(false); broker.available(); await tick();
	assert.deepEqual(shown, [1, 2]);
	assert.equal(broker.complete(2, { value: "ok" }), true);
});

test("a failing presenter cancels its request and proceeds to the next", () => {
	const shown = [];
	const responses = [];
	let busy = true;
	const broker = createExtensionDialogQueue({
		isBusy: () => busy,
		present: (event) => { shown.push(event.id); if (event.id === "bad") throw new Error("render failed"); },
		respond: (value) => responses.push(value),
	});
	broker.enqueue({ id: "bad" }); broker.enqueue({ id: "good" });
	busy = false; broker.available();
	return tick().then(() => {
		assert.deepEqual(shown, ["bad", "good"]);
		assert.deepEqual(responses, [{ type: "extension_ui_response", id: "bad", cancelled: true }]);
		broker.close();
	});
});

test("expired RPC dialogs disappear and never block the next request", async () => {
	const shown = []; const responses = []; const expired = [];
	const broker = createExtensionDialogQueue({
		isBusy: () => false,
		present: (event) => shown.push(event.id),
		respond: (value) => responses.push(value),
		onExpired: (id) => expired.push(id),
	});
	broker.enqueue({ id: "old", timeout: 15 });
	broker.enqueue({ id: "later" });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(expired, ["old"]);
	assert.deepEqual(shown, ["old", "later"]);
	assert.deepEqual(responses, [{ type: "extension_ui_response", id: "old", cancelled: true }]);
	broker.close();
});

test("shutdown cancels both active and pending requests exactly once", async () => {
	const { broker, responses } = setup();
	assert.equal(broker.enqueue({ id: "one" }), true);
	assert.equal(broker.enqueue({ id: "one" }), false);
	assert.equal(broker.enqueue({ id: "two" }), true);
	broker.close(); broker.close();
	await tick();
	assert.equal(broker.enqueue({ id: "late" }), false);
	assert.equal(broker.complete("one", {}), false);
	assert.deepEqual(responses, [
		{ type: "extension_ui_response", id: "one", cancelled: true },
		{ type: "extension_ui_response", id: "two", cancelled: true },
	]);
});
