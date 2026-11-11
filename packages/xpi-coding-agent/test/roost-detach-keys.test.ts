// builtin:roost, decision 11: in a session the daemon runs, the keys that would end or freeze it detach the attached
// terminal instead. They follow the user's keybindings (app.suspend once, app.clear twice, app.exit twice), plus the
// left arrow on an empty editor and a submitted /quit or /exit.
import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { DOUBLE_PRESS_MS, detachKeyHandler } from "../src/extensions/roost/detach-keys.ts";

function harness(bindings: ConstructorParameters<typeof KeybindingsManager>[0] = {}) {
	const kb = new KeybindingsManager(bindings);
	const state = { text: "", dialog: false, now: 10_000 };
	const out = { detached: 0, notes: [] as string[] };
	const handle = detachKeyHandler({
		keybindings: () => kb,
		detach: () => out.detached++,
		dialogOpen: () => state.dialog,
		editorText: () => state.text,
		setEditorText: (t) => {
			state.text = t;
		},
		notify: (m) => out.notes.push(m),
		now: () => state.now,
	});
	const press = (data: string) => handle(data)?.consume === true;
	return { press, state, out };
}

const CTRL_Z = "\x1a";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const LEFT = "\x1b[D";
const ENTER = "\r";

describe("detach keys (default keybindings)", () => {
	it("app.suspend detaches at once, in every encoding, also with a dialog open; not on its release", () => {
		const h = harness();
		expect(h.press(CTRL_Z)).toBe(true);
		expect(h.press("\x1b[122;5u")).toBe(true);
		h.state.dialog = true;
		expect(h.press(CTRL_Z)).toBe(true);
		expect(h.out.detached).toBe(3);
		expect(h.press("\x1b[122;5:3u")).toBe(false);
		expect(h.out.detached).toBe(3);
	});

	it("app.clear: the first press is xpi's (it clears the editor), the second within the window detaches", () => {
		const h = harness();
		h.state.text = "draft";
		expect(h.press(CTRL_C)).toBe(false);
		h.state.now += DOUBLE_PRESS_MS - 1;
		expect(h.press(CTRL_C)).toBe(true);
		expect(h.out.detached).toBe(1);
		// a third press starts over; one too late is a first press again
		expect(h.press(CTRL_C)).toBe(false);
		h.state.now += DOUBLE_PRESS_MS + 1;
		expect(h.press(CTRL_C)).toBe(false);
		expect(h.out.detached).toBe(1);
	});

	it("app.exit on an empty editor: the first press says to press again, the second detaches; never with text", () => {
		const h = harness();
		expect(h.press(CTRL_D)).toBe(true);
		expect(h.out.notes).toEqual(["ctrl+d again to detach (the session keeps running)"]);
		expect(h.out.detached).toBe(0);
		h.state.now += 100;
		expect(h.press(CTRL_D)).toBe(true);
		expect(h.out.detached).toBe(1);
		h.state.text = "x";
		expect(h.press(CTRL_D)).toBe(false);
	});

	it("the left arrow on an empty editor, and a submitted /quit or /exit", () => {
		const h = harness();
		expect(h.press(LEFT)).toBe(true);
		h.state.text = "abc";
		expect(h.press(LEFT)).toBe(false);
		h.state.text = " /quit ";
		expect(h.press(ENTER)).toBe(true);
		expect(h.state.text).toBe("");
		h.state.text = "/exit";
		expect(h.press(ENTER)).toBe(true);
		h.state.text = "/quitting";
		expect(h.press(ENTER)).toBe(false);
		expect(h.out.detached).toBe(3);
	});

	it("with a dialog open only app.suspend acts", () => {
		const h = harness();
		h.state.dialog = true;
		expect(h.press(LEFT)).toBe(false);
		expect(h.press(CTRL_D)).toBe(false);
		expect(h.press(CTRL_C)).toBe(false);
		h.state.now += 10;
		expect(h.press(CTRL_C)).toBe(false);
		h.state.text = "/quit";
		expect(h.press(ENTER)).toBe(false);
		expect(h.out.detached).toBe(0);
	});
});

describe("detach keys (rebound)", () => {
	it("follow the user's keybindings; the old defaults do nothing", () => {
		const h = harness({ "app.suspend": "ctrl+b", "app.clear": "ctrl+g", "app.exit": "ctrl+q" });
		expect(h.press(CTRL_Z)).toBe(false);
		expect(h.press(CTRL_D)).toBe(false);
		expect(h.press(CTRL_C)).toBe(false);
		h.state.now += 10;
		expect(h.press(CTRL_C)).toBe(false);
		expect(h.out.detached).toBe(0);
		expect(h.press("\x02")).toBe(true);
		expect(h.press("\x07")).toBe(false);
		h.state.now += 10;
		expect(h.press("\x07")).toBe(true);
		expect(h.press("\x11")).toBe(true);
		expect(h.out.notes).toEqual(["ctrl+q again to detach (the session keeps running)"]);
		h.state.now += 10;
		expect(h.press("\x11")).toBe(true);
		expect(h.out.detached).toBe(3);
	});

	it("an unbound app.suspend detaches on nothing; a rebound submit key still sends /quit away", () => {
		const h = harness({ "app.suspend": [], "tui.input.submit": "ctrl+s" });
		expect(h.press(CTRL_Z)).toBe(false);
		h.state.text = "/quit";
		expect(h.press(ENTER)).toBe(false);
		expect(h.press("\x13")).toBe(true);
	});
});
