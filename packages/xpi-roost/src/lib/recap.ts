// AT-5: what happened while nobody watched a session, shown on attach as one line. The split
// of pi-roost's summarizer.ts that phase 1 keeps: the deterministic list, without the summary
// model (decision 6).
import { clip } from "./heuristics.ts";

export interface AwayLog {
	turns: number;
	tools: Record<string, number>;
	questions: string[];
	failures: number;
}

export const emptyAway = (): AwayLog => ({ turns: 0, tools: {}, questions: [], failures: 0 });

export const awayIsEmpty = (a: AwayLog) =>
	a.turns === 0 && Object.keys(a.tools).length === 0 && a.questions.length === 0;

export function recapList(a: AwayLog): string {
	const parts: string[] = [];
	if (a.turns > 0)
		parts.push(`${a.turns} turn${a.turns === 1 ? "" : "s"} finished${a.failures ? ` (${a.failures} failed)` : ""}`);
	const tools = Object.entries(a.tools)
		.sort((x, y) => y[1] - x[1])
		.map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
	if (tools.length > 0) parts.push(`tools: ${tools.slice(0, 6).join(", ")}${tools.length > 6 ? ", …" : ""}`);
	if (a.questions.length > 0) parts.push(`asked: ${clip(a.questions[a.questions.length - 1]!, 120)}`);
	return parts.join(" · ");
}
