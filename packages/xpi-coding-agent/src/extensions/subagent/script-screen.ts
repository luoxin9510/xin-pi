// The script screen: a full-terminal overlay that shows one codemode script, opened with Enter on a script row of the panel.
// Like the subagent screen it is a view only and main keeps running underneath. It shows what the script has done so far:
// the tool calls it made with status and duration, its log() lines, its code, the live output of the call that runs
// now (or the last one), and the result or error once it ends. It follows the live end; ↑ ↓ PgUp PgDn scroll.
// Keys are fixed: esc back, x stop the script.

import { type Component, matchesKey, type TUI, truncateToWidth } from "xpi-tui";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { type ScriptCall, type ScriptRecord, scriptLabel, scripts } from "./background.ts";
import { COLORS, ICONS, type SubagentStatus } from "./registry.ts";

const CODE_LINES = 20; // lines of the script's code shown before it is cut

export const scriptStatus = (s: ScriptRecord): SubagentStatus =>
	s.state === "foreground" || s.state === "background" ? "running" : s.state;

export const elapsed = (ms: number) =>
	ms < 60_000
		? `${Math.floor(ms / 1000)}s`
		: `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;

const callStatus = (c: ScriptCall): SubagentStatus =>
	c.status === "running" ? "running" : c.status === "done" ? "completed" : "failed";

export class ScriptScreen implements Component {
	private offset = 0; // lines scrolled up from the bottom; 0 follows the live end
	private notice = "";
	private timer: ReturnType<typeof setInterval>;
	private unsubscribe: () => void;

	private tui: TUI;
	private theme: Theme;
	private id: string;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, id: string, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.id = id;
		this.done = done;
		this.unsubscribe = scripts.subscribe(() => this.tui.requestRender());
		// The elapsed time of a running script moves without any event.
		this.timer = setInterval(() => {
			if (scripts.get(this.id)?.endedAt === undefined) this.tui.requestRender();
		}, 1000);
		this.timer.unref();
	}

	handleInput(data: string): void {
		const page = Math.max(1, this.tui.terminal.rows - 6);
		this.notice = "";
		if (matchesKey(data, "escape")) {
			this.done();
			return;
		}
		if (matchesKey(data, "x")) {
			const script = scripts.get(this.id);
			if (script && script.endedAt === undefined) {
				this.notice = "stopping...";
				void scripts.stop(this.id);
			} else this.notice = "the script is not running";
		} else if (matchesKey(data, "pageUp")) this.offset += page;
		else if (matchesKey(data, "pageDown")) this.offset = Math.max(0, this.offset - page);
		else if (matchesKey(data, "up")) this.offset += 1;
		else if (matchesKey(data, "down")) this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, "home")) this.offset = Number.MAX_SAFE_INTEGER;
		else if (matchesKey(data, "end")) this.offset = 0;
		this.tui.requestRender();
	}

	// The scrollable part: calls, log, code, then the output of the call that runs now (else the last), then the result.
	private body(script: ScriptRecord): string[] {
		const t = this.theme;
		const now = Date.now();
		const lines: string[] = [];
		const title = (text: string) => lines.push("", t.fg("muted", ` ${text}`));

		title(`Calls (${script.calls.length})`);
		if (script.calls.length === 0) lines.push(t.fg("dim", "   none yet"));
		for (const c of script.calls) {
			const status = callStatus(c);
			const took = elapsed((c.endedAt ?? now) - c.startedAt);
			lines.push(
				`   ${t.fg(COLORS[status], ICONS[status])} ${c.name}${c.label ? ` ${c.label}` : ""} ${t.fg("muted", took)}`,
			);
		}
		if (script.logs.length > 0) {
			title("Log");
			for (const l of script.logs) lines.push(`   ${l}`);
		}
		if (script.code !== undefined) {
			const code = script.code.replace(/\n+$/, "").split("\n");
			title("Code");
			for (const l of code.slice(0, CODE_LINES)) lines.push(t.fg("muted", `   ${l}`));
			if (code.length > CODE_LINES) lines.push(t.fg("dim", `   ... ${code.length - CODE_LINES} more lines`));
		}
		const shown = script.calls.findLast((c) => c.status === "running") ?? script.calls.at(-1);
		if (shown) {
			title(`Output of ${shown.name}${shown.label ? ` ${shown.label}` : ""}`);
			if (shown.output === "") lines.push(t.fg("dim", "   no output yet"));
			else for (const l of shown.output.split("\n")) lines.push(`   ${l}`);
		}
		if (script.result !== undefined) {
			title(script.state === "failed" ? "Error" : script.state === "stopped" ? "Stopped" : "Result");
			for (const l of script.result.split("\n")) lines.push(`   ${l}`);
		}
		return lines;
	}

	render(width: number): string[] {
		const t = this.theme;
		const rows = this.tui.terminal.rows;
		const script = scripts.get(this.id);
		if (!script) return [t.fg("muted", " This script is gone (esc goes back)")];
		const status = scriptStatus(script);
		const name = script.workflow ? `workflow ${script.workflow}` : (scriptLabel(script) ?? "script");
		const state = script.paused ? "paused" : script.state;
		const ids = `${script.id}${script.run ? `, ${script.run}` : ""}`;
		const took = elapsed((script.endedAt ?? Date.now()) - script.startedAt);
		const head = truncateToWidth(
			` ${t.fg("accent", "‹ main")} ${t.fg("dim", "(esc)")}  ${t.bold(name)} ${t.fg("muted", `(${ids})`)}  ${t.fg(COLORS[status], `${ICONS[status]} ${state}`)} · ${t.fg("muted", took)}`,
			width,
		);
		const rule = t.fg("dim", "─".repeat(width));
		const all = this.body(script);
		const height = Math.max(1, rows - 4);
		this.offset = Math.min(this.offset, Math.max(0, all.length - height));
		const end = all.length - this.offset;
		const body = all.slice(Math.max(0, end - height), end).map((l) => truncateToWidth(l, width));
		while (body.length < height) body.push("");
		const scrolled = this.offset > 0 ? ` · ${this.offset} lines above the end` : "";
		const stop = script.endedAt === undefined ? " · x stop the script" : "";
		const hint = this.notice || `↑↓ pgup/pgdn scroll${scrolled}${stop} · esc back to main`;
		return [head, rule, ...body, rule, t.fg("dim", truncateToWidth(` ${hint}`, width))].slice(0, rows);
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
		this.unsubscribe();
	}
}

let current: Promise<void> | undefined;

// Show the script's screen over the terminal. Resolves when the user leaves. One screen at a time.
export function openScriptScreen(ctx: () => ExtensionContext, script: ScriptRecord): Promise<void> {
	if (current) return current;
	current = ctx()
		.ui.custom<void>((tui, theme, _kb, done) => new ScriptScreen(tui, theme, script.id, () => done()), {
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" },
		})
		.finally(() => {
			current = undefined;
		});
	return current;
}
