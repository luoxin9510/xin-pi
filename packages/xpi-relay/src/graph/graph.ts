// A small transition-table engine: states, events and rows, where the first row that matches a (state, event) pair
// decides. Internal to xpi-relay: it is not exported from the package and carries no stability promise.

export interface Row<View, Event extends { type: string }, Effect, Config> {
	/** The states the row applies to; `"*"` is every state. */
	from: string | readonly string[] | "*";
	/** The event types the row answers. */
	on: Event["type"] | readonly Event["type"][];
	/** Extra condition on the view, the event and the config; a row without it always matches. */
	when?(view: View, event: Event, config: Config): boolean;
	/** The four columns of the generated docs table. */
	doc: { view: string; event: string; next: string; effects: string };
	/** The state the row moves to, for the diagram; the new view itself comes from `step`. */
	to?: string;
	/** Keep the row out of the diagram (it stays in the table). */
	diagram?: false;
	step(view: View, event: Event, config: Config): { next: View; effects: Effect[] };
}

export interface Graph<View, Event extends { type: string }, Effect, Config> {
	name: string;
	/** How a view names its state, for the completeness check and the diagram. */
	stateOf(view: View): string;
	states: readonly string[];
	events: readonly Event["type"][];
	/** In order; the first row that matches wins. */
	rows: readonly Row<View, Event, Effect, Config>[];
	/**
	 * What an unmatched (state, event) pair does, per event type: nothing, or a refusal. A new event without an entry
	 * here does not compile.
	 */
	otherwise: { [T in Event["type"]]: (view: View, event: Event) => { next: View; effects: Effect[] } };
}

export interface GraphResult<View, Effect> {
	next: View;
	effects: Effect[];
	/** The `doc.view` of the row that matched; absent when `otherwise` answered. */
	row?: string;
}

const list = <T>(value: T | readonly T[]): readonly T[] => (Array.isArray(value) ? value : [value as T]);

/** Validate a definition and return it. Throws on a row that names an undeclared state or event, an unused state, or a shadowed row. */
export function defineGraph<View, Event extends { type: string }, Effect, Config>(
	graph: Graph<View, Event, Effect, Config>,
): Graph<View, Event, Effect, Config> {
	const states = new Set(graph.states);
	const events = new Set<string>(graph.events);
	const used = new Set<string>();
	// The (state, event) pairs an earlier row without a guard already answers.
	const answered = new Set<string>();
	graph.rows.forEach((row, index) => {
		const label = `${graph.name}: row ${index} (${row.doc.view})`;
		const from = row.from === "*" ? graph.states : list(row.from);
		for (const state of from) {
			if (!states.has(state)) throw new Error(`${label} names the undeclared state "${state}"`);
			used.add(state);
		}
		if (row.to !== undefined && !states.has(row.to))
			throw new Error(`${label} goes to the undeclared state "${row.to}"`);
		const on = list(row.on);
		for (const event of on) {
			if (!events.has(event)) throw new Error(`${label} names the undeclared event "${event}"`);
		}
		const pairs = from.flatMap((state) => on.map((event) => `${state}\0${event}`));
		if (pairs.length > 0 && pairs.every((pair) => answered.has(pair))) {
			throw new Error(`${label} can never match: earlier rows without a guard answer all its pairs`);
		}
		if (!row.when) for (const pair of pairs) answered.add(pair);
	});
	for (const state of graph.states) {
		if (!used.has(state)) throw new Error(`${graph.name}: the state "${state}" appears in no row`);
	}
	return graph;
}

function matches<View, Event extends { type: string }, Effect, Config>(
	graph: Graph<View, Event, Effect, Config>,
	row: Row<View, Event, Effect, Config>,
	view: View,
	event: Event,
	config: Config,
): boolean {
	if (!list(row.on).includes(event.type)) return false;
	if (row.from !== "*" && !list(row.from).includes(graph.stateOf(view))) return false;
	return row.when ? row.when(view, event, config) : true;
}

/** Apply the first row that matches, or `otherwise`. */
export function transition<View, Event extends { type: string }, Effect, Config>(
	graph: Graph<View, Event, Effect, Config>,
	view: View,
	event: Event,
	config: Config,
): GraphResult<View, Effect> {
	for (const row of graph.rows) {
		if (matches(graph, row, view, event, config)) return { ...row.step(view, event, config), row: row.doc.view };
	}
	return graph.otherwise[event.type as Event["type"]](view, event);
}

/** Every (state, event) pair with the rows that can answer it, for exhaustive tests. A pair no row names has no rows. */
export function pairs<View, Event extends { type: string }, Effect, Config>(
	graph: Graph<View, Event, Effect, Config>,
): { state: string; event: string; rows: string[] }[] {
	return graph.states.flatMap((state) =>
		graph.events.map((event) => ({
			state,
			event,
			rows: graph.rows
				.filter(
					(row) =>
						list(row.on).includes(event) &&
						(row.from === "*" || (list(row.from) as readonly string[]).includes(state)),
				)
				.map((row) => row.doc.view),
		})),
	);
}

/**
 * A Mermaid `stateDiagram-v2`. A row with `to` is an edge, one without is a self-loop, unless it sets `diagram: false`.
 * A `"*"` row is drawn once, as a note beside the first state, not as an edge from every state.
 */
export function toMermaid<View, Event extends { type: string }, Effect, Config>(
	graph: Graph<View, Event, Effect, Config>,
): string {
	const lines = ["stateDiagram-v2"];
	const seen = new Set<string>();
	const notes: string[] = [];
	for (const row of graph.rows) {
		if (row.diagram === false) continue;
		if (row.from === "*") {
			notes.push(`${row.doc.view}: ${list(row.on).join(" / ")}`);
			continue;
		}
		for (const from of list(row.from)) {
			const line = `    ${from} --> ${row.to ?? from}: ${list(row.on).join(" / ")}`;
			if (seen.has(line)) continue;
			seen.add(line);
			lines.push(line);
		}
	}
	if (notes.length > 0) {
		lines.push(`    note right of ${graph.states[0]}`, ...notes.map((note) => `        ${note}`), "    end note");
	}
	return lines.join("\n");
}
