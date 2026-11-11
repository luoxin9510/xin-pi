/**
 * AT-3 and decision 11: in a session the daemon runs, the keys that would end or freeze it detach the attached terminal
 * instead, so the session keeps running. They follow the user's keybindings:
 *
 * - `app.suspend` (ctrl+z): detaches at once, also while a dialog is open. Suspended in the background, the session
 *   would freeze for good: nothing would continue it.
 * - `app.clear` twice (ctrl+c): the first press still clears the editor; a second one detaches instead of exiting.
 * - `app.exit` twice on an empty editor (ctrl+d): the first press says to press again.
 * - The left arrow on an empty editor (a fixed key, AGENTS.md's exemption: it is how the hub is left and entered).
 * - A submitted `/quit` or `/exit` (`/exit` is not an xpi command; it would go to the model).
 *
 * Key releases are skipped; while a dialog is open only `app.suspend` acts (the dialog has the keyboard).
 */

import { isKeyRelease, type KeybindingsManager, matchesKey } from "xpi-tui";

/** Two presses within this long count as twice. Longer than xpi's own 500 ms, so its second press never exits. */
export const DOUBLE_PRESS_MS = 1000;

export interface DetachKeyDeps {
	keybindings: () => Pick<KeybindingsManager, "matches" | "getKeys">;
	detach: () => void;
	dialogOpen: () => boolean;
	editorText: () => string;
	setEditorText: (text: string) => void;
	notify: (message: string) => void;
	now?: () => number;
}

/** A terminal input handler (`ctx.ui.onTerminalInput`): consumes the keys that detach. */
export function detachKeyHandler(d: DetachKeyDeps): (data: string) => { consume: true } | undefined {
	let lastClear = 0;
	let lastExit = 0;
	const now = d.now ?? Date.now;
	const consume = () => {
		d.detach();
		return { consume: true } as const;
	};
	return (data) => {
		if (isKeyRelease(data)) return undefined;
		const kb = d.keybindings();
		if (kb.matches(data, "app.suspend")) return consume();
		// The handler sees keys before any focused component, but the editor text is always the main editor's: a dialog
		// or an overlay keeps its keys.
		if (d.dialogOpen()) return undefined;
		if (kb.matches(data, "app.clear")) {
			// xpi clears a non-empty editor on the first press and exits on a second within 500 ms, whatever the editor
			// held: the second press is always taken here.
			const t = now();
			const second = t - lastClear < DOUBLE_PRESS_MS;
			lastClear = second ? 0 : t;
			return second ? consume() : undefined;
		}
		const empty = d.editorText().length === 0;
		if (empty && matchesKey(data, "left")) return consume();
		if (kb.matches(data, "tui.input.submit") && /^\/(?:exit|quit)$/.test(d.editorText().trim())) {
			d.setEditorText("");
			return consume();
		}
		if (empty && kb.matches(data, "app.exit")) {
			// xpi would exit on an empty editor, which would end the background session
			const t = now();
			if (t - lastExit < DOUBLE_PRESS_MS) {
				lastExit = 0;
				return consume();
			}
			lastExit = t;
			const key = kb.getKeys("app.exit")[0] ?? "app.exit";
			d.notify(`${key} again to detach (the session keeps running)`);
			return { consume: true };
		}
		return undefined;
	};
}
