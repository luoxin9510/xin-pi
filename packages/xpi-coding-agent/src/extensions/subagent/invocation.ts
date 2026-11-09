// How a subagent child is started: the same build as the running process, not whatever `pi` is on the PATH.

import { existsSync } from "node:fs";
import { basename } from "node:path";

export interface Invocation {
	command: string;
	args: string[]; // arguments before the child's own: the runtime flags and the script path of this process
}

// Bun-compiled binaries report their embedded entry as argv[1]: "/$bunfs/root/..." on POSIX and "B:/~BUN/root/..." on
// Windows.
function isBunVirtualScript(script: string): boolean {
	return script.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(script);
}

// `process.execArgv` carries the dev flags of a source checkout (the `--import` of the source resolver), without which
// the entry script cannot run.
export function piInvocation(
	script: string | undefined = process.argv[1],
	execPath: string = process.execPath,
	execArgv: string[] = process.execArgv,
): Invocation {
	if (script && !isBunVirtualScript(script) && existsSync(script)) {
		return { command: execPath, args: [...execArgv, script] };
	}
	// A compiled binary is its own entry.
	if (!/^(node|bun)(\.exe)?$/.test(basename(execPath).toLowerCase())) {
		return { command: execPath, args: [] };
	}
	return { command: "xpi", args: [] };
}

// An explicit command wins: the `subagent.piCommand` setting, then XPI_SUBAGENT_TEST_PI (suites run against another build).
export function childInvocation(piCommand: string | undefined): Invocation {
	const explicit = piCommand ?? process.env.XPI_SUBAGENT_TEST_PI;
	return explicit ? { command: explicit, args: [] } : piInvocation();
}
