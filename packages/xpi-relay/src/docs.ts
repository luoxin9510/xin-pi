// The generated parts of docs/relay.md: the state diagram and the transition table, both read from the rows of the
// relay graph, so the docs cannot drift from the code. `npm run generate:relay-docs` in the coding agent writes them.

import { relayGraph } from "./definition.ts";
import { toMermaid } from "./graph/graph.ts";

/** The Mermaid `stateDiagram-v2` of the relay: two states, the phase changes as edges, notes for the rest. */
export function relayDiagram(): string {
	const [header, ...rest] = toMermaid(relayGraph).split("\n");
	return [
		header,
		"    [*] --> lead",
		...rest,
		"    note right of worker",
		"        paused while another model is selected: model_away / model_back",
		"    end note",
	].join("\n");
}

const cell = (text: string) => text.replaceAll("|", "\\|");

/** The transition table: one line per row of the graph, in the order they are tried. */
export function relayTable(): string {
	return [
		"| View | Event | Next | Effects |",
		"|---|---|---|---|",
		...relayGraph.rows.map(
			({ doc }) => `| ${cell(doc.view)} | ${cell(doc.event)} | ${cell(doc.next)} | ${cell(doc.effects)} |`,
		),
	].join("\n");
}
