/**
 * Whether a hub is on screen in this process: the left arrow of the foreground role stays out of its way. Kept apart
 * from `open-view.ts` so the foreground role can ask without loading the hub. Process-wide, not per module copy: a
 * session switch may load these modules again.
 */

const VIEWS = Symbol.for("xpi-roost.openViews");
const g = globalThis as { [VIEWS]?: number };

export const agentViewOpen = (): boolean => (g[VIEWS] ?? 0) > 0;

/** Counts a hub that opens; returns what to call when it closes. */
export function viewOpened(): () => void {
	g[VIEWS] = (g[VIEWS] ?? 0) + 1;
	let closed = false;
	return () => {
		if (closed) return;
		closed = true;
		g[VIEWS] = Math.max(0, (g[VIEWS] ?? 1) - 1);
	};
}

/** What a hub needs of the xpi extension API it runs under: its slash commands and its event bus. */
export interface HubApi {
	getCommands(): { name: string; source: string }[];
	events: { emit(channel: string, data: unknown): void };
}

// The API of the runtime that loaded builtin:roost last. A session switch (`/bg`) replaces the runtime and makes the
// earlier API stale (its calls throw); the new runtime loads the extension again before `withSession` runs, so a hub
// opened there reads this one, never the API the command was registered with.
const API = Symbol.for("xpi-roost.api");
const holder = globalThis as { [API]?: HubApi };

export function setHubApi(api: HubApi | undefined): void {
	holder[API] = api;
}

/**
 * The commands and event bus a hub gets, read from the current runtime at each call. A stale or missing API gives no
 * commands and drops the event rather than throwing into the hub's key handling.
 */
export function hubContext(): {
	commands: () => { name: string; source: string }[];
	events: { emit(channel: string, data: unknown): void };
} {
	return {
		commands: () => {
			try {
				return (holder[API]?.getCommands() ?? []).map((c) => ({ name: c.name, source: c.source }));
			} catch {
				return [];
			}
		},
		events: {
			emit(channel, data) {
				try {
					holder[API]?.events.emit(channel, data);
				} catch {
					// a stale runtime: nobody is listening there any more
				}
			},
		},
	};
}
