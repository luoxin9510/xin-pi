// Phase 2 (spec 02, decision 8; from pi-roost's M39/M73): the schedules overlay (/schedule alone). Each schedule
// with its rule, next run, last run or skip; on the selected one: run now, pause or resume, edit the rule, remove.
// It holds nothing of the view: its host, the slice of the port it uses, and how a launch is built again (an edit
// builds it in this process, as `xpi roost schedule edit` does).
import { decodeKittyPrintable, isKeyRelease, parseKey, truncateToWidth, visibleWidth } from "xpi-tui";
import type { DispatchArgs, JobRow, ScheduleRow } from "../../lib/protocol.ts";
import { agoText, normalizeWhen, parseWhen, untilText } from "../../lib/schedule.ts";
import { DOUBLE_PRESS_MS, type Overlay, type OverlayHost } from "../overlay-host.ts";
import type { RoostPort } from "../roost-port.ts";
import { oneLine } from "../text.ts";

/** What the overlay asks of the daemon. */
export interface SchedulesPort {
	schedules: Pick<RoostPort["schedules"], "list" | "edit" | "rm" | "pause" | "run">;
}

/** What the overlay needs of the view. */
export type SchedulesHost = Pick<
	OverlayHost<SchedulesPort>,
	"port" | "theme" | "say" | "close" | "requestRender" | "termRows" | "notice" | "rows" | "current"
>;

/** Decision 8: what became of a run, as its row says (nothing when it is no longer listed). */
function runResult(row: JobRow | undefined): string | undefined {
	if (!row) return undefined;
	if (row.state === "blocked") return "needs input";
	return row.state;
}

export interface SchedulesOpts {
	/**
	 * A schedule's launch built again here (decision 8: every edit does, with its stored task, model and thinking, in
	 * its directory). None: editing is not available.
	 */
	rebuild?: (row: ScheduleRow) => DispatchArgs;
}

const ADD_HINT =
	'/schedule <name> <every 30m | daily 09:00 | weekdays 09:00 | weekly mon 09:00 | cron "…" | manual> <task>';

