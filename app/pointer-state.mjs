/**
 * Small pointer-capture state machine used by the application hit-test layer.
 *
 * Terminal mouse protocols are streams of press/motion/release records rather
 * than DOM pointer events. Keeping ownership explicit prevents a click on a
 * control or the composer from leaking into the fullscreen text selector.
 */
export class PointerCapture {
	constructor() {
		this.owner = undefined;
		this.button = undefined;
		this.generation = 0;
	}

	press(owner, button) {
		this.owner = owner;
		this.button = button & 3;
		this.generation += 1;
		return this.generation;
	}

	owns(owner) {
		return this.owner === owner;
	}

	isActive() {
		return this.owner !== undefined;
	}

	matchesButton(button) {
		return this.button === (button & 3);
	}

	release(button) {
		if (!this.isActive() || !this.matchesButton(button)) return false;
		this.cancel();
		return true;
	}

	cancel() {
		this.owner = undefined;
		this.button = undefined;
		this.generation += 1;
	}
}

/**
 * Decode one SGR mouse report (CSI < b ; x ; y M/m).
 *
 * Wheel reports use button bits 64/65 and must not also look like a middle
 * button. Treating 65 as `middle` causes a wheel-down event to read PRIMARY
 * selection text and insert it into the composer.
 */
export function parseSgrMouse(data) {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/.exec(data);
	if (!match) return undefined;
	const button = Number(match[1]);
	const baseButton = button & 3;
	const wheel = (button & 64) !== 0;
	const release = match[4] === "m" && !wheel;
	return {
		button,
		x: Number(match[2]) - 1,
		y: Number(match[3]) - 1,
		release,
		left: !wheel && baseButton === 0,
		middle: !wheel && baseButton === 1,
		right: !wheel && baseButton === 2,
		wheel,
		wheelDirection: wheel ? (baseButton === 0 ? -1 : 1) : 0,
		motion: (button & 32) !== 0,
	};
}

export function isFocusEvent(data) {
	return data === "\x1b[I" || data === "\x1b[O";
}
