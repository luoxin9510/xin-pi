import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SgOptions {
	/** The directory the command runs in. */
	cwd: string;
	/** The environment (`XPI_SG_*` and the rest). Default: this process's. */
	env?: NodeJS.ProcessEnv;
	/** Where output goes. Default: this process's stdout and stderr. */
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	/** `inherit` (default) hands git's own stdio to the terminal in pass-through; `capture` forwards it to stdout and stderr. */
	stdio?: "inherit" | "capture";
	/** The store when `XPI_SG_STORE` is unset. Default: `<agent dir>/shadow-git`. */
	defaultStore?: string;
	/** Where the adapters shipped with the package are. Default: the package's own `adapters/`. */
	builtinAdaptersDir?: string;
	/** How long a held lock is waited for, in milliseconds. Default 10000. */
	lockTimeoutMs?: number;
	/** The pid of the caller's own session: it does not count as another live session. */
	ownSessionPid?: number;
}

export interface SgContext {
	cwd: string;
	env: NodeJS.ProcessEnv;
	store: string;
	/** The git binary (`XPI_SG_GIT`). */
	git: string;
	/** Directories searched for `sg-adapter-<name>`, in order. */
	adapterDirs: string[];
	stdio: "inherit" | "capture";
	out: (text: string) => void;
	err: (text: string) => void;
	lockTimeoutMs: number;
	ownSessionPid: number | undefined;
}

const ownAdaptersDir = fileURLToPath(new URL("../adapters", import.meta.url));

function splitPath(value: string | undefined): string[] {
	return (value ?? "").split(delimiter).filter((entry) => entry !== "");
}

export function createContext(options: SgOptions): SgContext {
	const env = options.env ?? process.env;
	const agentDir = env.XPI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const store = env.XPI_SG_STORE || options.defaultStore || join(agentDir, "shadow-git");
	const adapterPath = env.XPI_SG_ADAPTER_PATH ? splitPath(env.XPI_SG_ADAPTER_PATH) : [join(store, "adapters")];
	return {
		cwd: options.cwd,
		env,
		store,
		git: env.XPI_SG_GIT || "git",
		adapterDirs: [...adapterPath, options.builtinAdaptersDir ?? ownAdaptersDir, ...splitPath(env.PATH)],
		stdio: options.stdio ?? "inherit",
		out: options.stdout ?? ((text) => void process.stdout.write(text)),
		err: options.stderr ?? ((text) => void process.stderr.write(text)),
		lockTimeoutMs: options.lockTimeoutMs ?? 10_000,
		ownSessionPid: options.ownSessionPid,
	};
}
