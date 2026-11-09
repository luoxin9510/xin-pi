// The subagent panel (v2 spec, "TUI"): a widget below the editor with one row per subagent of the session, drawn from
// the registry and redrawn on its changes. ↓ on an empty editor moves focus into it; while it has focus it consumes
// the keys it uses (↑ ↓ enter x X esc) and lets every other key through to pi.

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type ScriptRecord, scripts } from "./background.ts";
import { tint } from "./color.ts";
import type { Config } from "./config.ts";
import { COLORS, ICONS, label, registry, type SubagentRecord, type SubagentStatus } from "./registry.ts";
import { stopEverything } from "./stop-all.ts";
import { openSubagentScreen } from "./subagent-screen.ts";

export interface PanelOptions {
	lingerMs: number; // finished rows drop out this long after they ended
	viewable: boolean; // false for an in-memory session: subagents cannot be viewed, so no rows, only a notice
}

// One selectable row: a script, or a subagent (indented when it belongs to a script row shown above it).
type Row = { kind: "script"; script: ScriptRecord } | { kind: "agent"; record: SubagentRecord; indent: boolean };

const scriptStatus = (s: ScriptRecord): SubagentStatus =>
	s.state === "foreground" || s.state === "background" ? "running" : s.state;
const elapsed = (ms: number) =>
	ms < 60_000
		? `${Math.floor(ms / 1000)}s`
		: `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;

export class Panel {
	private focused = false;
	private selected = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private unsubscribe: () => void;
	private sessionId: string;
	private theme: Theme;
	private requestRender: () => void;
	private open: (r: SubagentRecord) => void;
	private options: PanelOptions;

	constructor(
		sessionId: string,
		theme: Theme,
		requestRender: () => void,
		open: (r: SubagentRecord) => void,
		options: PanelOptions,
	) {
		this.sessionId = sessionId;
		this.theme = theme;
		this.requestRender = requestRender;
		this.open = open;
		this.options = options;
		const changed = () => {
			this.sync();
			this.requestRender();
		};
		const offs = [registry.subscribe(changed), scripts.subscribe(changed)];
		this.unsubscribe = () => {
			for (const off of offs) off();
		};
		this.sync();
	}

	// Script rows (running, or ended less than lingerMs ago) with their visible agents indented below; agents in no
	// shown script stay top-level. Groups are ordered by start time so rows do not jump.
	private rows(): Row[] {
		if (!this.options.viewable) return [];
		const now = Date.now();
		const agents = registry.visible(this.sessionId, this.options.lingerMs);
		const shown = scripts
			.list(this.sessionId)
			.filter((s) => s.endedAt === undefined || now - s.endedAt < this.options.lingerMs);
		const inScript = new Set(shown.flatMap((s) => s.agents));
		const groups: { at: number; rows: Row[] }[] = shown.map((script) => ({
			at: script.startedAt,
			rows: [
				{ kind: "script", script },
				...agents
					.filter((r) => script.agents.includes(r.id))
					.map((record): Row => ({ kind: "agent", record, indent: true })),
			],
		}));
		for (const record of agents)
			if (!inScript.has(record.id))
				groups.push({ at: record.startedAt, rows: [{ kind: "agent", record, indent: false }] });
		return groups.sort((a, b) => a.at - b.at).flatMap((g) => g.rows);
	}

	hasFocus(): boolean {
		return this.focused;
	}

	// Keep the selection valid, give focus back when nothing is left, and wake up when the next finished row expires.
	private sync(): void {
		const rows = this.rows();
		if (rows.length === 0) this.focused = false;
		this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
		clearTimeout(this.timer);
		const endOf = (r: Row) => (r.kind === "script" ? r.script.endedAt : r.record.endedAt);
		const delays = rows
			.map(endOf)
			.filter((t) => t !== undefined)
			.map((t) => Math.max(0, t! + this.options.lingerMs - Date.now()) + 5);
		// wake up when the next finished row expires, and every second while a script runs (its elapsed time)
		const wait = Math.min(
			...delays,
			rows.some((r) => r.kind === "script" && r.script.endedAt === undefined) ? 1000 : Infinity,
		);
		if (wait !== Infinity) {
			this.timer = setTimeout(() => {
				this.sync();
				this.requestRender();
			}, wait);
			this.timer.unref();
		}
	}

	// Returns true when the key was consumed.
	handleKey(data: string, editorEmpty: boolean): boolean {
		// Kitty-protocol terminals send a release after every press, and pi's input listeners get both (components do
		// not). A release is never an action; while the panel has focus it is ours, so swallow it.
		if (isKeyRelease(data)) return this.focused;
		// ctrl+b with an empty editor sends the foreground scripts to the background; otherwise it stays cursor-left.
		// It works with or without focus.
		if (editorEmpty && matchesKey(data, "ctrl+b") && scripts.backgroundAll(this.sessionId)) return true;
		const rows = this.rows();
		if (!this.focused) {
			if (rows.length > 0 && editorEmpty && matchesKey(data, "down")) {
				this.focused = true;
				this.selected = 0;
				this.requestRender();
				return true;
			}
			return false;
		}
		if (matchesKey(data, "escape") || (matchesKey(data, "up") && this.selected === 0)) this.focused = false;
		else if (matchesKey(data, "up")) this.selected--;
		else if (matchesKey(data, "down")) this.selected = Math.min(this.selected + 1, rows.length - 1);
		else if (matchesKey(data, "enter")) {
			const row = rows[this.selected]!;
			if (row.kind === "agent") this.open(row.record); // a script has no screen
		} else if (data === "X" || matchesKey(data, "shift+x")) {
			void stopEverything(this.sessionId); // every script and subagent of the session; the rows show the result
		} else if (matchesKey(data, "x")) {
			// a row that is not running: nothing to stop
			const row = rows[this.selected]!;
			if (row.kind === "script") void scripts.stop(row.script.id);
			else registry.stop(row.record.id);
		} else {
			this.focused = false; // any other key (ctrl+c, ctrl+d, text) belongs to pi: the editor has the keyboard again
			this.requestRender();
			return false;
		}
		this.requestRender();
		return true;
	}

	render(width: number): string[] {
		const t = this.theme;
		if (!this.options.viewable) {
			const n = registry.list(this.sessionId).length;
			return n === 0
				? []
				: [t.fg("muted", `Subagents (${n}) cannot be viewed: the session is not saved (in-memory)`)];
		}
		const rows = this.rows();
		if (rows.length === 0) return [];
		const nAgents = rows.filter((r) => r.kind === "agent").length;
		const nScripts = rows.length - nAgents;
		const lines = [t.fg("muted", `Subagents (${nAgents})${nScripts > 0 ? ` · Scripts (${nScripts})` : ""}`)];
		rows.forEach((r, i) => {
			let parts: string[];
			if (r.kind === "script") {
				const s = r.script;
				const status = scriptStatus(s);
				const agents = s.agents.map((id) => registry.get(id)).filter((a) => a !== undefined);
				const cost = agents.reduce((sum, a) => sum + a.usage.cost.total, 0);
				const running = agents.filter((a) => a.status === "running").length;
				parts = [
					t.fg(COLORS[status], `${ICONS[status]} ${s.state}`),
					`script ${s.id}`,
					t.fg("muted", `${running} agents running`),
					t.fg("muted", elapsed((s.endedAt ?? Date.now()) - s.startedAt)),
					t.fg("muted", `$${cost.toFixed(4)}`),
				];
			} else {
				const a = r.record;
				parts = [
					t.fg(COLORS[a.status], `${ICONS[a.status]} ${a.status}`),
					tint(a.color, label(a)),
					t.fg("muted", `${a.turns} turns`),
				];
				if (a.lastTool) parts.push(t.fg("muted", a.lastTool));
				parts.push(t.fg("muted", `$${a.usage.cost.total.toFixed(4)}`));
			}
			const selected = this.focused && i === this.selected;
			const indent = r.kind === "agent" && r.indent ? "  " : "";
			const line = truncateToWidth(`${selected ? "▸" : " "} ${indent}${parts.join(" · ")}`, width);
			lines.push(selected ? t.bg("selectedBg", line) : line);
		});
		if (this.focused) lines.push(t.fg("dim", "↑↓ select · enter open · x stop · X stop all · esc back to editor"));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		clearTimeout(this.timer);
		this.unsubscribe();
	}
}

// Wire the panel into a session: the widget, and the key hook that feeds it. Installing again (a new session in the
// same pi process) takes the old panel down first.
const KEY = "pipipi-panel";
let installed: { panel?: Panel; removeHook: () => void } | undefined;

export function installPanel(current: () => ExtensionContext, config: Config): void {
	const ctx = current();
	if (installed) {
		installed.removeHook();
		installed.panel?.dispose();
		ctx.ui.setWidget(KEY, undefined);
	}
	const sessionId = ctx.sessionManager.getSessionId();
	const viewable = ctx.sessionManager.getSessionFile() !== undefined;
	const state: NonNullable<typeof installed> = { removeHook: () => {} };
	installed = state;
	let focusedIsEditor: () => boolean = () => true;
	ctx.ui.setWidget(
		KEY,
		(tui, theme) => {
			// Pi does not say whether the editor has the keyboard (a picker such as /subagents takes it): the editor is the
			// focused component with a getText method.
			focusedIsEditor = () => {
				const f = (tui as unknown as { focusedComponent?: { getText?: unknown } }).focusedComponent;
				return f === undefined || typeof f.getText === "function";
			};
			state.panel = new Panel(
				sessionId,
				theme,
				() => tui.requestRender(),
				(r) => void openSubagentScreen(current, r),
				{
					lingerMs: config.panelLingerMs,
					viewable,
				},
			);
			return state.panel;
		},
		{ placement: "belowEditor" },
	);
	state.removeHook = ctx.ui.onTerminalInput((data) => {
		if (!state.panel || !focusedIsEditor()) return undefined;
		return state.panel.handleKey(data, ctx.ui.getEditorText() === "") ? { consume: true } : undefined;
	});
}
