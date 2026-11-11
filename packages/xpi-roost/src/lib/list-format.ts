// M15: `xpi roost ls`, a table for people (`--json` is for programs).
import type { JobRow } from "./protocol.ts";
import { truncateToWidth, visibleWidth } from "./text-width.ts";
import { ageOf, groupOf, sentenceOf, shortPath } from "./view-model.ts";

const ORDER = { pinned: 0, "needs-input": 1, working: 2, completed: 3 } as const;
const oneLine = (s: string) =>
	s
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

export interface ListOptions {
	now?: number;
	width?: number;
	home?: string;
}

/** Rows as the hub would list them: waiting first, then working, then the rest by when they ended. */
export function formatList(rows: JobRow[], opts: ListOptions = {}): string {
	const now = opts.now ?? Date.now();
	const width = Math.max(40, opts.width ?? 100);
	const shown = [...rows].sort(
		(a, b) => ORDER[groupOf(a)] - ORDER[groupOf(b)] || (b.endedAt ?? b.stateSince) - (a.endedAt ?? a.stateSince),
	);
	if (shown.length === 0) return "no background sessions\n";
	const state = (r: JobRow) =>
		r.state === "blocked" ? "waiting" : r.state === "working" && r.status === "busy" ? "working" : r.state;
	const cells = shown.map((r) => ({
		id: r.id,
		state: `${r.pid !== null ? "●" : "∙"} ${state(r)}`,
		name: oneLine(r.name),
		age: ageOf(r, now),
		what: oneLine(r.state === "blocked" && r.question ? r.question : sentenceOf(r)),
		dir: shortPath(r.cwd, opts.home),
	}));
	type Cell = (typeof cells)[number];
	const w = (k: keyof Cell, max: number) => Math.min(max, Math.max(k.length, ...cells.map((c) => visibleWidth(c[k]))));
	const cols = { id: w("id", 8), state: w("state", 10), name: w("name", 30), age: w("age", 6), dir: w("dir", 28) };
	const fixed = cols.id + cols.state + cols.name + cols.age + cols.dir + 10;
	const whatW = Math.max(10, width - fixed);
	const pad = (s: string, n: number) => {
		const t = truncateToWidth(s, n, "…");
		return t + " ".repeat(Math.max(0, n - visibleWidth(t)));
	};
	const line = (c: Cell) =>
		[
			pad(c.id, cols.id),
			pad(c.state, cols.state),
			pad(c.name, cols.name),
			pad(c.age, cols.age),
			pad(c.what, whatW),
			truncateToWidth(c.dir, cols.dir, "…"),
		]
			.join("  ")
			.trimEnd();
	const fit = (l: string) => truncateToWidth(l, width, "…");
	const head = line({ id: "ID", state: "STATE", name: "NAME", age: "AGE", what: "ACTIVITY", dir: "DIR" });
	return `${[head, ...cells.map(line)].map(fit).join("\n")}\n`;
}
