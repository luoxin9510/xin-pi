// The hub (pi-roost's agent view): the sessions the daemon runs, as one focused xxpi-tui component.
// Phase 1 (decision 4 of .scratch/xpi-roost/01-roost-core.md): the list with pin, reorder, grouping
// and the filter; peek with the reply box and the session's own slash commands; attach; new
// sessions; stop, remove, rename; resume and the model choice; usage; marks and batches; the log;
// the help. Not here (decision 6): the task board and workspaces, the concierge, schedules, pull
// requests, worktrees, agent definitions, fan-out and compare, agent profiles, subagents as rows.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Component,
	decodeKittyPrintable,
	Input,
	isKeyRelease,
	parseKey,
	type SlashCommand,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "xpi-tui";
import { attachToHost, type DetachKeyMatcher, type DetachReason } from "../lib/attach.ts";
import { type DaemonClient, DaemonError, GiveUp } from "../lib/client.ts";
import { type Preset, presetFrom } from "../lib/config.ts";
import { atCandidates, atPrefix, parseInput, THINKING_LEVELS } from "../lib/dispatch-input.ts";
import type { RoostEvent } from "../lib/events.ts";
import { type Filter, parseFilter } from "../lib/filter.ts";
import { hostControl } from "../lib/hostclient.ts";
import { forgetJob, observeJob } from "../lib/job-events.ts";
import { hostSocketPath } from "../lib/paths.ts";
import type { DispatchArgs, Event, JobRow, ReplyMode } from "../lib/protocol.ts";
import { ensureLive } from "../lib/resume.ts";
import { commandsPath, readCommands, type SessionCommand, screenPath } from "../lib/store.ts";
import { readTail, transcriptItems } from "../lib/transcript.ts";
import { formatCost, totalUsage } from "../lib/usage.ts";
import {
	ageOf,
	counts,
	fitTail,
	formatDuration,
	headerText,
	type Item,
	iconOf,
	items,
	layout,
	modelFacts,
	nameToneOf,
	rowDetailsOf,
	type Section,
	sentenceOf,
	shortModel,
	type Tone,
	takesReplies,
	titleText,
} from "../lib/view-model.ts";
import { DOUBLE_PRESS_MS, type Overlay, type OverlayHost } from "./overlay-host.ts";
import { createLogOverlay } from "./overlays/log.ts";
import { createUsageOverlay } from "./overlays/usage.ts";
import { type RoostPort, roostPort, sends } from "./roost-port.ts";
import { TaskEditor } from "./task-editor.ts";
import { CONTROL, oneLine, wrap } from "./text.ts";
import type { HubTheme } from "./theme.ts";

export type { Overlay };

const MIN_TASK = 4; // DI-1

/** M48: one line of a peek's tail, raw (cut to the width when rendered). */
type TailItem = { kind: "you" | "said" | "tool" | "note" | "screen"; text: string; error?: boolean };
/** M48: a peek's tail reads this much of the session file's end (a few lines; the overlay reads more). */
const TAIL_READ_MAX = 256 * 1024;

/** M48: the commands a peek takes (`/…` in its reply box), for that session. */
const PEEK_COMMANDS: { name: string; description: string; argumentHint?: string }[] = [
	{ name: "stop", description: "stop it" },
	{ name: "respawn", description: "start it again" },
	{ name: "rm", description: "delete it (twice within 2 s)" },
	{ name: "pin", description: "pin / unpin (a pinned session keeps running)" },
	{ name: "rename", description: "rename it (bare: edit the name)", argumentHint: "name" },
	{ name: "attach", description: "attach to it (→)" },
	{ name: "model", description: "switch its model (bare: pick)", argumentHint: "provider/id" },
	{ name: "thinking", description: "its thinking level (bare: pick)", argumentHint: "level" },
	{ name: "name", description: "its own session name (xpi's /name)", argumentHint: "name" },
	{ name: "compact", description: "compact its context (xpi's /compact)" },
	{ name: "continue", description: "send: Continue where you left off." },
	{ name: "log", description: "its events (newest first)" },
	{ name: "transcript", description: "its transcript (a shell command: its screen)" },
];
const RESTART_ASK_MS = 3000;
const NOTICE_MS = 4000;
const SPIN_MS = 150;
/** M8: the row's model and context column only shows while the summary keeps this many columns. */
const MIN_SUMMARY = 24;
const MODEL_COL = 20;
/** M22: how often the view checks its rows against the daemon's. */
const RESYNC_MS = 15_000;
/** M8: how long a sent /model or /thinking may take to show in the session's reports. */
const SWITCH_CHECK_MS = 8000;