/** `undefined` when there are none or the list cannot be read (the host has been told). */
export async function createSchedulesOverlay(
	host: SchedulesHost,
	opts: SchedulesOpts = {},
): Promise<Overlay | undefined> {
	const { port } = host;
	let list: ScheduleRow[];
	let problem: string | undefined;
	const load = async () => {
		const r = await port.schedules.list();
		list = r.schedules;
		problem = r.problem;
	};
	try {
		await load();
	} catch (err) {
		host.say((err as Error).message, "error");
		return undefined;
	}
	if (list!.length === 0) {
		host.say(problem ?? `no schedules: ${ADD_HINT}`, problem ? "warning" : "muted");
		return undefined;
	}
	let index = 0;
	let top = 0;
	/** The rule being edited (the selected schedule's), or none. */
	let editing: string | undefined;
	let removeAt = 0;
	let busy = false;

	const selected = (): ScheduleRow | undefined => list[Math.min(index, list.length - 1)];
	const reload = async () => {
		try {
			await load();
			if (list.length === 0) {
				host.say("no schedules left");
				// only when this overlay is the one shown (another may have replaced it meanwhile)
				if (host.current() === overlay) host.close();
				return;
			}
			index = Math.min(index, list.length - 1);
		} catch (err) {
			host.say((err as Error).message, "error");
		}
		host.requestRender();
	};
	/** One action on the selected schedule at a time; its answer said, the list read again. */
	const act = (what: (s: ScheduleRow) => Promise<string>) => {
		const s = selected();
		if (!s || busy) return;
		busy = true;
		void what(s)
			.then((text) => host.say(text, "success"))
			.catch((err: unknown) => host.say(`${s.name}: ${(err as Error).message}`, "warning"))
			.finally(() => {
				busy = false;
				void reload();
			});
	};

	const lines = (width: number): { all: string[]; at: number } => {
		const t = host.theme;
		const now = Date.now();
		const out = [t.bold(truncateToWidth("Schedules", width))];
		if (problem) out.push(t.fg("warning", truncateToWidth(oneLine(problem), width)));
		out.push("");
		let at = 0;
		list.forEach((s, i) => {
			if (i === index) at = out.length;
			const next = s.paused
				? t.fg("warning", "paused")
				: s.nextAt === null
					? "runs when asked"
					: `next ${untilText(s.nextAt, now)}`;
			const result = s.lastJob ? runResult(host.rows().get(s.lastJob)) : undefined;
			const last =
				s.lastRunAt === null
					? "not run yet"
					: `last ${agoText(now - s.lastRunAt)} ago${s.lastRunWhy && s.lastRunWhy !== "due" ? ` (${s.lastRunWhy})` : ""}${result ? `: ${result}` : ""}`;
			const mark = i === index ? t.fg("accent", "› ") : "  ";
			out.push(truncateToWidth(`${mark}${t.fg("accent", s.name)}  ${s.when}  · ${next} · ${last}`, width));
			const where = [oneLine(s.task ?? ""), s.cwd, s.model].filter(Boolean).join(" · ");
			out.push(t.fg("dim", truncateToWidth(`    ${where}`, width)));
			// a skip newer than the last run is what happened last
			if (s.lastSkip && (s.lastRunAt === null || s.lastSkip.at >= s.lastRunAt))
				out.push(
					t.fg(
						"warning",
						truncateToWidth(`    skipped ${agoText(now - s.lastSkip.at)} ago: ${oneLine(s.lastSkip.why)}`, width),
					),
				);
		});
		return { all: out, at };
	};

	const overlay: Overlay = {
		render(width: number) {
			const t = host.theme;
			const { all, at } = lines(width);
			const room = Math.max(3, (host.termRows() || 30) - 6);
			// keep the selection in sight
			if (at < top) top = at;
			if (at + 2 >= top + room) top = at + 3 - room;
			top = Math.max(0, Math.min(top, all.length - room));
			const s = selected();
			const keys =
				editing !== undefined && s
					? truncateToWidth(`rule for ${s.name}: ${editing}▏`, width)
					: t.fg(
							"dim",
							truncateToWidth(
								`Enter run now · p ${s?.paused ? "resume" : "pause"} · e edit the rule · x remove · r reload · Esc close`,
								width,
							),
						);
			const hint =
				editing !== undefined ? t.fg("dim", truncateToWidth("Enter save · Esc cancel", width)) : undefined;
			// what an action answered (the notice row is under the overlay)
			const n = host.notice();
			const said = n && n.until > Date.now() ? [t.fg(n.tone, truncateToWidth(oneLine(n.text), width))] : [];
			const out = [...all.slice(top, top + room), "", ...said, keys, ...(hint ? [hint] : [])];
			return out.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
		},
		handleInput(data: string) {
			const key = parseKey(data);
			if (editing !== undefined) {
				if (key === "escape") editing = undefined;
				else if (key === "enter") {
					const when = normalizeWhen(editing);
					try {
						parseWhen(when);
					} catch (err) {
						host.say((err as Error).message, "warning");
						return;
					}
					editing = undefined;
					const rebuild = opts.rebuild!;
					act(async (s) => {
						const r = await port.schedules.edit({ name: s.name, when, launch: rebuild(s) });
						return `${r.name}: ${r.when}${r.nextAt !== null && !r.paused ? `, next run ${untilText(r.nextAt)}` : ""}`;
					});
				} else if (key === "backspace") editing = editing.slice(0, -1);
				else {
					// typed as the hub's other inputs take it: a paste (one line), a kitty-encoded key decoded
					const pasted = data.startsWith("\x1b[200~")
						? data.replace(/\x1b\[20[01]~/g, "").replace(/[\r\n\t]+/g, " ")
						: undefined;
					const text = pasted ?? (isKeyRelease(data) ? undefined : (decodeKittyPrintable(data) ?? data));
					if (text && !text.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(text)) editing += text;
				}
				host.requestRender();
				return;
			}
			if (key === "escape" || key === "ctrl+c" || data === "q") host.close();
			else if (key === "up" || key === "down") {
				index = key === "up" ? Math.max(0, index - 1) : Math.min(list.length - 1, index + 1);
				// a second x confirms the schedule the first one named
				removeAt = 0;
			} else if (key === "enter")
				act(async (s) => {
					const r = await port.schedules.run(s.name);
					return `${s.name}: started ${r.id}`;
				});
			else if (data === "p")
				act(async (s) => {
					const r = await port.schedules.pause(s.name, !s.paused);
					return r.paused
						? `${r.name}: paused`
						: `${r.name}: resumed${r.nextAt !== null ? `, next run ${untilText(r.nextAt)}` : ""}`;
				});
			else if (data === "e") {
				if (!opts.rebuild) host.say("editing is not available here", "warning");
				else editing = selected()?.when ?? "";
			} else if (data === "x") {
				const now = Date.now();
				if (now - removeAt > DOUBLE_PRESS_MS) {
					removeAt = now;
					host.say(`x again to remove ${selected()?.name} (its runs stay listed)`, "warning");
				} else {
					removeAt = 0;
					act(async (s) => {
						await port.schedules.rm(s.name);
						return `${s.name}: removed`;
					});
				}
			} else if (data === "r") void reload();
			host.requestRender();
		},
	};
	return overlay;
}
