// The subagent screen (v2 spec, "TUI: Subagent screen"): a full-terminal overlay that shows one subagent's session with
// pi's own message components. It is a view only: it never touches the main session (no switchSession), so main keeps
// running underneath.
//
// Two sources. The finished part of the transcript comes from the child's session file, read when the screen opens and
// again when the running child reports an event that can have changed it (never on a timer). The assistant message
// the running child is writing right now comes from its rpc event stream through the registry, drawn token by token.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AssistantMessageComponent,
  buildSessionContext,
  type ExtensionContext,
  getMarkdownTheme,
  parseSessionEntries,
  type SessionEntry,
  type Theme,
  type ToolRenderers,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, matchesKey, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { parentContext } from "./agent-tool.ts";
import { tint } from "./color.ts";
import { COLORS, ICONS, label, modelInfo, registry, type SubagentRecord } from "./registry.ts";
import type { ParentContext } from "./resolve.ts";
import { talkTo } from "./talk.ts";

const PAD = 1;

// The child's session file: `<ts>_<agentId>.jsonl` in the record's session dir.
export function sessionFileOf(r: SubagentRecord): string | undefined {
  if (!r.sessionDir || !existsSync(r.sessionDir)) return undefined;
  const name = readdirSync(r.sessionDir).find((f) => f.endsWith(`_${r.id}.jsonl`));
  return name && join(r.sessionDir, name);
}

// A call is drawn as its name and its arguments. A codemode script is shown alone as code, line by line; other strings
// are shown as they are (a multi-line one starts on its own line). Pi's default prints the script as one JSON line, and
// its own renderers for the registered tools are not reachable from an extension.
const callRenderers = (name: string): ToolRenderers => ({
  renderCall: (args: unknown, theme: Theme) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const fields =
      name === "codemode" && typeof a.code === "string"
        ? [a.code]
        : Object.entries(a).map(([k, v]) => {
            const text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
            return text.includes("\n") ? `${k}:\n${text}` : `${k}: ${text}`;
          });
    return new Text([theme.fg("toolTitle", theme.bold(name)), ...fields.map((f) => theme.fg("muted", f))].join("\n"), 0, 0);
  },
});

// One tool row for a call of an assistant message, shown in full: the point of this screen is to read scripts and outputs.
function toolRow(c: { id: string; name: string; arguments: unknown }, tui: TUI, cwd: string): ToolExecutionComponent {
  const row = new ToolExecutionComponent(c.name, c.id, c.arguments, { outputPad: PAD }, callRenderers(c.name), tui, cwd);
  row.setExpanded(true);
  row.markExecutionStarted();
  return row;
}

// The transcript as pi draws a session: user and assistant messages, one tool row per call with its result.
export function transcriptParts(file: string, tui: TUI, cwd: string): Component[] {
  const entries = parseSessionEntries(readFileSync(file, "utf8")).filter((e) => e.type !== "session") as SessionEntry[];
  const md = getMarkdownTheme();
  const parts: Component[] = [];
  const pending = new Map<string, ToolExecutionComponent>();
  for (const m of buildSessionContext(entries).messages as any[]) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      if (text) parts.push(new UserMessageComponent(text, md, PAD));
    } else if (m.role === "assistant") {
      parts.push(new AssistantMessageComponent(m, false, md, undefined, PAD));
      for (const c of m.content) {
        if (c.type !== "toolCall") continue;
        const row = toolRow(c, tui, cwd);
        pending.set(c.id, row);
        parts.push(row);
      }
    } else if (m.role === "toolResult") {
      pending.get(m.toolCallId)?.updateResult(m);
    }
  }
  return parts;
}

export class SubagentScreen implements Component, Focusable {
  private input = new Input();
  private offset = 0; // lines scrolled up from the bottom; 0 follows the live end
  private notice = "";
  private picking: { options: string[]; at: number } | undefined; // the open /model list

  // The finished transcript, from the session file.
  private historyParts: Component[] = [];
  private history: string[] = [];
  private historyWidth = -1;
  private historyDirty = true; // the file may have changed since it was read
  private historySignature = "";
  private file: string | undefined;