/** M23: a picker's items matching its search: every word of it, in any case. */
export function pickerShown(p: {
	items: { label: string; value: string }[];
	query?: string;
}): { label: string; value: string }[] {
	const words = (p.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return p.items;
	return p.items.filter((it) => {
		const hay = `${it.label} ${it.value}`.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

/** M80: The hub's terminal, its colours, where it starts sessions, the daemon, and its exits. */
export interface HubCore {
	tui: TUI;
	theme: HubTheme;
	/** Directory new sessions start in. */
	cwd: string;
	/** The daemon connection (xpi's roost: its agent directory and entry files); tests pass a fake. */
	connect: () => Promise<DaemonClient>;
	/** Decision 11: the key that detaches an attached session (the user's `app.suspend`). */
	isDetachKey: DetachKeyMatcher;
	/** How that key is named in the help ("ctrl+z"). */
	detachKeyName?: string;
	setTitle: (title: string) => void;
	done: () => void;
}

/** M80: What the list shows and how (where it came from, grouping, motion, the screen's height). */
export interface HubDisplay {
	/** AV-7: show only sessions started under this directory. */
	cwdFilter?: string;
	/** AV-K6: initial grouping and where a change is persisted. */
	groupBy?: "state" | "directory";
	onGroupBy?: (groupBy: "state" | "directory") => void;
	/** NT-1: a session needs input or finished while the hub is on screen. */
	notify?: (row: JobRow, kind: "needs_input" | "completed") => void;
	/** AV-9: a row to keep bold (the conversation just moved to the background). */
	highlightId?: string;
	/** BG-5: Esc goes back into this session (the conversation that just moved) instead of leaving. */
	origin?: string;
	/** Shown above the list until the user returns to the origin. */
	banner?: string;
	/** Screen-reader mode: no animation (PRD accessibility). */
	reducedMotion?: boolean;
	/** Render exactly the terminal's height: list at the top, input and keys at the bottom. */
	fullscreen?: boolean;
	/** M8: show each row's model and context window use (default true). */
	rowDetails?: boolean;
	/** M8: how long a /model or /thinking switch may take to show (tests shorten it). */
	switchCheckMs?: number;
}

/** M80: What a new session runs: an xpi session or a shell command, and the presets. */
export interface HubLaunching {
	/** A new xpi session; the view adds its /model and /thinking defaults and @dir target. */
	launch: (task: string, opts?: LaunchOptions) => LaunchRequest;
	/** DI-6: a shell command (no model). */
	launchShell?: (command: string, cwd: string) => DispatchArgs;
	/** M27: the presets (the user's and a project's) and saving one to the user's settings (null removes). */
	presets?: () => Record<string, Preset>;
	savePreset?: (name: string, preset: Preset | null) => void;
	/** M27: whether the user's own settings have this preset (a project's cannot be removed here). */
	userPreset?: (name: string) => boolean;
}

/** M80: The models to pick from and the default. */
export interface HubModels {
	/** DI-4: models for the /model picker, as "provider/id". */
	models?: () => string[];
	/** M23: what new sessions run when no model is chosen ("provider/id"). */
	defaultModel?: () => string | undefined;
	/** M23: the models xpi cycles through (`enabledModels`); none: all of them. */
	scopedModels?: () => string[];
}

/** M80: Past sessions (/resume) and the one this xpi is in. */
export interface HubResume {
	/** DI-4: past sessions of a directory for /resume. */
	resumable?: (cwd: string) => Promise<Resumable[]>;
	/**
	 * M23: xpi's own session selector for /resume (search, this directory or all, sort);
	 * without it, or when it cannot be built, the view's own list.
	 */
	sessionSelector?: (o: {
		cwd: string;
		onSelect: (session: Resumable) => void;
		onCancel: () => void;
		requestRender: () => void;
		/** A session a live job runs (not to be deleted from the list). */
		busy: (path: string) => boolean;
	}) => Overlay;
	/** M23: this xpi's own session file (it cannot be resumed in the background). */
	currentSession?: () => string | undefined;
}

/**
 * T18: how a peek runs one of xpi's commands that its session's worker does not run itself:
 * - hub: the hub has its own (model, thinking, name, compact): not listed in the xpi group.
 * - screen: runs and shows something; the peek types it in and shows the screen.
 * - picker: opens a picker or dialog; the peek types it in and attaches.
 * - confirm: ends the session (asked twice).
 * - reply: sent to the session as a reply; its worker runs it (an extension's command).
 */
export type BuiltinHow = "hub" | "screen" | "picker" | "confirm" | "reply";

/** T18: one of xpi's commands, with how a peek runs it (the table is `builtin:roost`'s: it knows xpi). */
export interface BuiltinCommand {
	name: string;
	description: string;
	argumentHint?: string;
	how: BuiltinHow;
	/** What xpi does with words after the name: it matches the others exactly (`/tree foo` would go to the model as a prompt). */
	args?: "optional" | "required";
}

/** M80: Slash commands: this xpi's, xpi's built-in ones, a session's own. */
export interface HubCommands {
	/** Slash commands of this xpi (DI-4, DI-5: skills and prompt templates become first prompts). */
	commands?: () => { name: string; source: string }[];
	/** T18: xpi's own commands and how a peek runs each (none: a peek sends every other command as a reply). */
	builtins?: () => readonly BuiltinCommand[];
	/** M61: a session's own slash commands (its worker's commands.json); tests pass a fake. */
	sessionCommands?: (id: string) => SessionCommand[];
	/** M61: the host's control socket (type a command into xpi, read its screen); tests pass a fake. */
	hostControl?: typeof hostControl;
}

/** M80: the hub's options, in groups by purpose (each group a type; callers pass one flat object). */
export type AgentViewOptions = HubCore & HubDisplay & HubLaunching & HubModels & HubResume & HubCommands;

/** A dispatch request, plus what to tell the user. */
export type LaunchRequest = DispatchArgs & { note?: string };

export interface LaunchOptions {
	cwd?: string;
	model?: string;
	thinking?: string;
	/** /resume: run this existing session instead of a new one. */
	sessionFile?: string;
	name?: string;
	origin?: "dispatch" | "adopt";
}

export interface Resumable {
	path: string;
	name: string;
	cwd: string;
	modified: number;
}

/** M79: the list, or one row's peek (its panel and reply box) under the selection. */
type View = { kind: "list" } | { kind: "peek"; id: string };
/** M79: what is open on top of the view and takes the keys: the help, a picker, a rename, an overlay. */
type Layer =
	| { kind: "help" }
	| { kind: "picker"; picker: Picker }
	| { kind: "renaming"; id: string }
	| { kind: "overlay"; overlay: Overlay };

interface Picker {
	title: string;
	items: { label: string; value: string }[];
	index: number;
	pick: (value: string) => void | Promise<void>;
	/** M23: typed text narrows the list (every word, any case). */
	query?: string;
	/** M23: Tab shows these instead (all models vs the enabled ones), and back. */
	other?: { label: string; items: { label: string; value: string }[] };
	/** M23: what the list shows now, for the title (the enabled models, all models). */
	scope?: string;
}

interface Columns {
	mode: "full" | "share" | "none";
	modelW: number;
	shareW: number;
	ageW: number;
	/** M24: the cost column ("$1.20"), when there is room for it. */
	costW: number;
}

interface Switch {
	which: "model" | "thinking";
	value: string;
	before: string | null;
	/** Pending switches this one replaced: a report showing one of them is not the outcome. */
	superseded: string[];
	timer: NodeJS.Timeout;
}

const switchKey = (id: string, which: "model" | "thinking") => `${id}:${which}`;

interface Notice {
	text: string;
	tone: Tone;
	until: number;
}

/** The hub (pi-roost's agent view, PRD §6.1–6.5) as one focused xxpi-tui component. */
export class AgentView implements Component {
	private o: AgentViewOptions;
	private client: DaemonClient | undefined;
	/** DM-7: a failed or stopped session restarts on a second Enter. */
	private restartAsk: { id: string; at: number } | undefined;
	private rows = new Map<string, JobRow>();
	private collapsed = new Set<Section["key"]>();
	private cursor: { kind: "row"; id: string } | { kind: "header"; key: Section["key"] } | undefined;
	/** M79: the list, or a row's peek (the row a reply is typed for; replies never retarget to another row). */
	private view: View = { kind: "list" };
	/** M79: what is open on top of the view: one at a time; what opens last is what is open. */
	private layer: Layer | undefined;
	/** M17: xpi's editor: several lines (Shift+Enter), long pastes folded. */
	private input: TaskEditor;
	/** M48: the reply box is an editor like the task box (lines, pastes, undo, completion). */
	private reply: TaskEditor;
	private renameInput = new Input({ prompt: "rename › " });
	private groupBy: "state" | "directory" = "state";
	/** DI-4: defaults for the next dispatches. */
	private model: string | undefined;
	private thinking: string | undefined;
	private notice: Notice | undefined;
	private armedStop: { id: string; at: number } | undefined;
	/** M61: a built-in command on its way (a second Enter meanwhile is ignored). */
	private commandBusy = false;
	/** M61: sessions' command lists by the mtime of the file they were read from. */
	private commandsCache = new Map<string, { mtime: number; list: SessionCommand[] }>();
	private ctrlCAt = 0;
	private frame = 0;
	private spinner: NodeJS.Timeout | undefined;
	private resync: NodeJS.Timeout | undefined;
	private attached = false;
	private closed = false;
	private connectError: string | undefined;
	private nameWidth = 16;
	/** M8: the model / context column, the same for every row of a render so it lines up. */
	private columns: Columns = { mode: "none", modelW: 0, shareW: 0, ageW: 0, costW: 0 };
	/** M8: switches sent to live sessions, until their reports show them (or do not). */
	private switches = new Map<string, Switch>();
	/** M25: rows checked with Ctrl+O; the batch keys act on all of them. */
	private marked = new Set<string>();
	private sendingMarked = false;
	/** M51: a peek reply on its way (sent again meanwhile when its answer was lost). */
	private sendingReply = false;
	/** M27: the preset in use: its name, and what the view has no setting of its own for. */
	private preset: { name: string; dir?: string } | undefined;
	private dispatching = false;
	private get peek(): boolean {
		return this.view.kind === "peek";
	}
	private get peekId(): string | undefined {
		return this.view.kind === "peek" ? this.view.id : undefined;
	}
	private get help(): boolean {
		return this.layer?.kind === "help";
	}
	private get picker(): Picker | undefined {
		return this.layer?.kind === "picker" ? this.layer.picker : undefined;
	}
	/** AV-K10: the row being renamed, edited in its own input. */
	private get renaming(): string | undefined {
		return this.layer?.kind === "renaming" ? this.layer.id : undefined;
	}
	private get overlay(): Overlay | undefined {
		return this.layer?.kind === "overlay" ? this.layer.overlay : undefined;
	}
	/** M79: opens a layer over the view, in place of the one open (if any). */
	private openLayer(layer: Layer): void {
		const was = this.layer;
		// a rename replaced: its input gives the focus back, as Esc would
		if (was?.kind === "renaming") {
			this.renameInput.focused = false;
			this.input.focused = true;
		}
		this.layer = layer;
	}
	/** M79: closes the open layer, if it is of this kind (one of another kind opened since stays). */
	private closeLayer(kind: Layer["kind"]): void {
		if (this.layer?.kind !== kind) return;
		this.layer = undefined;
	}

	private origin: string | undefined;
	/** Esc/Enter came before the moved conversation's worker was up: attach once it is. */
	private attachWhenLive: string | undefined;

	constructor(o: AgentViewOptions) {
		this.input = new TaskEditor(
			o.tui,
			{
				border: (s) => o.theme.fg("border", s),
				dim: (s) => o.theme.fg("dim", s),
				accent: (s) => o.theme.fg("accent", s),
			},
			"describe a task and press Enter to start it in the background · Shift+Enter new line",
		);
		this.reply = new TaskEditor(
			o.tui,
			{
				border: (s) => o.theme.fg("border", s),
				dim: (s) => o.theme.fg("dim", s),
				accent: (s) => o.theme.fg("accent", s),
			},
			"reply · Enter sends · / commands",
		);
		this.reply.focused = false;
		// M48: xpi's completion menu in both boxes: `/` the box's commands, `@` paths under its directory
		this.input.setAutocomplete(
			this.completion(
				() => this.viewCommands(),
				() => this.dispatchCwd(),
			),
		);
		this.reply.setAutocomplete(
			this.completion(
				() => this.peekCommands(),
				() => (this.peekId ? this.rows.get(this.peekId)?.cwd : undefined) ?? this.dispatchCwd(),
			),
		);
		this.o = o;
		this.origin = o.origin;
		this.groupBy = o.groupBy ?? "state";
		if (o.origin) this.cursor = { kind: "row", id: o.origin };
		this.input.focused = true;
	}

	// ---- lifecycle -------------------------------------------------------

	async start(): Promise<void> {
		this.spinner = setInterval(() => {
			if (this.closed || this.attached || this.o.reducedMotion) return;
			const busy = [...this.rows.values()].some((r) => r.pid !== null && r.status === "busy");
			if (busy || this.notice) {
				this.frame++;
				this.o.tui.requestRender();
			}
		}, SPIN_MS);
		this.spinner.unref?.();
		await this.connect();
	}

	dispose(): void {
		this.closed = true;
		clearInterval(this.spinner);
		clearInterval(this.resync);
		this.closeOverlay();
		for (const s of this.switches.values()) clearTimeout(s.timer);
		this.switches.clear();
		this.client?.close();
		this.client = undefined;
		this.o.setTitle("xpi");
	}

	/** M71: the daemon port of a connection (one per client, so a closure holding it keeps its connection). */
	private ports = new WeakMap<DaemonClient, RoostPort>();
	/** M51: reply and dispatch hold no connection: each try takes the live one, waiting through a reconnect. */
	private readonly sends = sends((d) => this.live(d));

	private portFor(client: DaemonClient): RoostPort {
		let port = this.ports.get(client);
		if (!port) {
			port = roostPort(client, (d) => this.live(d));
			this.ports.set(client, port);
		}
		return port;
	}

	/** M71: the port of the connection now (undefined while there is none). */
	private get port(): RoostPort | undefined {
		return this.client && this.portFor(this.client);
	}

	/** M51: the connection now, waiting a moment while it is being made again (the daemon restarted). */
	private async live(deadline = Date.now() + 10_000): Promise<DaemonClient> {
		const until = Math.min(deadline, Date.now() + 10_000);
		for (;;) {
			if (this.closed) throw new GiveUp("the hub is closed");
			const c = this.client;
			if (c && !c.isClosed) return c;
			if (Date.now() > until) throw new Error("background service unavailable");
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	private async connect(): Promise<void> {
		if (this.closed) return;
		let client: DaemonClient | undefined;
		try {
			client = await this.o.connect();
			if (this.closed) return client.close();
			await this.portFor(client).subscribe((e) => this.onEvent(e));
			const { jobs, after } = await this.listFrom(client);
			if (this.closed) return client.close();
			this.rows = new Map(jobs.map((j) => [j.id, j]));
			for (const e of after) this.applyRow(e);
			for (const j of jobs) observeJob(j); // what is already there is not news
			for (const j of jobs) this.checkSwitch(j); // a switch shown while we were away
			this.client = client;
			this.connectError = undefined;
			// AV-8: pushed events only; reconnect when the daemon goes away.
			const live = client;
			// M22: a push lost on the way (or never sent) shows up within RESYNC_MS
			clearInterval(this.resync);
			this.resync = setInterval(() => void this.resyncRows(live), RESYNC_MS);
			this.resync.unref?.();
			client.onClose(() => {
				if (this.client !== live) return;
				clearInterval(this.resync);
				this.client = undefined;
				this.connectError = "reconnecting…";
				this.render0();
				setTimeout(() => void this.connect(), 500).unref?.();
			});
		} catch (err) {
			client?.close();
			if (this.closed) return;
			this.connectError = (err as Error).message;
			setTimeout(() => void this.connect(), 2000).unref?.();
		}
		this.render0();
	}

	/**
	 * M22: the rows, and the events that came after the reply: those are newer than it,
	 * though handled before the code after the await runs.
	 */
	private async listFrom(client: DaemonClient): Promise<{ jobs: JobRow[]; after: Event[] }> {
		const heard: { e: Event; at: number }[] = [];
		const port = this.portFor(client);
		const off = port.listen((e) => heard.push({ e, at: port.position() }));
		try {
			const { result, at } = await port.jobs.listAt(this.o.cwdFilter ? { cwd: this.o.cwdFilter } : {});
			const after = heard.filter((h) => h.at > at).map((h) => h.e);
			return {
				jobs: result.jobs,
				after: after.filter((e) => e.event !== "job" || !this.o.cwdFilter || within(e.job.cwd, this.o.cwdFilter)),
			};
		} finally {
			off();
		}
	}

	/** M22: a row event over a fresh list (no notifications: it was seen already). */
	private applyRow(e: Event): void {
		if (e.event === "job") {
			if (this.o.cwdFilter && !within(e.job.cwd, this.o.cwdFilter)) return;
			this.rows.set(e.job.id, e.job);
		} else if (e.event === "removed") this.rows.delete(e.id);
	}

	/** M22: the daemon's rows as they are now (the stream after the reply carries on from them). */
	private async resyncRows(client: DaemonClient): Promise<void> {
		if (this.closed || this.client !== client) return;
		let jobs: JobRow[];
		let after: Event[];
		try {
			({ jobs, after } = await this.listFrom(client));
		} catch {
			return; // the close handler reconnects
		}
		if (this.closed || this.client !== client) return;
		const next = new Map(jobs.map((j) => [j.id, j]));
		for (const e of after) {
			if (e.event === "job") next.set(e.job.id, e.job);
			else if (e.event === "removed") next.delete(e.id);
		}
		for (const id of this.rows.keys()) if (!next.has(id)) forgetJob(id);
		for (const j of jobs) observeJob(j);
		this.rows = next;
		for (const j of jobs) this.checkSwitch(j);
		const waiting = this.attachWhenLive ? next.get(this.attachWhenLive) : undefined;
		if (waiting && !this.attached) {
			if (waiting.pid) {
				this.attachWhenLive = undefined;
				void this.attachTo(waiting.id).catch((err: unknown) => this.say(String(err), "error"));
			} else if (waiting.endedAt !== null) this.attachWhenLive = undefined;
		}
		this.render0();
	}

	private onEvent(e: Event): void {
		if (e.event === "job") {
			if (this.o.cwdFilter && !within(e.job.cwd, this.o.cwdFilter)) return;
			this.rows.set(e.job.id, e.job);
			this.checkSwitch(e.job);
			const kind = observeJob(e.job);
			if (kind && !this.attached) this.o.notify?.(e.job, kind);
			if (this.attachWhenLive === e.job.id && !this.attached) {
				if (e.job.pid) {
					this.attachWhenLive = undefined;
					void this.attachTo(e.job.id).catch((err: unknown) => this.say(String(err), "error"));
				} else if (e.job.endedAt !== null) this.attachWhenLive = undefined;
			}
		} else if (e.event === "removed") {
			this.rows.delete(e.id);
			forgetJob(e.id);
		}
		try {
			this.overlay?.onEvent?.(e);
		} catch {}
		this.render0();
	}

	/** M71: the host of an overlay opened on `port` (the connection it was opened on, as the closures hold theirs). */
	overlayHost(port: RoostPort): OverlayHost {
		return { port, ...this.hostBase() };
	}

	/** M73: the host without a port, for the overlays that ask the daemon nothing. */
	private hostBase(): Omit<OverlayHost, "port"> {
		return {
			theme: this.o.theme,
			say: (text, tone) => this.say(text, tone),
			close: () => this.closeOverlay(),
			requestRender: () => this.o.tui.requestRender(),
			attachTo: (id) => this.attachTo(id),
			selectRow: (id) => {
				this.cursor = { kind: "row", id };
			},
			rows: () => this.rows,
			current: () => this.overlay,
			notice: () => this.notice,
			termRows: () => this.o.tui.terminal.rows,
		};
	}

	private render0(): void {
		// while attached the terminal belongs to the worker: no title or repaint
		if (this.closed || this.attached) return;
		this.o.setTitle(titleText(counts(this.listedRows())));
		this.o.tui.requestRender();
	}

	// ---- model -----------------------------------------------------------

	/** The rows the view lists: every session the daemon runs (decision 3: no subagents among them). */
	private listedRows(): JobRow[] {
		return [...this.rows.values()];
	}

	private sections(): Section[] {
		const height = this.o.tui.terminal.rows || 30;
		return layout(this.listedRows(), {
			collapsed: this.collapsed,
			groupBy: this.groupBy,
			filter: this.filter(),
			// AV-5: keep live groups visible on short terminals
			maxCompleted: Math.max(3, height - 14),
		});
	}

	/** DI-7: the input holds filters (s: n: o:) rather than a task. */
	private filter(): Filter | undefined {
		if (this.peek || this.renaming) return undefined;
		return parseFilter(this.input.getValue());
	}

	private itemList(): Item[] {
		return items(this.sections());
	}

	private selectedIndex(list: Item[]): number {
		const c = this.cursor;
		if (c) {
			const i = list.findIndex((it) =>
				c.kind === "row"
					? it.kind === "row" && it.row.id === c.id
					: it.kind === "header" && it.section.key === c.key,
			);
			if (i >= 0) return i;
		}
		const firstRow = list.findIndex((it) => it.kind === "row");
		return firstRow >= 0 ? firstRow : 0;
	}

	private selected(): Item | undefined {
		const list = this.itemList();
		return list[this.selectedIndex(list)];
	}

	private selectedRow(): JobRow | undefined {
		const it = this.selected();
		return it?.kind === "row" ? it.row : undefined;
	}

	private move(delta: number | "home" | "end"): void {
		const list = this.itemList();
		if (list.length === 0) return;
		const cur = this.selectedIndex(list);
		const next =
			delta === "home" ? 0 : delta === "end" ? list.length - 1 : Math.max(0, Math.min(list.length - 1, cur + delta));
		const it = list[next]!;
		this.cursor = it.kind === "row" ? { kind: "row", id: it.row.id } : { kind: "header", key: it.section.key };
		this.reply.setValue("");
		if (this.peek) {
			// the panel follows the selection (PK: ↑↓ with the panel open)
			if (it.kind === "row") this.view = { kind: "peek", id: it.row.id };
			else this.closePeek();
		}
	}

	private say(text: string, tone: Tone = "muted"): void {
		this.notice = { text, tone, until: Date.now() + NOTICE_MS };
		this.o.tui.requestRender();
	}

	// ---- input -----------------------------------------------------------

	handleInput(data: string): void {
		if (this.attached) return;
		const key = parseKey(data);
		// M79: the layer open takes the keys; else the view (the list, or a peek)
		const layer = this.layer;
		switch (layer?.kind) {
			case "help":
				// any key closes it
				this.closeLayer("help");
				this.o.tui.requestRender();
				return;
			case "overlay":
				layer.overlay.handleInput?.(data);
				this.o.tui.requestRender();
				return;
			case "picker":
				this.pickerKey(key, data);
				return;
			case "renaming":
				this.renameKey(key, data);
				return;
		}
		this.viewKey(key, data);
	}

	/** M79: a key for the view: the list's own first, then those of both (a peek's are among them). */
	private viewKey(key: string | undefined, data: string): void {
		const typing = this.peek ? this.reply : this.input;
		const text = typing.getValue();
		// M17: Ctrl+J (a bare LF) adds a line; a paste arriving in pieces goes to the editor whole (M48: the reply box too)
		if (data === "\n" || typing.inPaste()) {
			typing.handleInput(data);
			this.o.tui.requestRender();
			return;
		}
		// M48: the open completion menu takes its keys; Enter on a / command takes it and runs it at
		// once (as xpi's prompt does); on a path it only completes
		if (
			typing.autocompleteOpen() &&
			(key === "tab" || key === "up" || key === "down" || key === "enter" || key === "escape")
		) {
			typing.handleInput(data);
			if (key === "enter" && typing.getValue().startsWith("/")) return void this.enter();
			this.o.tui.requestRender();
			return;
		}
		if (!this.peek && this.listKey(key)) return;

		switch (key) {
			case "tab":
				// M6: @dir in the task box; else (M48) xpi's menu, forced open as xpi's Tab does
				if (!this.peek && this.completeAt()) return;
				typing.handleInput(data);
				this.o.tui.requestRender();
				return;
			case "ctrl+s":
				this.toggleGroupBy();
				return;
			case "ctrl+l":
				// M23: the model for new sessions, or for the session in the peek
				if (this.peek) {
					const row = this.peekId ? this.rows.get(this.peekId) : undefined;
					if (row) this.sessionSetting(row, "model", "");
					return;
				}
				this.newModelPicker();
				return;
			case "ctrl+t":
				return void this.togglePin();
			case "ctrl+r":
				this.startRename();
				return;
			case "ctrl+g":
				// M48: the reply too
				return void this.editExternally(typing);
			case "alt+up":
				this.jumpHeader(-1);
				return;
			case "alt+down":
				this.jumpHeader(1);
				return;
			case "shift+up":
				return void this.reorder(-1);
			case "shift+down":
				return void this.reorder(1);
			case "up":
			case "down":
				// M17: within a task (M48: or a reply) of several lines the arrows move in the text
				if (typing.multiline() && !typing.atEdge(key)) break;
				this.moveAndRender(key === "up" ? -1 : 1);
				return;
			case "pageUp":
				this.moveAndRender(-10);
				return;
			case "pageDown":
				this.moveAndRender(10);
				return;
			case "home":
				if (text) break;
				this.moveAndRender("home");
				return;
			case "end":
				if (text) break;
				this.moveAndRender("end");
				return;
			case "right":
				if (text && !this.filter()) break;
				return void this.attachSelected();
			case "escape":
				this.escape();
				return;
			case "ctrl+c":
				this.ctrlC();
				return;
			case "ctrl+x":
				return void this.stopSelected();
			case "ctrl+enter":
				if (!this.peek) return void this.dispatch(true);
				break;
			case "alt+enter":
				// M28 (as xpi): Alt+Enter queues the reply after the session's current work
				if (this.peek) return void this.sendReply("followUp");
				if (text.trim() && !this.filter() && this.markedRows().length > 0)
					return void this.sendToMarked("followUp");
				break;
			case "enter":
				return void this.enter();
			case "space":
				if (!text) {
					this.togglePeek();
					return;
				}
				break;
			case "?":
				if (!text) {
					this.openLayer({ kind: "help" });
					this.o.tui.requestRender();
					return;
				}
				break;
		}
		// PK-3: a digit on an empty reply fills the numbered choice
		if (this.peek && !text && key && /^[1-9]$/.test(key)) {
			const choice = this.selectedRow()?.choices[Number(key) - 1];
			if (choice) {
				fill(this.reply, choice);
				this.o.tui.requestRender();
				return;
			}
		}
		// AV-K14: Alt+1…9 attach to row N of the selected row's directory
		const alt = key ? /^alt\+([1-9])$/.exec(key) : null;
		if (alt) return void this.attachNth(Number(alt[1]));
		typing.handleInput(data);
		// DI-7: a filter selects its first match as it is typed
		if (!this.peek && this.filter()) {
			const first = this.itemList().find((it) => it.kind === "row");
			if (first?.kind === "row") this.cursor = { kind: "row", id: first.row.id };
		}
		this.o.tui.requestRender();
	}

	private moveAndRender(delta: number | "home" | "end"): void {
		this.move(delta);
		this.o.tui.requestRender();
	}

	/** M79: the list's own keys (in a peek they are typed into the reply, or do nothing): whether it took it. */
	private listKey(key: string | undefined): boolean {
		switch (key) {
			case "ctrl+p":
				this.cycleModel(1);
				return true;
			case "shift+ctrl+p":
			case "ctrl+shift+p":
				this.cycleModel(-1);
				return true;
			case "shift+tab":
				this.cycleThinking();
				return true;
			case "ctrl+o":
				this.toggleMark();
				return true;
			case "ctrl+f":
				fill(this.input, "n:");
				this.o.tui.requestRender();
				return true;
		}
		return false;
	}

	private togglePeek(): void {
		const row = this.selectedRow();
		this.view = !this.peek && row !== undefined ? { kind: "peek", id: row.id } : { kind: "list" };
		// pin the selection to this row so it follows it into another group
		if (row) this.cursor = { kind: "row", id: row.id };
		this.reply.focused = this.peek;
		this.input.focused = !this.peek;
		this.reply.setValue("");
		this.o.tui.requestRender();
	}

	private closePeek(): void {
		this.view = { kind: "list" };
		this.reply.setValue("");
		this.reply.focused = false;
		this.input.focused = true;
	}

	/** AV-K15: close peek → clear input → exit. */
	private escape(): void {
		if (this.peek) {
			this.togglePeek();
			return;
		}
		if (this.input.getValue()) {
			this.input.setValue("");
			this.o.tui.requestRender();
			return;
		}
		if (this.markedRows().length > 0) {
			this.marked.clear();
			this.say("marks cleared");
			return;
		}
		const origin = this.origin;
		if (origin) {
			const row = this.rows.get(origin);
			if (row?.pid) {
				this.origin = undefined; // back here after detaching, Esc leaves
				void this.attachTo(origin).catch((err: unknown) => this.say(String(err), "error"));
				return;
			}
			if (!row || row.endedAt === null) {
				// dispatch answered before the worker's first report reached the view
				this.origin = undefined;
				this.attachWhenLive = origin;
				this.say("Your conversation is starting…", "accent");
				return;
			}
		}
		this.attachWhenLive = undefined;
		this.o.done();
	}

	/** AV-K16: clear input; twice to exit. */
	private ctrlC(): void {
		const typing = this.peek ? this.reply : this.input;
		if (typing.getValue()) {
			typing.setValue("");
			this.ctrlCAt = 0;
			this.o.tui.requestRender();
			return;
		}
		const now = Date.now();
		if (now - this.ctrlCAt < DOUBLE_PRESS_MS) {
			this.o.done();
			return;
		}
		this.ctrlCAt = now;
		this.say("Ctrl+C again to exit (background sessions keep running)");
	}

	private async enter(): Promise<void> {
		if (this.peek) return this.sendReply("steer");
		// a second Enter while a batch is sent neither sends again nor attaches
		if (this.sendingMarked) return;
		// M25: with rows marked, the typed text goes to each of them
		if (this.input.getValue().trim() && !this.filter() && this.markedRows().length > 0)
			return this.sendToMarked("steer");
		// AV-K2: filter text is not a task: Enter acts on the selection
		if (this.input.getValue().trim() && !this.filter()) return this.dispatch(false);
		const it = this.selected();
		if (it?.kind === "header") {
			if (this.collapsed.has(it.section.key)) this.collapsed.delete(it.section.key);
			else this.collapsed.add(it.section.key);
			this.o.tui.requestRender();
			return;
		}
		return this.attachSelected();
	}

	/** Ctrl+G: write the task in $VISUAL / $EDITOR (P2 row "Ctrl+G external editor"). */
	private async editExternally(box: TaskEditor = this.input): Promise<void> {
		const editor = process.env.VISUAL || process.env.EDITOR;
		if (!editor) return this.say("set $VISUAL or $EDITOR to edit the task in an editor", "warning");
		const current = box.getValue();
		const { tui } = this.o;
		let text: string | undefined;
		let dir: string | undefined;
		let stopped = false;
		try {
			dir = mkdtempSync(join(tmpdir(), "xpi-roost-task-"));
			const file = join(dir, "task.md");
			writeFileSync(file, current);
			this.attached = true; // the terminal belongs to the editor
			tui.stop({ preserveScreen: true });
			stopped = true;
			// $VISUAL may carry arguments ("code -w"): a shell line, with the file quoted
			const r = spawnSync(`${editor} '${file.replace(/'/g, "'\\''")}'`, { stdio: "inherit", shell: true });
			if (r.status === 0) text = readFileSync(file, "utf8").replace(/\s+$/, "");
		} catch (err) {
			this.say(`could not open the editor: ${(err as Error).message}`, "error");
		} finally {
			this.attached = false;
			if (stopped) {
				tui.start();
				tui.requestRender(true);
			}
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
		if (text === undefined) return this.say("editor exited with an error; task unchanged", "warning");
		// M17: the editor keeps the lines
		box.setValue(text);
		this.o.tui.requestRender();
	}

	// ---- in-view commands (DI-4) -----------------------------------------

	/** Not a skill or prompt template (those can be a session's first prompt). */
	private isViewCommand(name: string): boolean {
		if (name.startsWith("skill:")) return false;
		return !(this.o.commands?.() ?? []).some(
			(c) => c.name === name && (c.source === "prompt" || c.source === "skill"),
		);
	}

	/** Returns true when the command was handled here (and the input consumed). */
	private command(name: string, arg: string): boolean {
		const done = () => {
			this.input.setValue("");
			this.o.tui.requestRender();
			return true;
		};
		switch (name) {
			case "exit":
			case "quit":
				this.o.done();
				return true;
			case "model": {
				if (arg) {
					const known = this.o.models?.() ?? [];
					if (arg !== "default" && known.length > 0 && !known.includes(arg)) {
						this.say(`unknown model ${arg} (bare /model lists them)`, "warning");
						return true;
					}
					this.model = arg === "default" ? undefined : arg;
					this.say(this.model ? `new sessions use ${this.model}` : "new sessions use the default model");
					return done();
				}
				this.newModelPicker();
				return done();
			}
			case "thinking": {
				const levels: string[] = ["default", ...THINKING_LEVELS];
				if (arg) {
					if (!levels.includes(arg)) {
						this.say(`thinking is one of ${levels.join(", ")}`, "warning");
						return true;
					}
					this.thinking = arg === "default" ? undefined : arg;
					this.say(`new sessions think ${this.thinking ?? "at the default level"}`);
					return done();
				}
				this.openPicker("Thinking for new sessions", levels, this.thinking ?? "default", (v) => {
					this.thinking = v === "default" ? undefined : v;
					this.say(`new sessions think ${this.thinking ?? "at the default level"}`);
				});
				return done();
			}
			case "resume":
				this.resume();
				return done();
			case "usage":
				this.showUsage();
				return done();
			case "log":
			case "events":
				void this.showLog();
				return done();
			case "preset":
				if (this.presetCommand(arg)) return done();
				return true;
		}
		const known = this.o.commands?.().find((c) => c.name === name);
		if (known && (known.source === "prompt" || known.source === "skill")) return false;
		this.say(`/${name} isn't available in the hub`, "warning");
		return true; // the text stays in the input
	}

	private openPicker(
		title: string,
		values: string[],
		current: string,
		pick: (v: string) => void | Promise<void>,
	): void {
		const items = values.map((v) => ({ label: v, value: v }));
		this.openLayer({ kind: "picker", picker: { title, items, index: Math.max(0, values.indexOf(current)), pick } });
		this.o.tui.requestRender();
	}

	/**
	 * M23: models to choose from, searchable; the enabled ones (`enabledModels`, what xpi
	 * cycles through) first when there are some, Tab for all of them.
	 */
	private modelPicker(
		title: string,
		current: string,
		withDefault: boolean,
		pick: (v: string) => void | Promise<void>,
	): void {
		const all = this.o.models?.() ?? [];
		const enabled = (this.o.scopedModels?.() ?? []).filter((m) => all.length === 0 || all.includes(m));
		const def = this.o.defaultModel?.();
		const head = withDefault ? [{ label: `default${def ? ` (${def})` : ""}`, value: "default" }] : [];
		const list = (ids: string[]) => [...head, ...ids.map((m) => ({ label: m, value: m }))];
		const items = list(enabled.length > 0 ? enabled : all);
		this.openLayer({
			kind: "picker",
			picker: {
				title,
				items,
				index: Math.max(
					0,
					items.findIndex((it) => it.value === current),
				),
				pick,
				...(enabled.length > 0
					? { scope: "enabled models", other: { label: "all models", items: list(all) } }
					: {}),
			},
		});
		this.o.tui.requestRender();
	}

	/** M23: the model for new sessions (/model, Ctrl+L). */
	private newModelPicker(): void {
		this.modelPicker("Model for new sessions", this.model ?? "default", true, (v) => {
			this.model = v === "default" ? undefined : v;
			this.say(this.model ? `new sessions use ${this.model}` : "new sessions use the default model");
		});
	}

	/** M23: Ctrl+P / Shift+Ctrl+P: the next or previous enabled model for new sessions, as in xpi. */
	private cycleModel(step: 1 | -1): void {
		const all = this.o.models?.() ?? [];
		const enabled = (this.o.scopedModels?.() ?? []).filter((m) => all.length === 0 || all.includes(m));
		const ring = enabled.length > 0 ? enabled : all;
		if (ring.length === 0) {
			this.say("no models available", "warning");
			return;
		}
		const at = this.model ? ring.indexOf(this.model) : -1;
		const next = ring[((((at === -1 && step === -1 ? 0 : at) + step) % ring.length) + ring.length) % ring.length]!;
		this.model = next;
		this.say(`new sessions use ${next}`);
	}

	/** M23: Shift+Tab: the next thinking level for new sessions, as in xpi. */
	private cycleThinking(): void {
		const levels: (string | undefined)[] = [undefined, ...THINKING_LEVELS];
		const at = levels.indexOf(this.thinking);
		this.thinking = levels[(at + 1) % levels.length];
		this.say(`new sessions think ${this.thinking ?? "at the default level"}`);
	}

	/** M23 /resume: xpi's own session list when there is one, else the view's. */
	private resume(): void {
		if (this.o.sessionSelector) {
			try {
				const overlay = this.o.sessionSelector({
					cwd: this.dispatchCwd(),
					onSelect: (session) => {
						this.closeOverlay();
						void this.resumeSession(session).catch((err: unknown) => this.say((err as Error).message, "error"));
					},
					onCancel: () => this.closeOverlay(),
					requestRender: () => this.o.tui.requestRender(),
					busy: (path) =>
						[...this.rows.values()].some((r) => r.sessionFile === path && (r.pid !== null || r.endedAt === null)),
				});
				if ("focused" in overlay) overlay.focused = true;
				this.openLayer({ kind: "overlay", overlay: overlay });
				this.o.tui.requestRender();
				return;
			} catch (err) {
				this.say(
					`xpi's session list is unavailable (${oneLine((err as Error).message)}): the simple one`,
					"warning",
				);
			}
		}
		void this.resumePicker();
	}

	/** M24 /usage: what the sessions spent, by model and by session; Esc closes, ↑↓ scroll. */
	private showUsage(): void {
		this.openLayer({ kind: "overlay", overlay: createUsageOverlay(this.hostBase()) });
		this.o.tui.requestRender();
	}

	/** M43 /log: what happened lately across the sessions (newest first); r reloads, Esc closes. */
	private async showLog(only?: (e: RoostEvent) => boolean, title?: string): Promise<void> {
		const port = this.port;
		if (!port) return this.say("background service unavailable", "error");
		const o = await createLogOverlay(this.overlayHost(port), { only, title });
		if (!o) return;
		this.openLayer({ kind: "overlay", overlay: o });
		this.o.tui.requestRender();
	}

	private closeOverlay(): void {
		try {
			this.overlay?.dispose?.();
		} catch {}
		this.closeLayer("overlay");
		this.o.tui.requestRender();
	}

	/**
	 * M23: into a past session at once: its row when it has one (started again if it
	 * ended), else a new background job on it, attached as soon as it runs.
	 */
	private async resumeSession(s: Resumable): Promise<void> {
		if (s.path === this.o.currentSession?.()) return this.say("that is this xpi's own session", "warning");
		const row = [...this.rows.values()].find((r) => r.sessionFile === s.path);
		if (row) {
			this.cursor = { kind: "row", id: row.id };
			// chosen on purpose: no "Enter again to start it"
			this.restartAsk = { id: row.id, at: Date.now() };
			return this.attachTo(row.id);
		}
		if (!this.port) return this.say("background service unavailable", "error");
		const args = this.o.launch("", {
			cwd: s.cwd || this.dispatchCwd(),
			sessionFile: s.path,
			name: s.name,
			origin: "adopt",
		});
		let r: { id: string; name: string };
		try {
			r = await this.sends.dispatch(args, { tag: "hub" });
		} catch (err) {
			const e = err as DaemonError;
			if (e.code === "locked") return this.say(`${oneLine(s.name)} is open in another xpi window`, "warning");
			throw err;
		}
		this.cursor = { kind: "row", id: r.id };
		this.say(`resuming ${oneLine(r.name)}…`, "accent");
		// its first push may have come before this reply
		if (this.rows.get(r.id)?.pid) {
			if (!this.attached) void this.attachTo(r.id).catch((err: unknown) => this.say(String(err), "error"));
		} else this.attachWhenLive = r.id;
	}

	private pickerKey(key: string | undefined, data = ""): void {
		const p = this.picker!;
		const shown = pickerShown(p);
		if (key === "escape" || key === "ctrl+c") {
			// M23: Esc clears the search first
			if (p.query) {
				p.query = "";
				p.index = 0;
			} else this.closeLayer("picker");
		} else if (key === "up") p.index = Math.max(0, p.index - 1);
		else if (key === "down") p.index = Math.min(shown.length - 1, p.index + 1);
		else if (key === "pageUp") p.index = Math.max(0, p.index - 10);
		else if (key === "pageDown") p.index = Math.min(shown.length - 1, p.index + 10);
		else if (key === "tab" && p.other) {
			// M23: the enabled models and all of them (the one selected stays selected)
			const items = p.items;
			const scope = p.scope;
			const was = shown[p.index]?.value;
			p.items = p.other.items;
			p.scope = p.other.label;
			p.other = { label: scope ?? "", items };
			p.index = Math.max(
				0,
				pickerShown(p).findIndex((it) => it.value === was),
			);
		} else if (key === "backspace") {
			p.query = (p.query ?? "").slice(0, -1);
			p.index = 0;
		} else if (key === "enter") {
			// nothing matches: the search stays to be changed
			if (shown.length === 0) {
				this.o.tui.requestRender();
				return;
			}
			this.closeLayer("picker");
			const item = shown[p.index];
			if (item)
				void Promise.resolve(p.pick(item.value)).catch((err: unknown) => this.say((err as Error).message, "error"));
		} else {
			// M23: typing searches (a paste too, its lines joined; a kitty-encoded key is decoded)
			const pasted = data.startsWith("\x1b[200~")
				? data.replace(/\x1b\[20[01]~/g, "").replace(/[\r\n\t]+/g, " ")
				: undefined;
			const text = pasted ?? (isKeyRelease(data) ? undefined : (decodeKittyPrintable(data) ?? data));
			if (text && !text.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(text)) {
				p.query = (p.query ?? "") + text;
				p.index = 0;
			}
		}
		this.o.tui.requestRender();
	}

	/** DI-4 /resume: a past session of this directory without a row becomes a job. */
	private async resumePicker(): Promise<void> {
		if (!this.o.resumable) return this.say("/resume is not available here", "warning");
		const cwd = this.dispatchCwd();
		const known = new Set([...this.rows.values()].map((r) => r.sessionFile).filter(Boolean));
		let sessions: Resumable[];
		this.say("loading sessions…");
		try {
			sessions = await this.o.resumable(cwd);
		} catch (err) {
			return this.say((err as Error).message, "error");
		}
		if (sessions.length === 0) return this.say("no past sessions to resume here");
		const byPath = new Map(sessions.map((s) => [s.path, s]));
		this.openLayer({
			kind: "picker",
			picker: {
				title: "Resume a session in the background",
				items: sessions.slice(0, 200).map((s) => ({
					label: `${oneLine(s.name)} · ${formatAgo(Date.now() - s.modified)}${known.has(s.path) ? " · listed" : ""}`,
					value: s.path,
				})),
				index: 0,
				pick: (path) => this.resumeSession(byPath.get(path)!),
			},
		});
		this.o.tui.requestRender();
	}

	/** DI-3: Tab completes the @dir being typed. */
	private completeAt(): boolean {
		const value = this.input.getValue();
		const prefix = atPrefix(value);
		if (prefix === undefined) return false;
		const first = this.atSuggestions(prefix)[0];
		if (!first) return true;
		// M17: only the word being typed changes; a folded paste before it stays folded
		this.input.replaceTail(prefix.length, `${first} `);
		this.o.tui.requestRender();
		return true;
	}

	private atCache: { key: string; at: number; list: string[] } | undefined;

	/** Cached briefly: render runs on every key and tick, and this reads directories. */
	private atSuggestions(prefix: string): string[] {
		const base = this.dispatchCwd();
		const key = `${base}\0${prefix}`;
		if (this.atCache && this.atCache.key === key && Date.now() - this.atCache.at < 2000) return this.atCache.list;
		const list = atCandidates(base, [...new Set([...this.rows.values()].map((r) => r.cwd))], prefix);
		this.atCache = { key, at: Date.now(), list };
		return list;
	}

	// ---- organise (AV-K6…K14) --------------------------------------------

	private toggleGroupBy(): void {
		const row = this.selectedRow() ?? this.selected()?.section.rows[0];
		this.groupBy = this.groupBy === "state" ? "directory" : "state";
		this.collapsed.clear();
		this.cursor = row ? { kind: "row", id: row.id } : undefined;
		try {
			this.o.onGroupBy?.(this.groupBy);
		} catch (err) {
			this.say(`could not save the grouping: ${(err as Error).message}`, "warning");
		}
		this.say(this.groupBy === "directory" ? "grouped by directory" : "grouped by state");
	}

	private async togglePin(): Promise<void> {
		// a peek acts on its own row, never on the marks
		const marked = this.peek ? [] : this.markedRows();
		if (marked.length > 0 && this.port) {
			// M25: pin them all, unless all are pinned already
			const pinned = marked.some((r) => !r.pinned);
			let failed = 0;
			for (const r of marked) {
				try {
					await this.port.jobs.pin(r.id, pinned);
				} catch {
					failed++;
				}
			}
			return this.say(
				`${pinned ? "pinned" : "unpinned"} ${marked.length - failed} sessions${failed ? ` · ${failed} failed` : ""}`,
				failed ? "warning" : "muted",
			);
		}
		const row = this.selectedRow();
		if (!row || !this.port) return;
		try {
			const { pinned } = await this.port.jobs.pin(row.id, !row.pinned);
			this.cursor = { kind: "row", id: row.id };
			this.say(pinned ? `pinned · ${row.name} (kept running)` : `unpinned · ${row.name}`);
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	private startRename(): void {
		const row = this.selectedRow();
		if (!row) return;
		this.openLayer({ kind: "renaming", id: row.id });
		fill(this.renameInput, row.name);
		this.renameInput.focused = true;
		this.input.focused = false;
		this.o.tui.requestRender();
	}

	private endRename(): void {
		this.closeLayer("renaming");
		this.renameInput.focused = false;
		this.input.focused = true;
		this.o.tui.requestRender();
	}

	private renameKey(key: string | undefined, data: string): void {
		if (key === "escape" || key === "ctrl+c") {
			this.endRename();
			return;
		}
		if (key === "enter") {
			const id = this.renaming!;
			const name = this.renameInput.getValue().trim();
			this.endRename();
			if (!name || !this.port) return;
			void this.port.jobs
				.rename(id, name)
				.then(() => this.say(`renamed · ${name}`, "success"))
				.catch((err: unknown) => this.say((err as Error).message, "error"));
			return;
		}
		this.renameInput.handleInput(data);
		this.o.tui.requestRender();
	}

	private jumpHeader(dir: 1 | -1): void {
		const list = this.itemList();
		let i = this.selectedIndex(list);
		for (i += dir; i >= 0 && i < list.length; i += dir) {
			const it = list[i]!;
			if (it.kind === "header") {
				this.cursor = { kind: "header", key: it.section.key };
				this.o.tui.requestRender();
				return;
			}
		}
	}

	private async reorder(dir: 1 | -1): Promise<void> {
		const it = this.selected();
		if (it?.kind !== "row" || !this.port) return;
		if (this.filter()) return this.say("clear the filter to reorder", "warning");
		// the whole section, including rows folded into "… N more"
		const full = layout(this.listedRows(), { groupBy: this.groupBy }).find((s) => s.key === it.section.key);
		const rows = full?.rows ?? it.section.rows;
		const i = rows.findIndex((r) => r.id === it.row.id);
		const j = i + dir;
		if (j < 0 || j >= rows.length) return;
		const ids = rows.map((r) => r.id);
		[ids[i], ids[j]] = [ids[j]!, ids[i]!];
		// apply locally at once; the daemon's events confirm it
		const key = it.section.key;
		ids.forEach((id, n) => {
			const r = this.rows.get(id);
			if (r) this.rows.set(id, { ...r, order: n, orderKey: key });
		});
		this.o.tui.requestRender();
		try {
			await this.port.jobs.reorder(ids, key);
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	private async attachNth(n: number): Promise<void> {
		const sel = this.selectedRow();
		const cwd = sel?.cwd ?? this.o.cwd;
		const rows = this.itemList()
			.filter((it): it is Extract<Item, { kind: "row" }> => it.kind === "row" && it.row.cwd === cwd)
			.map((it) => it.row);
		const row = rows[n - 1];
		if (!row) return this.say(`no row ${n} in ${cwd}`, "warning");
		this.cursor = { kind: "row", id: row.id };
		return this.attachTo(row.id);
	}

	// ---- actions ---------------------------------------------------------

	/** Where a dispatch goes: the selected directory section when grouping by directory. */
	private dispatchCwd(): string {
		if (this.groupBy === "directory") {
			const it = this.selected();
			if (it?.section.dir) return it.section.dir;
			if (it?.kind === "row") return it.row.cwd;
		}
		return this.o.cwd;
	}

	private async dispatch(attach: boolean): Promise<void> {
		if (this.dispatching) return;
		if (this.filter()) return this.say("that is a filter; Enter attaches to the selected row", "warning");
		const typed = this.input.getValue();
		const base = this.dispatchCwd();
		const parsed = parseInput(typed, base);
		if (parsed.kind === "command") {
			const handled = this.command(parsed.name, parsed.arg);
			if (handled) return;
			// DI-5: skills and prompt templates run as the session's first prompt
		}
		let args: LaunchRequest;
		if (parsed.kind === "shell") {
			if (!parsed.command) return this.say("! needs a command", "warning");
			if (!this.o.launchShell) return this.say("shell commands are not available here", "warning");
			const dir = parsed.cwd ? undefined : this.presetDir();
			if (dir && "error" in dir) return this.say(dir.error, "warning");
			args = this.o.launchShell(parsed.command, parsed.cwd ?? dir?.path ?? base);
		} else {
			const task = parsed.kind === "task" ? parsed.task : typed.trim();
			if (task.length < MIN_TASK) return this.say("Too short", "warning");
			// M27: a typed @dir wins over the preset's
			const typedDir = parsed.kind === "task" ? parsed.cwd : undefined;
			const dir = typedDir ? undefined : this.presetDir();
			if (dir && "error" in dir) return this.say(dir.error, "warning");
			const cwd = typedDir ?? dir?.path ?? base;
			try {
				args = this.o.launch(task, { cwd, model: this.model, thinking: this.thinking });
			} catch (err) {
				return this.say((err as Error).message, "error");
			}
		}
		const { note, ...request } = args;
		if (!this.port) return this.say("background service unavailable", "error");
		this.dispatching = true;
		this.input.setValue("");
		try {
			const { id, name } = await this.sends.dispatch(request, { tag: "hub" });
			this.cursor = { kind: "row", id };
			this.say(`started · ${name}${note ? ` · ${note}` : ""}`, note ? "warning" : "success");
			if (attach) {
				const deadline = Date.now() + 3000;
				while (!this.rows.get(id)?.pid && Date.now() < deadline) await sleep(50);
				await this.attachTo(id);
			}
		} catch (err) {
			if (!this.input.getValue()) this.input.setValue(typed);
			this.say((err as Error).message, "error");
		} finally {
			this.dispatching = false;
		}
	}

	/** M28: Enter steers into the work under way (xpi's Enter); Alt+Enter waits for it (xpi's Alt+Enter). */
	private async sendReply(mode: ReplyMode = "steer"): Promise<void> {
		const row = this.peekId ? this.rows.get(this.peekId) : undefined;
		const text = this.reply.getValue().trim();
		if (!row) {
			this.closePeek();
			return this.say("that session no longer exists", "warning");
		}
		if (!text || !this.port || this.sendingReply) return;
		// M48: a /command the peek knows is for that session (M8: /model and /thinking among them);
		// any other /… goes to the session as a reply (xpi's prompt templates and skills, say)
		const cmd = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
		const name = cmd?.[1]?.toLowerCase();
		if (cmd && name && PEEK_COMMANDS.some((c) => c.name === name)) {
			try {
				await this.peekCommand(row, name, (cmd[2] ?? "").trim());
			} catch (err) {
				this.say((err as Error).message, "error");
			}
			return;
		}
		// M61: xpi's own commands (/session, /tree, …) are typed into the session's xpi: its worker never sees them
		const builtin = name ? this.builtin(name) : undefined;
		if (cmd && name && builtin && builtin.how !== "hub" && builtin.how !== "reply" && row.kind === "pi") {
			try {
				// xpi matches its commands exactly: the name as xpi spells it, the arguments as typed
				await this.xpiBuiltin(row, name, builtin.how, `/${name}${cmd[2]?.trim() ? ` ${cmd[2].trim()}` : ""}`);
			} catch (err) {
				this.say((err as Error).message, "error");
			}
			return;
		}
		if (text.startsWith("!"))
			return this.say("shell commands are not sent to a session; attach (→) to run one", "warning");
		try {
			// M51: one at a time (a second Enter while it is sent again would send it twice)
			this.sendingReply = true;
			const r = await this.sends.reply({ id: row.id, text, mode }, { tag: "hub" }).finally(() => {
				this.sendingReply = false;
			});
			this.reply.setValue("");
			if (r.duplicate) this.say(`sent · ${row.name}`, "success");
			else if (r.stopped) this.say(`stopped · ${row.name}`);
			else if (r.delivered) {
				const how =
					row.state !== "working"
						? ""
						: mode === "steer"
							? " · joins its current work"
							: " · after its current work";
				// M61: the session's own command says so
				const own = name && this.sessionCommandList(row).some((c) => c.name.toLowerCase() === name);
				this.say(
					row.waitingFor === "dialog"
						? "queued; attach (→) to answer the dialog"
						: `${own ? `/${name}` : "sent"} · ${row.name}${how}`,
					"success",
				);
			} else if (r.respawned) this.say(`sent · starting ${row.name} again`, "success");
			else if (r.saved)
				this.say(`saved; it is sent when the session starts again${r.error ? ` (${r.error})` : ""}`, "warning");
			else this.say("not delivered: the session is not running", "error");
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/** M48: a `/command` typed in a peek acts on that session (the keys' code, by name). */
	private async peekCommand(row: JobRow, name: string, arg: string): Promise<void> {
		const port = this.port;
		if (!port) return this.say("background service unavailable", "error");
		const done = () => {
			this.reply.setValue("");
			this.o.tui.requestRender();
		};
		switch (name) {
			case "model":
			case "thinking":
				// M8: with the same pickers as for new sessions
				return this.sessionSetting(row, name, arg);
			case "stop":
				done();
				if (row.pid === null) return this.say(`${row.name} is not running`, "warning");
				await port.jobs.stop(row.id);
				return this.say(`stopping · ${row.name}`, "warning");
			case "respawn": {
				done();
				const r = await port.jobs.respawn(row.id);
				const first = r.results[0];
				return first?.started
					? this.say(`starting ${row.name} again`, "success")
					: this.say(first?.error ?? `${row.name} was not started`, "warning");
			}
			case "rm": {
				// twice within 2 s, as Ctrl+X Ctrl+X
				done();
				const now = Date.now();
				if (this.armedStop?.id === row.id && now - this.armedStop.at < DOUBLE_PRESS_MS) {
					this.armedStop = undefined;
					await port.jobs.rm(row.id);
					this.closePeek();
					return this.say(`deleted · ${row.name}`);
				}
				this.armedStop = { id: row.id, at: now };
				return this.say(
					`/rm again within 2 s to delete ${row.name}${row.pid !== null ? " (it is running: it is stopped first)" : ""}`,
					"warning",
				);
			}
			case "pin":
				done();
				return this.togglePin();
			case "rename": {
				done();
				if (!arg) return this.startRename();
				await port.jobs.rename(row.id, arg);
				return this.say(`renamed · ${arg}`, "success");
			}
			case "attach":
				done();
				return this.attachSelected();
			case "log":
				done();
				return this.showLog(
					(e) => e.id === row.id || e.whoId === row.id,
					`Log · ${oneLine(row.name)} (newest first)`,
				);
			case "transcript":
				done();
				return this.showTranscript(row);
			case "continue":
				this.reply.setValue("Continue where you left off.");
				return this.sendReply("followUp");
			case "name":
			case "compact": {
				// xpi's own, run in the session by the worker (a session that ended is not started again for it)
				if (name === "name" && !arg) return this.say("/name <the session's own name>", "warning");
				if (row.kind === "shell") return this.say(`/${name} is for an xpi session`, "warning");
				if (row.pid === null)
					return this.say(`${row.name} is not running: /${name} works in a running session`, "warning");
				const r = await this.sends.reply({ id: row.id, text: `/${name}${arg ? ` ${arg}` : ""}` }, { tag: "hub" });
				done();
				if (r.delivered) return this.say(`/${name} · ${row.name}`, "success");
				return this.say(
					r.respawned
						? `starting ${row.name} again; /${name} runs then`
						: r.saved
							? `saved; it runs when ${row.name} starts again`
							: `not delivered: ${row.name} is not running`,
					"warning",
				);
			}
			default:
			// not the peek's: sendReply sends it to the session
		}
	}

	/** M48 /transcript in a peek: its transcript (a shell command: its screen), the end first in view; r reloads. */
	private showTranscript(row: JobRow): void {
		const view = this;
		const t = this.o.theme;
		let body: string[] = [];
		let bodyWidth = 0; // the width body was laid out for: a narrower terminal lays it out again
		let top = -1; // -1: the end
		const load = (width: number): string[] => {
			const inner = Math.max(1, width - 2);
			const out: string[] = [];
			try {
				if (row.kind === "shell" || !row.sessionFile) {
					for (const l of readFileSync(screenPath(row.id), "utf8").trimEnd().split("\n"))
						out.push(truncateToWidth(l.replace(CONTROL, " "), inner));
				} else {
					const tail = readTail(row.sessionFile);
					for (const it of transcriptItems(tail.text, tail.truncated)) {
						const text =
							it.kind === "tool"
								? `⚙ ${it.name}${it.args ? ` ${it.args}` : ""}${it.result ? `\n  → ${it.result}` : ""}`
								: it.kind === "user"
									? `you: ${it.text}`
									: it.kind === "assistant"
										? `› ${it.text}`
										: `· ${it.text}`;
						// a long result shows its first lines
						for (const l of text.replace(CONTROL, " ").split("\n").slice(0, 24))
							for (const w of wrap(l, inner))
								out.push(
									it.kind === "assistant"
										? w
										: t.fg(
												it.kind === "user" ? "accent" : it.kind === "tool" && it.error ? "error" : "muted",
												w,
											),
								);
						out.push("");
					}
				}
			} catch {
				out.push(t.fg("dim", "(nothing to read yet)"));
			}
			return out.length > 0 ? out : [t.fg("dim", "(empty)")];
		};
		this.openLayer({
			kind: "overlay",
			overlay: {
				render(width: number) {
					if (body.length === 0 || bodyWidth !== width) {
						body = load(width);
						bodyWidth = width;
					}
					const room = Math.max(3, (view.o.tui.terminal.rows || 30) - 6);
					const all = [t.bold(truncateToWidth(`Transcript · ${oneLine(row.name)}`, width)), "", ...body];
					if (top < 0) top = Math.max(0, all.length - room);
					top = Math.max(0, Math.min(top, Math.max(0, all.length - room)));
					return [
						...all.slice(top, top + room),
						"",
						t.fg("dim", truncateToWidth("r reload · ↑↓ PgUp PgDn scroll · Esc close", width)),
					];
				},
				handleInput(data: string) {
					const key = parseKey(data);
					if (key === "escape" || key === "ctrl+c" || data === "q") view.closeOverlay();
					else if (data === "r") {
						body = [];
						top = -1;
					} else if (key === "up") top = Math.max(0, top - 1);
					else if (key === "down") top++;
					else if (key === "pageUp") top = Math.max(0, top - 10);
					else if (key === "pageDown") top += 10;
				},
			},
		});
		this.o.tui.requestRender();
	}

	/** M48: xpi's own completion (xxpi-tui) for a box: `/` its commands, `@` paths under its directory (fuzzy with fd). */
	private completion(commands: () => SlashCommand[], base: () => string): AutocompleteProvider {
		const fresh = () => new CombinedAutocompleteProvider(commands(), base(), fdOnPath());
		return {
			triggerCharacters: ["/", "@"],
			getSuggestions: (lines, line, col, options) => fresh().getSuggestions(lines, line, col, options),
			applyCompletion: (lines, line, col, item, prefix) => fresh().applyCompletion(lines, line, col, item, prefix),
			shouldTriggerFileCompletion: (lines, line, col) => fresh().shouldTriggerFileCompletion(lines, line, col),
		};
	}

	/** The task box's commands: the view's, then xpi's prompt templates and skills (a session's first prompt). */
	private viewCommands(): SlashCommand[] {
		const levels = () => [...THINKING_LEVELS].map((v) => ({ value: v, label: v }));
		const models = () => (this.o.models?.() ?? []).map((m) => ({ value: m, label: m }));
		const names = (list: string[]) => list.map((n) => ({ value: n, label: n }));
		const starts = (items: { value: string; label: string; description?: string }[], prefix: string) =>
			items.filter((i) => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		const own: SlashCommand[] = [
			{
				name: "model",
				description: "the model for new sessions",
				argumentHint: "provider/id | default",
				getArgumentCompletions: (p) => starts(models(), p),
			},
			{
				name: "thinking",
				description: "the thinking level for new sessions",
				argumentHint: "level",
				getArgumentCompletions: (p) => starts(levels(), p),
			},
			{ name: "resume", description: "pick a session to resume in the background" },
			{ name: "usage", description: "what the sessions spent" },
			{ name: "log", description: "what happened lately" },
			{
				name: "preset",
				description: "launch presets",
				argumentHint: "name | save name | rm name | off",
				getArgumentCompletions: (p) =>
					starts(names([...Object.keys(this.o.presets?.() ?? {}), "save", "rm", "off"]), p),
			},
			{ name: "exit", description: "leave the hub" },
		];
		const xpi = (this.o.commands?.() ?? [])
			.filter((c) => c.source === "prompt" || c.source === "skill")
			.map((c) => ({ name: c.name, description: `xpi: ${c.source}` }));
		return [...own, ...xpi];
	}

	/** T18: one of xpi's commands, with how a peek runs it. */
	private builtin(name: string): BuiltinCommand | undefined {
		return this.o.builtins?.().find((c) => c.name === name);
	}

	/** M61: the session's own commands, from the worker's commands.json (cached by its mtime). */
	private sessionCommandList(row: JobRow): { name: string; description?: string; source: string }[] {
		if (row.kind !== "pi") return [];
		if (this.o.sessionCommands) return this.o.sessionCommands(row.id);
		try {
			const mtime = statSync(commandsPath(row.id)).mtimeMs;
			const hit = this.commandsCache.get(row.id);
			if (hit?.mtime === mtime) return hit.list;
			const list = readCommands(row.id);
			this.commandsCache.set(row.id, { mtime, list });
			return list;
		} catch {
			return [];
		}
	}

	/**
	 * A peek's commands: for that session, in groups tagged at the start of the description:
	 * the hub's, xpi's built-ins (not those the hub has), then the session's own (M61).
	 */
	private peekCommands(): SlashCommand[] {
		const starts = (items: { value: string; label: string }[], prefix: string) =>
			items.filter((i) => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		const row = this.peekId ? this.rows.get(this.peekId) : undefined;
		const gone = row !== undefined && row.pid === null;
		const busy = row?.state === "working" || row?.waitingFor === "dialog";
		const out: SlashCommand[] = PEEK_COMMANDS.map((c) => {
			// M61: what needs a running xpi session says so
			const mark =
				row && gone && row.kind === "pi" && ["stop", "name", "compact"].includes(c.name) ? " (not running)" : "";
			const base = { ...c, description: `hub · ${c.description}${mark}` };
			return c.name === "model"
				? {
						...base,
						getArgumentCompletions: (p: string) =>
							starts(
								(this.o.models?.() ?? []).map((m) => ({ value: m, label: m })),
								p,
							),
					}
				: c.name === "thinking"
					? {
							...base,
							getArgumentCompletions: (p: string) =>
								starts(
									[...THINKING_LEVELS].map((v) => ({ value: v, label: v })),
									p,
								),
						}
					: base;
		});
		const seen = new Set(out.map((c) => c.name));
		const add = (c: SlashCommand) => {
			if (seen.has(c.name)) return;
			seen.add(c.name);
			out.push(c);
		};
		if (!row || row.kind === "pi") {
			for (const c of this.o.builtins?.() ?? []) {
				// the hub's own, and the commands the session's worker runs (listed with the session's below)
				if (c.how === "hub" || c.how === "reply") continue;
				const mark = gone ? " (not running)" : busy ? " (when idle)" : "";
				add({
					name: c.name,
					description: `xpi · ${c.description}${mark}`,
					...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
				});
			}
		}
		if (row)
			for (const c of this.sessionCommandList(row))
				add({ name: c.name, description: `${c.source} · ${c.description ?? ""}`.replace(/ · $/, "") });
		return out;
	}

	/**
	 * M61: one of xpi's commands that its worker does not run, typed into the session's xpi:
	 * `screen` ones show the session's screen once it settles, `picker` ones attach so the
	 * picker is in front of the user, `confirm` (quit) asks twice.
	 */
	private async xpiBuiltin(
		row: JobRow,
		name: string,
		how: "screen" | "picker" | "confirm",
		text: string,
	): Promise<void> {
		const host = this.o.hostControl ?? hostControl;
		// xpi matches a command without arguments exactly: words after it would go to the model as a prompt
		const spec = this.builtin(name);
		const hasArgs = /\s/.test(text.trim());
		if (hasArgs && !spec?.args) return this.say(`/${name} takes no arguments`, "warning");
		if (!hasArgs && spec?.args === "required")
			return this.say(`/${name} needs ${spec.argumentHint ?? "an argument"}`, "warning");
		if (this.commandBusy) return;
		if (row.pid === null)
			return this.say(`${row.name} is not running: /${name} works in a running session`, "warning");
		if (row.state === "working" || row.waitingFor === "dialog")
			return this.say(
				`${row.name} is ${row.state === "working" ? "working" : "in a dialog"}: /${name} works when it is idle`,
				"warning",
			);
		this.commandBusy = true;
		try {
			return await this.xpiBuiltinRun(row, name, how, text, host);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			return this.say(
				code === "ENOENT" || code === "ECONNREFUSED"
					? `${row.name} has no host to type into: run /${name} there`
					: (err as Error).message,
				"error",
			);
		} finally {
			this.commandBusy = false;
		}
	}

	private async xpiBuiltinRun(
		row: JobRow,
		name: string,
		how: "screen" | "picker" | "confirm",
		text: string,
		host: typeof hostControl,
	): Promise<void> {
		const st = (await host(row.id, "status")) as { attached?: boolean };
		if (st.attached)
			return this.say(`${row.name} is attached elsewhere: its editor is theirs; detach it first`, "warning");
		if (how === "confirm") {
			const now = Date.now();
			const key = `quit:${row.id}`;
			if (this.armedStop?.id !== key || now - this.armedStop.at >= DOUBLE_PRESS_MS) {
				this.armedStop = { id: key, at: now };
				return this.say(`/${name} again within 2 s to end ${row.name}`, "warning");
			}
			this.armedStop = undefined;
		}
		const r = (await host(row.id, "command", 3000, { text })) as { ok?: boolean; error?: string };
		if (!r.ok) return this.say(r.error ?? `/${name} was not delivered: ${row.name} is not running`, "error");
		this.reply.setValue("");
		this.o.tui.requestRender();
		if (how === "picker") return this.attachTo(row.id);
		if (how === "confirm") return this.say(`/${name} · ${row.name}`, "warning");
		await sleep(800);
		const shot = async () => ((await host(row.id, "snapshot")) as { text?: string }).text ?? "";
		this.showScreen(row, text.split(/\s/)[0]!, await shot(), shot);
	}

	/** M61: a session's screen as an overlay (what a built-in command printed); r reloads, Esc closes. */
	private showScreen(row: JobRow, title: string, first: string, reload: () => Promise<string>): void {
		const view = this;
		const t = this.o.theme;
		let screen = first;
		this.openLayer({
			kind: "overlay",
			overlay: {
				render(width: number) {
					const room = Math.max(3, (view.o.tui.terminal.rows || 30) - 6);
					const lines = screen
						.trimEnd()
						.split("\n")
						.map((l) => truncateToWidth(l.replace(CONTROL, " "), Math.max(1, width - 2)));
					return [
						t.bold(truncateToWidth(`${title} · ${oneLine(row.name)}`, width)),
						"",
						...lines.slice(-room),
						"",
						t.fg("dim", truncateToWidth("r reload · Esc close", width)),
					];
				},
				handleInput(data: string) {
					const key = parseKey(data);
					if (key === "escape" || key === "ctrl+c" || data === "q") view.closeOverlay();
					else if (data === "r")
						void reload().then(
							(text) => {
								screen = text;
								view.o.tui.requestRender();
							},
							(err: unknown) => view.say(String((err as Error).message ?? err), "error"),
						);
				},
			},
		});
		this.o.tui.requestRender();
	}

	/** M8: switch a session's model or thinking level from its peek. */
	private sessionSetting(row: JobRow, which: "model" | "thinking", arg: string): void {
		if (row.kind === "shell") {
			this.say("a shell command has no model", "warning");
			return;
		}
		const values: string[] = which === "model" ? (this.o.models?.() ?? []) : [...THINKING_LEVELS];
		const apply = async (v: string) => void (await this.sendSetting(row, which, v));
		if (arg) {
			if (arg === "default") {
				this.say(`a running session has no default ${which}: pick one (bare /${which})`, "warning");
				return;
			}
			if (which === "model" && !arg.includes("/")) {
				this.say("use provider/id (bare /model lists them)", "warning");
				return;
			}
			if (values.length > 0 && !values.includes(arg)) {
				this.say(
					which === "model"
						? `unknown model ${arg} (bare /model lists them)`
						: `thinking is one of ${values.join(", ")}`,
					"warning",
				);
				return;
			}
			return void apply(arg);
		}
		if (values.length === 0) {
			this.say("no models available", "warning");
			return;
		}
		this.reply.setValue("");
		const current = (which === "model" ? row.model : row.thinking) ?? "";
		if (which === "model") {
			this.modelPicker(`Model for ${oneLine(row.name)}`, current, false, apply);
			return;
		}
		this.openPicker(`Thinking for ${oneLine(row.name)}`, values, current, apply);
	}

	private async sendSetting(
		picked: JobRow,
		which: "model" | "thinking",
		value: string,
		quiet = false,
	): Promise<boolean> {
		// M25: quiet (a batch) says nothing itself and answers whether it reached the session
		const say = (text: string, tone?: Tone) => {
			if (!quiet) this.say(text, tone);
		};
		if (!this.port) {
			say("background service unavailable", "error");
			return false;
		}
		// the picker may have been open a while: act on the row as it is now
		const row = this.rows.get(picked.id);
		if (!row) {
			say("that session no longer exists", "warning");
			return false;
		}
		const pending = this.switches.get(switchKey(row.id, which));
		// a second switch before the first shows: compare with what the session had before both
		const before = pending ? pending.before : ((which === "model" ? row.model : row.thinking) ?? null);
		try {
			const r = await this.sends.reply({ id: row.id, text: `/${which} ${value}` }, { tag: "hub" });
			if (!quiet) this.reply.setValue("");
			if (r.delivered) {
				// asked, not done: the worker may lack credentials, or xpi may lower a thinking level
				if (!pending && before === value) {
					say(`${row.name} already uses ${which} ${value}`);
					return true;
				}
				this.watchSwitch(row, which, value, before, pending ? [...pending.superseded, pending.value] : []);
				say(`asked ${row.name} to use ${which} ${value}…`);
				return true;
			}
			if (r.respawned) say(`${which} ${value} · starting ${row.name} again`, "success");
			else if (r.saved)
				say(`saved; ${which} changes when the session starts again${r.error ? ` (${r.error})` : ""}`, "warning");
			else if (row.pid !== null || row.endedAt === null)
				say(`${row.name} is starting; try again in a moment`, "warning");
			else say("not delivered: the session is not running", "error");
			return r.respawned === true || r.saved === true;
		} catch (err) {
			say((err as Error).message, "error");
			return false;
		}
	}

	/** One watch per session and setting: a /thinking does not cancel the check of a /model. */
	private watchSwitch(
		row: JobRow,
		which: "model" | "thinking",
		value: string,
		before: string | null,
		replaced: string[],
	): void {
		// the value asked for now is the outcome, even if an earlier switch asked for it too
		const superseded = [...new Set(replaced)].filter((v) => v !== value);
		const key = switchKey(row.id, which);
		const old = this.switches.get(key);
		if (old) clearTimeout(old.timer);
		const timer = setTimeout(() => {
			if (this.switches.get(key)?.timer !== timer) return;
			this.switches.delete(key);
			const now = this.rows.get(row.id);
			if (!now) return;
			const actual = (which === "model" ? now.model : now.thinking) ?? null;
			// a report the view missed (a reconnect) may already show it
			if (actual === value) return this.say(`${now.name} now uses ${which} ${value}`, "success");
			this.say(
				// the hint first: a long model id may be cut at 80 columns (the peek names the session)
				which === "model"
					? `model switch failed (credentials? envAllowList): still ${actual ? shortModel(actual) : "?"}, not ${shortModel(value)}`
					: `thinking ${value} not taken (unsupported?): still ${actual ?? "?"}`,
				"warning",
			);
		}, this.o.switchCheckMs ?? SWITCH_CHECK_MS);
		timer.unref?.();
		this.switches.set(key, { which, value, before, superseded, timer });
	}

	/** A report shows a switch (or xpi's adjusted thinking level). */
	private checkSwitch(row: JobRow): void {
		for (const which of ["model", "thinking"] as const) {
			const key = switchKey(row.id, which);
			const s = this.switches.get(key);
			if (!s) continue;
			const actual = (which === "model" ? row.model : row.thinking) ?? null;
			// only a switch this one replaced: from now on that is the value to move away from
			if (actual !== null && s.superseded.includes(actual)) {
				s.before = actual;
				s.superseded = s.superseded.filter((v) => v !== actual);
				continue;
			}
			if (actual === s.before) continue; // not applied yet (the timer decides)
			clearTimeout(s.timer);
			this.switches.delete(key);
			if (actual === s.value) {
				// a running turn keeps its current request; the next one uses the new setting
				this.say(
					`${row.name} now uses ${which} ${s.value}${row.state === "working" ? " (from its next request)" : ""}`,
					"success",
				);
			} else if (which === "thinking")
				this.say(`${row.name} thinks ${actual ?? "?"}: the closest its model supports to ${s.value}`, "warning");
			else this.say(`${row.name} now uses ${actual ?? "?"}`, "warning");
		}
	}

	/**
	 * M27: the preset's directory, under the hub's (links resolved: a cloned project's
	 * preset cannot reach outside it), when it has one.
	 */
	private presetDir(): { path: string } | { error: string } | undefined {
		const d = this.preset?.dir;
		if (!d) return undefined;
		const path = resolve(this.o.cwd, d);
		let real: string;
		let root: string;
		try {
			real = realpathSync(path);
			root = realpathSync(this.o.cwd);
		} catch {
			return { error: `the preset's directory ${d} does not exist here` };
		}
		const rel = relative(root, real);
		if (rel.startsWith("..") || isAbsolute(rel))
			return { error: `the preset's directory ${d} leads outside ${this.o.cwd}` };
		return { path };
	}

	/** M27: /preset [name | off | save name | rm name]; false: the text stays in the input. */
	private presetCommand(arg: string): boolean {
		const all = this.o.presets?.() ?? {};
		const has = (n: string) => Object.hasOwn(all, n);
		const [verb, name = "", ...rest] = arg.split(/\s+/).filter(Boolean);
		if (!verb) {
			const names = Object.keys(all).sort();
			if (names.length === 0) {
				this.say("no presets yet: /preset save <name> keeps what new sessions use now", "warning");
				return false;
			}
			this.openLayer({
				kind: "picker",
				picker: {
					title: "Preset for new sessions",
					items: [
						{ label: "none (the defaults)", value: "" },
						...names.map((n) => ({ label: `${n}  ${presetText(all[n]!)}`, value: n })),
					],
					index: Math.max(0, names.indexOf(this.preset?.name ?? "") + 1),
					pick: (v) => (v ? this.applyPreset(v, all[v]!) : this.clearPreset()),
				},
			});
			this.o.tui.requestRender();
			return true;
		}
		if (verb === "off" && !name) {
			if (!this.preset) {
				this.say("no preset in use");
				return true;
			}
			this.clearPreset();
			return true;
		}
		if (verb === "save" || verb === "rm") {
			if (!name || rest.length > 0) {
				this.say(`/preset ${verb} <name>`, "warning");
				return false;
			}
			if (!this.o.savePreset) {
				this.say("presets cannot be saved here", "warning");
				return false;
			}
			if (verb === "rm" && !(this.o.userPreset?.(name) ?? has(name))) {
				this.say(
					has(name) ? `${name} is a project's preset (its .pi/settings.json)` : `no preset ${name}`,
					"warning",
				);
				return false;
			}
			const p: Preset = {
				...(this.model ? { model: this.model } : {}),
				...(this.thinking ? { thinking: this.thinking } : {}),
				...(this.preset?.dir ? { dir: this.preset.dir } : {}),
			};
			// what would not read back (a model without its provider) is not saved
			if (verb === "save" && !samePreset(presetFrom(p), p)) {
				this.say(`these choices do not make a preset (a model needs provider/id)`, "warning");
				return false;
			}
			try {
				this.o.savePreset(name, verb === "save" ? p : null);
			} catch (err) {
				this.say((err as Error).message, "error");
				return false;
			}
			if (verb === "rm") {
				if (this.preset?.name === name) this.preset = undefined;
				const still = Object.hasOwn(this.o.presets?.() ?? {}, name);
				this.say(still ? `removed your preset ${name} (the project's ${name} stays)` : `removed preset ${name}`);
			} else {
				this.preset = { name, ...(p.dir ? { dir: p.dir } : {}) };
				this.say(`saved preset ${name}: ${presetText(p) || "the defaults"}`, "success");
			}
			return true;
		}
		if (name) {
			this.say("/preset <name>, off, save <name> or rm <name>", "warning");
			return false;
		}
		const p = has(verb) ? all[verb] : undefined;
		if (!p) {
			this.say(`no preset ${verb} (bare /preset lists them)`, "warning");
			return false;
		}
		this.applyPreset(verb, p);
		return true;
	}

	private applyPreset(name: string, p: Preset): void {
		// a preset is the whole choice: what it leaves out is the default (nothing from the last one stays)
		this.model = p.model;
		this.thinking = p.thinking;
		this.preset = { name, ...(p.dir ? { dir: p.dir } : {}) };
		const dir = this.presetDir();
		const missing = dir && "error" in dir ? ` · ${dir.error}` : "";
		this.say(`preset ${name}: ${presetText(p) || "nothing to change"}${missing}`, missing ? "warning" : "success");
	}

	private clearPreset(): void {
		this.preset = undefined;
		this.model = undefined;
		this.thinking = undefined;
		this.say("new sessions use the defaults");
	}

	/**
	 * M25: the marked rows on screen, in list order. A marked row in a folded group or
	 * filtered out stays marked but is not acted on: a batch never reaches what is not shown.
	 */
	private markedRows(): JobRow[] {
		if (this.marked.size === 0) return [];
		for (const id of this.marked) if (!this.rows.has(id)) this.marked.delete(id);
		return this.itemList().flatMap((it) => (it.kind === "row" && this.marked.has(it.row.id) ? [it.row] : []));
	}

	/** M25: Ctrl+O marks the row, or on a header the whole group (again: unmarks it). */
	private toggleMark(): void {
		const it = this.selected();
		if (!it) return;
		const ids = it.kind === "row" ? [it.row.id] : it.section.rows.map((r) => r.id);
		if (ids.length === 0) return;
		const unmark = ids.every((id) => this.marked.has(id));
		for (const id of ids) {
			if (unmark) this.marked.delete(id);
			else this.marked.add(id);
		}
		// a row moves on to the next one, so Ctrl+O Ctrl+O marks two
		if (it.kind === "row") this.move(1);
		const n = this.markedRows().length;
		this.say(
			n > 0
				? `${n} marked · type and Enter to send to all · Ctrl+X stop · Ctrl+T pin · Esc unmark`
				: "marks cleared",
		);
	}

	/** M25: the typed text to every marked session; /model and /thinking switch them all. */
	private async sendToMarked(mode: ReplyMode = "steer"): Promise<void> {
		if (this.sendingMarked) return;
		const rows = this.markedRows();
		const typed = this.input.getValue();
		const text = typed.trim();
		if (!this.port) return this.say("background service unavailable", "error");
		// a new task or a shell job is never sent as a reply by mistake: the input stays
		if (/^[!@]/.test(text))
			return this.say(
				"rows are marked: a typed text goes to them as a reply (Esc unmarks to start a task)",
				"warning",
			);
		const setting = /^\/(model|thinking)(?:\s+(.*))?$/.exec(text);
		if (setting) return this.markedSetting(rows, setting[1] as "model" | "thinking", (setting[2] ?? "").trim());
		if (text.startsWith("/") && this.isViewCommand(text.slice(1).split(/\s/)[0] ?? "")) {
			return this.say("only /model and /thinking act on marked sessions (Esc unmarks)", "warning");
		}
		// a shell command takes no replies
		const pi = rows.filter(takesReplies);
		if (pi.length === 0) return this.say("the marked rows are shell commands: nothing to send to", "warning");
		let sent = 0;
		let later = 0;
		const failed: string[] = [];
		// cleared first: a second Enter while sending has nothing to send
		this.sendingMarked = true;
		this.input.setValue("");
		try {
			for (const r of pi) {
				try {
					const res = await this.sends.reply({ id: r.id, text, mode }, { tag: "hub" });
					if (res.delivered || res.respawned || res.duplicate) sent++;
					else if (res.saved) later++;
					else failed.push(r.name);
				} catch (err) {
					failed.push(r.name);
					// M51: the service did not come back: the rest are not tried one by one
					if (!refusedByDaemon(err)) {
						failed.push(...pi.slice(pi.indexOf(r) + 1).map((x) => x.name));
						break;
					}
				}
			}
		} finally {
			this.sendingMarked = false;
		}
		// nothing reached anyone: the text comes back
		if (sent === 0 && later === 0 && !this.input.getValue()) this.input.setValue(typed);
		const parts = [
			`sent to ${sent} of ${pi.length} sessions${mode === "followUp" ? " (after their current work)" : ""}`,
		];
		if (later) parts.push(`${later} saved for their next start`);
		if (failed.length) parts.push(`not delivered: ${failed.map(oneLine).join(", ")}`);
		if (pi.length < rows.length) parts.push(`${rows.length - pi.length} shell commands skipped`);
		this.say(parts.join(" · "), failed.length ? "warning" : "success");
	}

	private markedSetting(rows: JobRow[], which: "model" | "thinking", arg: string): void {
		const pi = rows.filter((r) => r.kind !== "shell");
		if (pi.length === 0) {
			this.say("a shell command has no model", "warning");
			return;
		}
		const values: string[] = which === "model" ? (this.o.models?.() ?? []) : [...THINKING_LEVELS];
		const apply = async (v: string) => {
			let ok = 0;
			for (const r of pi) if (await this.sendSetting(r, which, v, true)) ok++;
			this.input.setValue("");
			this.say(`asked ${ok} of ${pi.length} sessions to use ${which} ${v}…`, ok === pi.length ? "muted" : "warning");
		};
		if (arg) {
			if (arg === "default") {
				this.say(`a running session has no default ${which}: pick one (bare /${which})`, "warning");
				return;
			}
			if (which === "model" && !arg.includes("/")) {
				this.say("use provider/id (bare /model lists them)", "warning");
				return;
			}
			if (values.length > 0 && !values.includes(arg)) {
				this.say(
					which === "model"
						? `unknown model ${arg} (bare /model lists them)`
						: `thinking is one of ${values.join(", ")}`,
					"warning",
				);
				return;
			}
			return void apply(arg);
		}
		if (values.length === 0) {
			this.say("no models available", "warning");
			return;
		}
		this.input.setValue("");
		const title = `${which === "model" ? "Model" : "Thinking"} for ${pi.length} marked sessions`;
		const same = new Set(pi.map((r) => (which === "model" ? r.model : r.thinking) ?? ""));
		const current = same.size === 1 ? [...same][0]! : "";
		if (which === "model") {
			this.modelPicker(title, current, false, apply);
			return;
		}
		this.openPicker(title, values, current, apply);
	}

	/** AV-K12: stop; again within 2 s delete; on a header, the whole group. */
	private async stopSelected(): Promise<void> {
		if (!this.port) return;
		const it = this.selected();
		const marked = this.peek ? [] : this.markedRows();
		if (!it && marked.length === 0) return;
		// M25: the marked rows, else the row, else the header's group
		const targets = marked.length > 0 ? marked : it!.kind === "row" ? [it!.row] : it!.section.rows;
		if (targets.length === 0) return;
		const key =
			marked.length > 0
				? `marked:${targets.map((r) => r.id).join(",")}`
				: it!.kind === "row"
					? it!.row.id
					: `group:${it!.section.key}:${targets.map((r) => r.id).join(",")}`;
		const now = Date.now();
		const armed = this.armedStop?.id === key && now - this.armedStop.at < DOUBLE_PRESS_MS;
		this.armedStop = { id: key, at: now };
		try {
			if (armed || targets.every((r) => r.pid === null)) {
				if (!armed) return this.say("Ctrl+X again to delete", "warning");
				for (const r of targets) await this.port.jobs.rm(r.id);
				this.armedStop = undefined;
				for (const r of targets) this.marked.delete(r.id);
				if (targets.length === 1) this.say(`deleted · ${targets[0]!.name}`);
				else this.say(`deleted ${targets.length} sessions`);
			} else {
				for (const r of targets) if (r.pid !== null) await this.port.jobs.stop(r.id);
				this.say(
					`stopping${targets.length > 1 ? ` ${targets.length} sessions` : ""} · Ctrl+X again to delete`,
					"warning",
				);
			}
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	private async attachSelected(): Promise<void> {
		const row = this.selectedRow();
		if (!row) return;
		try {
			await this.attachTo(row.id);
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/** AT-1/AT-2: hand the terminal to the job's PTY host, then repaint. */
	private async attachTo(id: string): Promise<void> {
		// M22: one attach at a time: a second one would share the terminal with the first,
		// and the first one's end would pause the input of the second
		if (this.attached) return;
		const row = this.rows.get(id);
		if (!row) return;
		if (row.pid === null) {
			if (!this.port) return this.say("background service unavailable", "error");
			// a reaped session just wakes up (AT-1); one that ended asks first (DM-7)
			const now = Date.now();
			if (!row.reaped && (this.restartAsk?.id !== id || now - this.restartAsk.at > RESTART_ASK_MS)) {
				this.restartAsk = { id, at: now };
				return this.say(
					row.kind === "shell"
						? `${row.name} has ended · Enter again to run the command again`
						: `${row.name} is ${row.state} · Enter again to start it`,
					"warning",
				);
			}
			this.restartAsk = undefined;
		}
		const { tui } = this.o;
		let reason: DetachReason;
		let failure: string | undefined;
		try {
			this.attached = true;
			// M14: leave the screen as it is (fullscreen xpi would print its transcript first)
			tui.stop({ preserveScreen: true });
			if (row.pid === null) await ensureLive(this.client!, row, process.stdout);
			reason = await attachToHost(
				hostSocketPath(id),
				{ stdin: process.stdin, stdout: process.stdout },
				{ isDetachKey: this.o.isDetachKey },
			);
		} catch (err) {
			reason = "error";
			failure = (err as Error).message;
		} finally {
			this.attached = false;
			tui.start();
			tui.requestRender(true);
			this.render0();
		}
		this.cursor = { kind: "row", id };
		if (failure) this.say(`could not start ${row.name}: ${oneLine(failure)}`, "error");
		else if (reason === "takeover") this.say("Attached elsewhere", "warning");
		else if (reason === "exit") this.say(`${row.name} ended`);
		else if (reason === "error" || reason === "closed") this.say(`lost the connection to ${row.name}`, "error");
	}

	// ---- render ----------------------------------------------------------

	invalidate(): void {}

	render(width: number): string[] {
		const lines = this.renderLines(width);
		if (!this.o.fullscreen) return lines;
		return fitScreen(lines, this.o.tui.terminal.rows || 30, this.selLine, this.bottomFrom, {
			selectedEnd: this.selEnd,
			keep: this.headLines,
		});
	}

	/**
	 * In render: the selected row's first and last line (with its peek and reply input),
	 * the first line of the bottom block (input, keys), and the fixed lines on top.
	 */
	private selLine = -1;
	private selEnd = -1;
	private bottomFrom = -1;
	private headLines = 2;

	private renderLines(width: number): string[] {
		const t = this.o.theme;
		const w = Math.max(1, width);
		this.selLine = -1;
		this.selEnd = -1;
		this.bottomFrom = -1;
		const now = Date.now();
		// the peeked row vanished (deleted, folded, collapsed): never reply to another one
		if (this.peek && !this.itemList().some((it) => it.kind === "row" && it.row.id === this.peekId)) this.closePeek();
		if (this.notice && now > this.notice.until) this.notice = undefined;
		const all = this.listedRows();
		const c = counts(all);
		const out: string[] = [];
		const short = (this.o.tui.terminal.rows || 30) < 18;

		// M24: what the sessions spent
		const spent = totalUsage([...this.rows.values()], now);
		const money = spent.cost > 0 ? ` · ${formatCost(spent.today)} today · ${formatCost(spent.cost)} all` : "";
		out.push(truncateToWidth(t.bold("xpi agents") + t.fg("dim", `  ${headerText(c)}${money}`), w));
		if (!short) out.push(t.fg("border", "─".repeat(w)));
		this.headLines = out.length;
		if (this.connectError)
			out.push(t.fg("error", truncateToWidth(`background service: ${oneLine(this.connectError)}`, w)));

		if (this.origin && this.o.banner) out.push(t.fg("accent", truncateToWidth(this.o.banner, w)));
		// M23: always says what a new session runs (Ctrl+L, Ctrl+P and Shift+Tab change it)
		const def = this.o.defaultModel?.();
		if (this.model || this.thinking || def || this.preset) {
			const model = this.model ? `model ${this.model}` : def ? `model ${def} (default)` : undefined;
			const pr = this.preset;
			const d = [
				pr && `preset ${pr.name}`,
				model,
				this.thinking && `thinking ${this.thinking}`,
				pr?.dir && `in @${pr.dir}`,
			]
				.filter(Boolean)
				.join(" · ");
			out.push(t.fg("dim", truncateToWidth(`new sessions: ${d}`, w)));
		}
		if (this.overlay) {
			const rows = this.o.tui.terminal.rows || 30;
			let body: string[];
			try {
				body = this.overlay.render(w);
			} catch (err) {
				this.closeOverlay();
				this.say(`the session list failed: ${oneLine((err as Error).message)}`, "error");
				body = [];
			}
			// its last lines (the keys) stay on screen
			if (body.length > rows - out.length)
				body = [...body.slice(0, Math.max(1, rows - out.length - 2)), ...body.slice(-2)];
			this.bottomFrom = out.length + body.length - 1;
			return [...out, ...body].map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
		}
		if (this.picker || this.help) {
			const rows = this.o.tui.terminal.rows || 30;
			const body = this.picker ? this.pickerLines(w, rows - out.length) : this.helpLines(w, rows - out.length);
			// its last line (how to leave) stays on screen
			this.bottomFrom = out.length + body.length - 1;
			return [...out, ...body].map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
		}

		const sections = this.sections();
		const list = items(sections);
		this.nameWidth = Math.max(
			1,
			Math.min(28, Math.floor(w / 3), Math.max(8, ...all.map((r) => visibleWidth(oneLine(r.name))))),
		);
		this.columns = this.columnsFor(all, Math.max(1, w - 2), now);
		const sel = this.selectedIndex(list);
		const empty = all.length === 0;
		list.forEach((it, i) => {
			const isSel = i === sel;
			if (it.kind === "header") {
				const s = it.section;
				const label = `${s.collapsed ? "▸" : "▾"} ${s.title}${s.rows.length || s.hidden ? ` (${s.rows.length + s.hidden})` : ""}`;
				const hint = empty ? t.fg("dim", `  ${s.hint}`) : "";
				if (isSel) this.selLine = out.length;
				const all = s.rows.length > 0 && s.rows.every((r) => this.marked.has(r.id));
				out.push(this.mark(isSel, truncateToWidth(t.bold(label) + hint, Math.max(1, w - 2)), all));
				return;
			}
			if (isSel) this.selLine = out.length;
			out.push(
				truncateToWidth(
					this.mark(isSel, this.rowLine(it.row, Math.max(1, w - 2), now), this.marked.has(it.row.id)),
					w,
				),
			);
			// the peek belongs right under its row, before the section's "… N more"
			if (isSel && this.peek) out.push(...this.peekLines(it.row, w, now));
			if (isSel) this.selEnd = out.length - 1;
			const lastOfSection = list[i + 1]?.kind !== "row" || list[i + 1]?.section !== it.section;
			if (lastOfSection && it.section.hidden > 0)
				out.push(truncateToWidth(`  ${t.fg("dim", `… ${it.section.hidden} more`)}`, w));
		});

		// a peek's lines belong with its row; the input and keys stay at the bottom
		if (this.selEnd === -1) this.selEnd = this.selLine;
		out.push("");
		this.bottomFrom = out.length;
		if (this.renaming) out.push(...this.renameInput.render(w));
		else if (!this.peek) {
			out.push(...this.input.render(w));
			const at = atPrefix(this.input.getValue());
			if (at !== undefined) {
				const s = this.atSuggestions(at);
				out.push(
					t.fg(
						"dim",
						truncateToWidth(
							s.length
								? `Tab: ${s
										.slice(0, 6)
										.map((d) => `@${d}`)
										.join("  ")}`
								: "no matching directory",
							w,
						),
					),
				);
			}
		}
		const f = this.filter();
		if (f && !list.some((it) => it.kind === "row")) out.push(t.fg("dim", truncateToWidth("no sessions match", w)));
		if (this.notice) out.push(t.fg(this.notice.tone, truncateToWidth(oneLine(this.notice.text), w)));
		out.push(t.fg("dim", truncateToWidth(this.footer(), w)));
		// xpi-tui refuses (and crashes on) lines wider than the terminal
		return out.map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
	}

	private mark(selected: boolean, line: string, checked = false): string {
		const t = this.o.theme;
		// M25: a marked row has a check in the second column
		return `${selected ? t.fg("accent", "›") : " "}${checked ? t.fg("success", "✓") : " "}${line}`;
	}

	private rowLine(row: JobRow, width: number, now: number): string {
		const t = this.o.theme;
		const icon = iconOf(row, this.frame, !this.o.reducedMotion);
		const age = ageOf(row, now);
		const name = truncateToWidth(oneLine(row.name), this.nameWidth);
		const pad = " ".repeat(Math.max(0, this.nameWidth - visibleWidth(name)));
		const styled =
			row.id === this.o.highlightId ? t.bold(t.fg(nameToneOf(row.id), name)) : t.fg(nameToneOf(row.id), name);
		const head = `${t.fg(icon.tone, icon.glyph)} ${styled}${pad}  `;
		const detail = this.detailText(row);
		const ageCol = t.fg("dim", age.padStart(this.columns.ageW));
		// M24: what it spent (dim when billed to a subscription: notional)
		const cw = this.columns.costW;
		const costText = cw > 0 && row.usage && row.usage.cost > 0 ? formatCost(row.usage.cost) : "";
		const costCol = cw > 0 ? `${t.fg(row.usage?.sub ? "dim" : "muted", costText.padStart(cw))}  ` : "";
		const tail = `${detail ? `${detail}  ` : ""}${costCol}${ageCol}`;
		const room = width - visibleWidth(head) - visibleWidth(tail) - 2;
		const summary =
			room > 4 ? t.fg(row.pid === null ? "dim" : "muted", truncateToWidth(oneLine(sentenceOf(row)), room)) : "";
		const gap = Math.max(1, width - visibleWidth(head) - visibleWidth(summary) - visibleWidth(tail));
		return `${head}${summary}${" ".repeat(gap)}${tail}`;
	}

	/**
	 * M8: how much of the model / context column fits. The summary keeps MIN_SUMMARY
	 * columns: on a narrow terminal the column shrinks to the share, then goes.
	 */
	private columnsFor(rows: JobRow[], width: number, now: number): Columns {
		const ageW = Math.max(0, ...rows.map((r) => ageOf(r, now).length));
		const none: Columns = { mode: "none", modelW: 0, shareW: 0, ageW, costW: 0 };
		if (this.o.rowDetails === false) return none;
		const base = this.layoutColumns(rows, width, ageW, 0);
		// M24: what each session spent, when that still leaves the summary its room
		const costW = Math.max(
			0,
			...rows.map((r) => (r.usage && r.usage.cost > 0 ? formatCost(r.usage.cost).length : 0)),
		);
		if (costW > 0) {
			const withCost = this.layoutColumns(rows, width, ageW, costW + 2);
			if (withCost.mode === base.mode && withCost.costW === 0) return { ...withCost, costW };
		}
		return base;
	}

	private layoutColumns(rows: JobRow[], width: number, ageW: number, extra: number): Columns {
		const none: Columns = { mode: "none", modelW: 0, shareW: 0, ageW, costW: 0 };
		const ds = rows.map(rowDetailsOf).filter((d): d is NonNullable<typeof d> => d !== null);
		const modelW = Math.min(MODEL_COL, Math.max(0, ...ds.map((d) => (d.model ? visibleWidth(oneLine(d.model)) : 0))));
		const shareW = Math.max(0, ...ds.map((d) => d.context?.length ?? 0));
		// what the summary keeps: the row minus icon, name, the column, the age and the gaps
		const room = (col: number) => width - (2 + this.nameWidth + 2) - col - 2 - ageW - 2 - extra;
		const full = modelW + (modelW && shareW ? 3 : 0) + shareW;
		if (full > 0 && room(full) >= MIN_SUMMARY) return { mode: "full", modelW, shareW, ageW, costW: 0 };
		if (shareW > 0 && room(shareW) >= MIN_SUMMARY) return { mode: "share", modelW: 0, shareW, ageW, costW: 0 };
		// M24: no room even for `extra` alone: say so (the cost column is left out)
		return extra > 0 && room(0) < MIN_SUMMARY ? { ...none, costW: -1 } : none;
	}

	/** M8: "claude-opus-5-5 · 43%", padded to the column (blank for a row without them). */
	private detailText(row: JobRow): string {
		const c = this.columns;
		if (c.mode === "none") return "";
		const t = this.o.theme;
		const d = rowDetailsOf(row);
		const share = d?.context ? t.fg(d.tone, d.context.padStart(c.shareW)) : " ".repeat(c.shareW);
		if (c.mode === "share") return share;
		const raw = d?.model ? fitTail(oneLine(d.model), c.modelW) : "";
		// right-aligned as a block: the shares line up, the model sits next to its share
		const lead = (w: number) => " ".repeat(Math.max(0, c.modelW - w));
		if (c.shareW === 0) return lead(visibleWidth(raw)) + t.fg("dim", raw);
		if (c.modelW === 0) return share;
		if (!raw) return `${lead(0)}   ${share}`;
		return `${lead(visibleWidth(raw))}${t.fg("dim", raw)}${t.fg("dim", d?.context ? " · " : "   ")}${share}`;
	}

	/** PK-1: the full sentence, choices, waiting time, and the reply input. */
	private peekLines(row: JobRow, width: number, now: number): string[] {
		const t = this.o.theme;
		const inner = Math.max(1, width - 4);
		const lines: string[] = [];
		const blocked = row.state === "blocked";
		// what it asks, said last, or failed with: first, whole (a failed row's error is not cut short)
		const sentence = sentenceOf(row).replace(CONTROL, " ");
		for (const chunk of wrap(sentence, inner))
			lines.push(`    ${row.state === "failed" ? t.fg("error", chunk) : chunk}`);
		row.choices.forEach((c, i) => {
			lines.push(`    ${t.fg("accent", `${i + 1}.`)} ${truncateToWidth(oneLine(c), Math.max(1, inner - 4))}`);
		});
		// M48: the task it was started on; where; since when
		if (row.task) lines.push(`    ${t.fg("dim", truncateToWidth(`task: ${oneLine(row.task)}`, inner))}`);
		const when = row.endedAt
			? `${row.state} ${formatDuration(now - row.endedAt)} ago · took ${formatDuration(row.endedAt - row.startedAt)}`
			: `started ${formatDuration(now - row.startedAt)} ago`;
		lines.push(`    ${t.fg("dim", truncateToWidth(`${tildeDir(row.cwd)} · ${when}`, inner))}`);
		// a blocked row's status is always "waiting": say it once, with how long
		const facts: string[] = [
			blocked
				? `needs input · waiting ${formatDuration(now - row.stateSince)}`
				: row.state + (row.status ? ` · ${row.status}` : ""),
		];
		if (row.queued) facts.push(`${row.queued} ${row.queued === 1 ? "reply" : "replies"} queued`);
		facts.push(row.id);
		lines.push(`    ${t.fg("dim", truncateToWidth(facts.join(" · "), inner))}`);
		// M8: model, thinking and context window on a line of their own; M48: what it cost
		const model = modelFacts(row);
		const u = row.usage;
		if (u && u.cost > 0)
			model.push(
				`${u.cost < 0.01 ? "<$0.01" : `$${u.cost.toFixed(2)}`}${u.sub ? " (sub)" : ""} · ${kTokens(u.input + u.output + u.cacheRead + u.cacheWrite)} tokens`,
			);
		if (model.length > 0) {
			const tone = row.context ? (rowDetailsOf(row)?.tone ?? "dim") : "dim";
			lines.push(`    ${t.fg(tone, truncateToWidth(model.join(" · "), inner))}`);
		}
		if (row.waitingFor === "dialog")
			lines.push(`    ${t.fg("warning", "a dialog is open: attach (→) to answer it; replies wait for it")}`);
		// M48: the last things it said and did (a shell command: its screen), live while the peek is open
		for (const l of this.tailLines(row, inner, now)) lines.push(`    ${l}`);
		// M48: the box says what Enter does for a session in this state
		this.reply.setPlaceholder(
			blocked
				? "answer · Enter sends · 1-9 picks a choice · / commands"
				: row.state === "failed"
					? "Enter sends your text · /continue picks it up where it left off · / commands"
					: row.state === "working"
						? "reply · Enter joins its work · Alt+Enter after it · / commands"
						: "reply · Enter sends (a session that ended starts again) · / commands",
		);
		for (const l of this.reply.render(inner)) lines.push(`    ${l}`);
		return lines;
	}

	/**
	 * M48: the tail of its transcript (or its screen): raw lines cached per row, the file looked at
	 * (its size and mtime) every 2 s at most and read only when it changed; cut to the width at render.
	 */
	private tails = new Map<string, { at: number; key: string; items: TailItem[] }>();
	private tailLines(row: JobRow, inner: number, now: number): string[] {
		const t = this.o.theme;
		const max = Math.max(3, Math.min(12, Math.floor((this.o.tui.terminal.rows || 30) / 4)));
		let cached = this.tails.get(row.id);
		if (!cached || now - cached.at >= 2000) {
			const screen = row.kind === "shell" || !row.sessionFile;
			const file = screen ? screenPath(row.id) : row.sessionFile;
			let key = "";
			try {
				const st = statSync(file);
				key = `${file}:${st.size}:${st.mtimeMs}`;
				if (cached && cached.key === key) cached.at = now;
				else {
					const items: TailItem[] = [];
					if (screen) {
						for (const l of readFileSync(file, "utf8").trimEnd().split("\n"))
							if (l.trim()) items.push({ kind: "screen", text: oneLine(l) });
					} else {
						// the last part is enough for a few lines (the overlay reads more)
						const tail = readTail(file, TAIL_READ_MAX);
						for (const it of transcriptItems(tail.text, tail.truncated)) {
							if (it.kind === "user") items.push({ kind: "you", text: oneLine(it.text) });
							else if (it.kind === "assistant") items.push({ kind: "said", text: oneLine(it.text) });
							else if (it.kind === "tool")
								items.push({
									kind: "tool",
									text: oneLine(`${it.name}${it.args ? ` ${it.args}` : ""}`),
									error: it.error === true,
								});
							else items.push({ kind: "note", text: oneLine(it.text) });
						}
					}
					cached = { at: now, key, items: items.slice(-40) };
					this.tails.set(row.id, cached);
				}
			} catch {
				// nothing written yet (a session file xpi has not created, no screen kept)
				cached = { at: now, key, items: [] };
				this.tails.set(row.id, cached);
			}
		}
		return cached.items.slice(-max).map((it) => {
			const line = truncateToWidth(
				it.kind === "you"
					? `you: ${it.text}`
					: it.kind === "said"
						? `› ${it.text}`
						: it.kind === "tool"
							? `⚙ ${it.text}`
							: it.kind === "note"
								? `· ${it.text}`
								: it.text,
				inner,
			);
			if (it.kind === "said") return line;
			return t.fg(
				it.kind === "you"
					? "accent"
					: it.kind === "tool" && it.error
						? "error"
						: it.kind === "note"
							? "dim"
							: "muted",
				line,
			);
		});
	}

	private footer(): string {
		if (this.renaming) return "Enter rename · Esc cancel";
		if (this.origin) return "Esc/Enter back to your conversation · ↑↓ select · Space peek · ? keys";
		if (this.filter()) return "filtering (s: n: o:) · Enter/→ attach · Esc clear";
		if (this.peek) return "Enter send · Alt+Enter after work · 1-9 pick · / commands · Esc close · ? keys";
		const n = this.markedRows().length;
		if (n > 0)
			return `${n} marked · type, Enter: send to all · /model /thinking · Ctrl+T pin · Ctrl+X stop · Ctrl+O mark · Esc unmark`;
		return "↑↓ select · Enter/→ attach · Space peek · Ctrl+Enter start+attach · Ctrl+X stop · ? keys · Esc exit";
	}

	/** `room`: the lines left under the header. */
	private pickerLines(width: number, room: number): string[] {
		const t = this.o.theme;
		const p = this.picker!;
		const shown = pickerShown(p);
		const height = Math.max(1, Math.min(Math.max(1, shown.length), room - 5));
		const start = Math.max(0, Math.min(p.index - Math.floor(height / 2), shown.length - height));
		const title = p.scope ? `${p.title} · ${p.scope}` : p.title;
		const lines = [
			t.bold(truncateToWidth(title, width)),
			truncateToWidth(`${t.fg("dim", "search: ")}${p.query ?? ""}▏`, width),
			"",
		];
		if (shown.length === 0) lines.push(t.fg("dim", "  nothing matches"));
		shown.slice(start, start + height).forEach((it, i) => {
			const sel = start + i === p.index;
			lines.push(this.mark(sel, truncateToWidth(sel ? t.fg("accent", it.label) : it.label, Math.max(1, width - 2))));
		});
		const keys = `type to search · ↑↓ choose · Enter pick${p.other ? ` · Tab ${p.other.label}` : ""} · Esc ${p.query ? "clear" : "cancel"}`;
		lines.push("", t.fg("dim", truncateToWidth(keys, width)));
		return lines;
	}

	/** `room`: the lines left under the header; two columns when one does not fit. */
	private helpLines(width: number, room: number): string[] {
		const t = this.o.theme;
		const detach = this.o.detachKeyName ?? "app.suspend";
		const keys: [string, string][] = [
			["↑ ↓ PgUp PgDn Home End", "move"],
			["Enter", "attach · start the typed task · fold a group"],
			["→", "attach"],
			["Space", "peek and reply"],
			["Ctrl+Enter", "start the typed task and attach"],
			["Ctrl+X", "stop; again within 2 s to delete (on a header: the group)"],
			["Ctrl+S", "group by state / directory"],
			["Ctrl+T", "pin / unpin (pinned sessions keep running)"],
			["Ctrl+O", "mark the row (on a header: the group) for a batch"],
			["marked: type, Enter", "send it to every marked session (/model, /thinking too)"],
			["in a peek: Alt+Enter", "send after its current work (Enter: joins it, as in xpi)"],
			[
				"in a peek: /…",
				"that session: /stop /respawn /rm /pin /rename /attach /model /thinking /name /compact /continue /log /transcript",
			],
			["Tab · /", "complete: / the commands, @ paths (xpi's menu: ↑↓ choose, Enter or Tab take)"],
			["Ctrl+G · Ctrl+J", "edit the task or reply in $VISUAL · a new line"],
			["marked: Ctrl+X Ctrl+T", "stop / delete, pin / unpin all of them"],
			["Ctrl+R", "rename"],
			["Shift+↑ Shift+↓", "move the row within its group"],
			["Alt+↑ Alt+↓", "previous / next group"],
			["Alt+1…9", "attach to row N of this directory"],
			["Ctrl+F", "find by name (n:)"],
			["Ctrl+G", "write the task in $VISUAL / $EDITOR"],
			["s: n: o:", "filter by state, name, result; combine with spaces"],
			["@dir task", "start the task in that directory (Tab completes)"],
			["! command", "run a shell command as a session"],
			["/model /thinking", "defaults for new sessions (bare: pick; default resets)"],
			["Ctrl+L", "pick the model for new sessions (in a peek: for that session)"],
			["Ctrl+P Shift+Ctrl+P", "next / previous enabled model for new sessions"],
			["Shift+Tab", "next thinking level for new sessions"],
			["in a peek: /model", "switch that session's model (/thinking: its level)"],
			["/resume", "open a past session (search; Tab: this directory or all)"],
			["/usage", "what the sessions spent: today, all, by model, by session"],
			["/log", "what happened lately: starts, questions, results, replies (newest first)"],
			["/preset [name]", "saved choices for new sessions (save <name>, rm <name>, off)"],
			["Esc", "close peek · clear input · unmark · exit"],
			["Ctrl+C", "clear input; twice to exit"],
			["in a session", `← on an empty prompt, /exit or ${detach} detaches`],
		];
		const line = (k: string, v: string, w: number) => truncateToWidth(`  ${t.fg("accent", k.padEnd(24))}${v}`, w);
		let body = keys.map(([k, v]) => line(k, v, width));
		if (keys.length + 3 > room && width >= 70) {
			const half = Math.ceil(keys.length / 2);
			const col = Math.floor(width / 2);
			body = keys.slice(0, half).map(([k, v], i) => {
				const left = line(k, v, col - 1);
				const right = keys[half + i];
				return right
					? left + " ".repeat(Math.max(1, col - visibleWidth(left))) + line(right[0], right[1], width - col)
					: left;
			});
		}
		return ["", ...body, "", t.fg("dim", "any key to close")];
	}
}

/** Whether a preset reads back as written (key order aside). */
function samePreset(a: Preset | undefined, b: Preset): boolean {
	const norm = (p: Preset) =>
		JSON.stringify(Object.fromEntries(Object.entries(p).sort(([x], [y]) => x.localeCompare(y))));
	return !!a && norm(a) === norm(b);
}

/** M27: what a preset sets, short. */
export function presetText(p: Preset): string {
	return [p.model && shortModel(p.model), p.thinking && `thinking ${p.thinking}`, p.dir && `@${p.dir}`]
		.filter(Boolean)
		.join(" · ");
}

/**
 * Full screen: exactly `rows` lines. The bottom block (input, notices, keys) is pinned
 * to the last lines; the first `keep` lines (title, rule) stay; the rest scrolls so the
 * selection — `selected` to `selectedEnd`, a row with its peek — is visible, its end
 * (the reply input) first. Lines from `bottom` on are the bottom block (-1: none).
 */
export function fitScreen(
	lines: string[],
	rows: number,
	selected: number,
	bottom: number,
	opts: { selectedEnd?: number; keep?: number } = {},
): string[] {
	const height = Math.max(1, rows);
	const top = bottom === -1 ? lines : lines.slice(0, bottom);
	const foot = bottom === -1 ? [] : lines.slice(bottom).slice(-height);
	const room = height - foot.length;
	let body = top;
	if (top.length > room) {
		// a tiny screen gives up the title before the selection
		const keep = Math.max(0, Math.min(opts.keep ?? 2, room - 1));
		const rest = room - keep;
		const lo = Math.max(keep, Math.min(selected, top.length - 1));
		const hi = Math.max(lo, Math.min(opts.selectedEnd ?? lo, top.length - 1));
		let start = Math.min(hi - rest + 1 + Math.floor(rest / 3), lo); // some context after, the start shown
		start = Math.max(start, hi - rest + 1); // but never losing the end
		start = Math.max(keep, Math.min(start, top.length - rest));
		body = [...top.slice(0, keep), ...top.slice(start, start + rest)];
	}
	return [...body, ...Array(Math.max(0, room - body.length)).fill(""), ...foot].slice(0, height);
}

/** M48: a directory with the home as `~` (the peek's "where"). */
function tildeDir(dir: string): string {
	const home = process.env.HOME;
	if (!home) return dir;
	return dir === home ? "~" : dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

/** M48: xpi's path completion uses fd when it is on the PATH (fuzzy, .gitignore kept); found once. */
let fdPathCache: string | null | undefined;
function fdOnPath(): string | null {
	if (fdPathCache !== undefined) return fdPathCache;
	fdPathCache = null;
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		for (const name of ["fd", "fdfind"]) {
			const p = join(dir, name);
			if (existsSync(p)) {
				fdPathCache = p;
				return p;
			}
		}
	}
	return fdPathCache;
}

/** M48: a token count in short (`34k`, `1.2M`). */
function kTokens(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Put text in an input with the cursor after it (setValue leaves the cursor where it was). */
function fill(input: { setValue(v: string): void; handleInput(d: string): void }, value: string): void {
	input.setValue("");
	// typed in, so the cursor ends after it whatever the user's key bindings
	for (const ch of value.replace(CONTROL, " ")) input.handleInput(ch);
}

function formatAgo(ms: number): string {
	const m = Math.round(ms / 60_000);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function within(dir: string, root: string): boolean {
	return dir === root || dir.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** M51: the daemon refused it (an answer came): not `lost` (sent, no answer: it may have been taken) or `closed`. */
function refusedByDaemon(err: unknown): boolean {
	return err instanceof DaemonError && typeof err.code === "string" && err.code !== "closed" && err.code !== "lost";
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
