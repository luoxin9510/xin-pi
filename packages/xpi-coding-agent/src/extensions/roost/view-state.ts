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