  // The message being written, from the event stream.
  private live: { lines: string[]; width: number; version: number } | undefined;
  private liveRows = new Map<string, ToolExecutionComponent>();
  private liveMessage = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), undefined, PAD);

  private status: string;
  private stopWatching: () => void;
  private unsubscribe: () => void;

  private tui: TUI;
  private theme: Theme;
  private id: string;
  private mainIdle: () => boolean;
  private parent: ParentContext;
  private done: () => void;
  private listModels: (() => string[]) | undefined;

  // `listModels` gives the "provider/id" names /model can pick from. The picker is drawn on the screen itself: a dialog
  // from ctx.ui.select would sit under this overlay.
  constructor(tui: TUI, theme: Theme, id: string, mainIdle: () => boolean, parent: ParentContext, done: () => void, listModels?: () => string[]) {
    this.tui = tui;
    this.theme = theme;
    this.id = id;
    this.mainIdle = mainIdle;
    this.parent = parent;
    this.done = done;
    this.listModels = listModels;
    this.status = registry.get(id)!.status;
    // Only deltas leave the file as it was; any other event can have appended to it.
    this.stopWatching = registry.watch(id, (event) => {
      if (event.type !== "message_update") this.historyDirty = true;
      this.tui.requestRender();
    });
    this.unsubscribe = registry.subscribe(() => {
      const status = registry.get(this.id)!.status;
      if (status !== this.status) {
        this.status = status;
        this.historyDirty = true; // a run began or ended: its first and last entries are in the file
      }
      this.tui.requestRender();
    });
    this.input.onSubmit = (text) => this.submit(text.trim());
  }

  get focused(): boolean {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }

  private submit(text: string): void {
    this.input.setValue("");
    if (text === "/main") return this.done();
    const command = text.split(/\s/)[0]!;
    const arg = text.slice(command.length).trim();
    if (command === "/stop") this.stop();
    else if (command === "/model") void this.model(arg);
    else if (text.startsWith("/")) this.notice = `${command} is not available on a subagent screen (/main goes back)`;
    else if (text) this.say(text);
  }

  private stop(): void {
    this.notice = registry.stop(this.id) ? "stopping..." : "the subagent is not running";
    this.tui.requestRender();
  }

  // `/model` picks from the available models; `/model provider/id` names one. Applied now if the subagent runs, and
  // used by its later exchanges. The agent file is not touched.
  private async model(arg: string): Promise<void> {
    const available = this.listModels?.() ?? [];
    if (!arg) {
      if (available.length === 0) this.notice = "no model list available";
      else this.picking = { options: available, at: Math.max(0, available.indexOf(registry.get(this.id)!.model)) };
    } else if (!available.includes(arg)) this.notice = `unknown model ${arg}`;
    else {
      const error = await registry.setModel(this.id, arg);
      this.notice = error === undefined ? `model: ${arg}` : `could not switch to ${arg}: ${error}`;
    }
    this.tui.requestRender();
  }

  // Steer the subagent, or continue it; the reply streams in as the child writes it.
  private say(text: string): void {
    try {
      const { delivery, done } = talkTo(this.parent, this.id, text);
      this.notice = { steered: "sent: the subagent gets it after its current step", queued: "queued: sent when the subagent is free", started: "" }[delivery];
      done.catch((err) => this.fail(err));
    } catch (err) {
      this.fail(err);
    }
    this.tui.requestRender();
  }

  private fail(err: unknown): void {
    this.notice = `could not send: ${(err as Error).message}`;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const page = Math.max(1, this.tui.terminal.rows - 6);
    this.notice = "";
    if (this.picking) {
      const p = this.picking;
      if (matchesKey(data, "up")) p.at = Math.max(0, p.at - 1);
      else if (matchesKey(data, "down")) p.at = Math.min(p.options.length - 1, p.at + 1);
      else if (matchesKey(data, "enter")) {
        this.picking = undefined;
        void this.model(p.options[p.at]!);
      } else if (matchesKey(data, "escape")) this.picking = undefined;
      return this.tui.requestRender();
    }
    if (matchesKey(data, "escape")) return this.done();
    if (matchesKey(data, "pageUp")) this.offset += page;
    else if (matchesKey(data, "pageDown")) this.offset = Math.max(0, this.offset - page);
    else if (matchesKey(data, "up")) this.offset += 1;
    else if (matchesKey(data, "down")) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, "home")) this.offset = Number.MAX_SAFE_INTEGER;
    else if (matchesKey(data, "end")) this.offset = 0;
    else this.input.handleInput(data);
    this.tui.requestRender();
  }

  // The finished transcript: re-read the session file when something may have appended to it (a torn last line is
  // skipped by the parser), and redraw its lines when it or the width changed.
  private finished(width: number): string[] {
    if (this.historyDirty) {
      this.file ??= sessionFileOf(registry.get(this.id)!);
      // Without a file (a run that has not written it yet) stay dirty: the next event looks again.
      this.historyDirty = this.file === undefined;
      if (this.file) {
        const st = statSync(this.file);
        const signature = `${st.size}:${st.mtimeMs}`;
        if (signature !== this.historySignature) {
          this.historySignature = signature;
          this.historyParts = transcriptParts(this.file, this.tui, this.parent.cwd);
          this.historyWidth = -1;
        }
      }
    }
    if (this.historyWidth !== width) {
      this.history = this.historyParts.flatMap((p) => ["", ...p.render(width)]);
      this.historyWidth = width;
    }
    return this.history;
  }

  // The message the child is writing now, drawn from the deltas so far: text and thinking as they stream, a tool call
  // once its arguments are complete.
  private streaming(width: number): string[] {
    const message = registry.streaming(this.id);
    if (!message) {
      this.live = undefined;
      this.liveRows.clear();
      return [];
    }
    if (this.live?.version === message.version && this.live.width === width) return this.live.lines;
    const content = message.content.filter(Boolean);
    this.liveMessage.updateContent({ role: "assistant", content, stopReason: "pending" } as any, true);
    const parts: Component[] = [this.liveMessage];
    for (const c of content) {
      if (c.type !== "toolCall") continue;
      let row = this.liveRows.get(c.id);
      if (!row) this.liveRows.set(c.id, (row = toolRow(c, this.tui, this.parent.cwd)));
      parts.push(row);
    }
    const lines = parts.flatMap((p) => ["", ...p.render(width)]);
    this.live = { lines, width, version: message.version };
    return lines;
  }

  render(width: number): string[] {
    const t = this.theme;
    const rows = this.tui.terminal.rows;
    const r = registry.get(this.id)!;
    const all = [...this.finished(width), ...this.streaming(width)];
    const main = this.mainIdle() ? t.fg("muted", "main: idle") : t.fg("accent", "main: running");
    const sub = `${ICONS[r.status]} ${r.status} · ${r.turns} turns`;
    const head = truncateToWidth(` ${t.fg("accent", "‹ main")} ${t.fg("dim", "(esc or /main)")} ${t.fg("muted", "·  main ›")} ${tint(r.color, t.bold(label(r)))}   ${main} · ${t.fg(COLORS[r.status], sub)}${modelInfo(r) && ` · ${t.fg("dim", modelInfo(r))}`}`, width);
    const rule = t.fg("dim", "─".repeat(width));

    const height = Math.max(1, rows - 5);
    this.offset = Math.min(this.offset, Math.max(0, all.length - height));
    const end = all.length - this.offset;
    const body = all.slice(Math.max(0, end - height), end).map((l) => truncateToWidth(l, width));
    while (body.length < height) body.push("");
    if (this.picking) {
      const { options, at } = this.picking;
      const first = Math.max(0, Math.min(at - Math.floor(height / 2), options.length - (height - 1)));
      const shown = options.slice(first, first + height - 1).map((o, i) => (first + i === at ? t.fg("accent", `▸ ${o}`) : `  ${o}`));
      body.splice(0, body.length, t.fg("muted", ` Model for ${r.type}`), ...shown.map((l) => ` ${l}`));
      while (body.length < height) body.push("");
    }
    const scrolled = this.offset > 0 ? ` · ${this.offset} lines above the end` : "";
    const hint = this.picking ? "↑↓ choose · enter apply · esc cancel" : this.notice || `↑↓ pgup/pgdn scroll${scrolled} · /stop /model · esc or /main back to main`;
    return [head, rule, ...body, rule, ...this.input.render(width), t.fg("dim", truncateToWidth(` ${hint}`, width))].slice(0, rows);
  }

  invalidate(): void {
    this.historyWidth = -1;
    this.live = undefined;
  }

  dispose(): void {
    this.stopWatching();
    this.unsubscribe();
  }
}

let current: Promise<void> | undefined;

// Show the subagent's screen over the terminal. Resolves when the user leaves. One screen at a time. `ctx` is read
// again whenever the screen needs main's state or the model list, so it is never an older context.
export function openSubagentScreen(ctx: () => ExtensionContext, r: SubagentRecord): Promise<void> {
  if (current) return current;
  current = ctx()
    .ui.custom<void>(
      (tui, theme, _kb, done) =>
        new SubagentScreen(tui, theme, r.id, () => ctx().isIdle(), parentContext(ctx()), () => done(), () =>
          ctx().modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`),
        ),
      { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } },
    )
    .finally(() => (current = undefined));
  return current;
}
