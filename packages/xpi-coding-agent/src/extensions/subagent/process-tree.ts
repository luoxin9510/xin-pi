// Child processes of the subagent runner live in their own process group (POSIX), so a signal reaches the child's whole
// tree (MCP servers, bash tools, grandchildren), and so nothing outlives this process: every live group is signalled when
// the parent exits or is hit by SIGINT/SIGTERM/SIGHUP. A group does not get the terminal's ctrl+c any more; the parent
// decides (the TUI reads ctrl+c as a key and stops its subagents; a signal to the parent comes here).
// Windows has no groups: children keep the plain child.kill behaviour.

import { type ChildProcess, spawn } from "node:child_process";

export const GROUPS = process.platform !== "win32";

const live = new Map<ChildProcess, number>(); // child -> grace (ms) its tree gets after SIGTERM when the parent leaves
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
let installed = false;

// Signal the child's whole group; fall back to the child alone where groups are unavailable or the group is gone.
export function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (GROUPS && child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// no such group: fall through
		}
	}
	try {
		child.kill(signal);
	} catch {
		// already gone
	}
}

// The parent is leaving: SIGTERM every live tree (children also see their stdin close), and let a detached watchdog
// SIGKILL what ignored it after the grace. The watchdog is a plain `sh`, so it outlives us (exit handlers are synchronous).
function leave(): void {
	for (const [child, graceMs] of live) {
		if (!child.pid) continue;
		signalTree(child, "SIGTERM");
		if (!GROUPS) continue;
		try {
			const seconds = Math.max(0.1, graceMs / 1000);
			spawn("sh", ["-c", `sleep ${seconds}; kill -KILL -- -${child.pid} 2>/dev/null`], {
				detached: true,
				stdio: "ignore",
			}).unref();
		} catch {
			// best effort
		}
	}
	live.clear();
}

const handlers = new Map<string, () => void>();
function install(): void {
	if (installed || !GROUPS) return;
	installed = true;
	process.on("exit", leave);
	for (const s of SIGNALS) {
		const h = () => {
			// With no other handler the signal would have ended the process: let it, the children are signalled now.
			leave();
			if (process.listenerCount(s) === 1) {
				uninstall();
				process.kill(process.pid, s);
			}
		};
		handlers.set(s, h);
		process.on(s, h);
	}
}

function uninstall(): void {
	if (!installed) return;
	installed = false;
	process.off("exit", leave);
	for (const [s, h] of handlers) process.off(s, h);
	handlers.clear();
}

// Track a spawned child until it is gone.
export function trackTree(child: ChildProcess, graceMs: number): () => void {
	if (!GROUPS) return () => {};
	live.set(child, graceMs);
	install();
	return () => {
		live.delete(child);
		if (live.size === 0) uninstall();
	};
}
