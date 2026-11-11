// M72: a fake OverlayHost for overlay tests: it records what the overlay asked of the view
// (say, close, attachTo, requestRender) and keeps the view's rows and "current overlay".
import type { Overlay, OverlayHost } from "../../src/hub/overlay-host.ts";
import type { JobRow } from "../../src/lib/protocol.ts";
import type { Tone } from "../../src/lib/view-model.ts";

export function fakeHost<P>(port: P, over: Partial<OverlayHost<P>> = {}) {
	const said: { text: string; tone: Tone | undefined }[] = [];
	const attached: string[] = [];
	const selected: string[] = [];
	const rows = new Map<string, JobRow>();
	const log = { closes: 0, renders: 0 };
	let current: Overlay | undefined;
	let notice: { text: string; tone: Tone; until: number } | undefined;
	const host: OverlayHost<P> = {
		port,
		theme: { fg: (_c, t) => t, bold: (t) => t },
		say: (text, tone) => {
			said.push({ text, tone });
			notice = { text, tone: tone ?? "muted", until: Date.now() + 4000 };
		},
		close: () => {
			log.closes++;
			current = undefined;
		},
		requestRender: () => {
			log.renders++;
		},
		attachTo: async (id) => {
			attached.push(id);
		},
		selectRow: (id) => void selected.push(id),
		rows: () => rows,
		current: () => current,
		notice: () => notice,
		termRows: () => 30,
		...over,
	};
	return {
		host,
		said,
		attached,
		selected,
		rows,
		log,
		/** The view shows `o` now. */
		mount: (o: Overlay | undefined) => {
			current = o;
		},
		texts: () => said.map((s) => s.text),
	};
}

export const jobRow = (over: Partial<JobRow> = {}): JobRow => ({
	id: "w1",
	cwd: "/w",
	kind: "pi",
	startedAt: 0,
	state: "working",
	pid: 100,
	status: "busy",
	waitingFor: null,
	sessionFile: "/s/1.jsonl",
	name: "lint",
	endedAt: null,
	summary: "running bash",
	question: null,
	choices: [],
	model: "p/m",
	thinking: null,
	context: null,
	error: null,
	stateSince: 0,
	reaped: false,
	pinned: false,
	order: null,
	orderKey: null,
	...over,
});

export const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
