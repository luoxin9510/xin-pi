import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runSg } from "../src/index.ts";

const roots: string[] = [];

/** A fresh temp directory, removed by `cleanup()`. */
export function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `xpi-sg-${prefix}-`)));
	roots.push(dir);
	return dir;
}

export function cleanup(): void {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function write(root: string, path: string, text: string): void {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

export const read = (root: string, path: string): string => readFileSync(join(root, path), "utf8");

/** Every file and directory below `root`, relative, sorted. */
export function tree(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			found.push(path.slice(root.length + 1) + (statSync(path).isDirectory() ? "/" : ""));
			if (statSync(path).isDirectory()) walk(path);
		}
	};
	walk(root);
	return found.sort();
}

export interface Result {
	code: number;
	out: string;
	err: string;
}

export interface Lab {
	/** The workspace. */
	ws: string;
	/** The host stand-in the plain adapter reads and writes. */
	upstream: string;
	store: string;
	/** A directory of extra adapters (XPI_SG_ADAPTER_PATH). */
	adapters: string;
	env: NodeJS.ProcessEnv;
	/** Run `xpi sg <args>` in the workspace (or `cwd`). */
	sg: (
		args: string[],
		extra?: { cwd?: string; env?: NodeJS.ProcessEnv; lockTimeoutMs?: number; ownSessionPid?: number },
	) => Promise<Result>;
	/** Run plain git on the shadow repo. */
	git: (...args: string[]) => string;
	/** Put a new version of the host: files, then a bumped version counter. */
	hostCommit: (files: Record<string, string | null>) => void;
}

/** A temp store, a workspace, and a plain-adapter host with a few files. Every test names `XPI_SG_STORE`. */
export function lab(name = "demo"): Lab {
	const base = tempDir("lab");
	const ws = join(base, "ws");
	const upstream = join(base, "upstream");
	const store = join(base, "store");
	const adapters = join(base, "adapters");
	const gitConfig = join(base, "gitconfig");
	for (const dir of [ws, upstream, adapters]) mkdirSync(dir, { recursive: true });
	writeFileSync(gitConfig, "");
	write(upstream, ".plainvcs/version", "1\n");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		XPI_SG_STORE: store,
		XPI_SG_ADAPTER_PATH: adapters,
		GIT_CONFIG_GLOBAL: gitConfig,
		GIT_CONFIG_NOSYSTEM: "1",
	};
	delete env.XPI_SG_GIT;
	const sg: Lab["sg"] = async (args, extra = {}) => {
		let out = "";
		let err = "";
		const code = await runSg(args, {
			cwd: extra.cwd ?? ws,
			env: { ...env, ...extra.env },
			stdout: (text) => {
				out += text;
			},
			stderr: (text) => {
				err += text;
			},
			stdio: "capture",
			lockTimeoutMs: extra.lockTimeoutMs ?? 500,
			ownSessionPid: extra.ownSessionPid,
		});
		return { code, out, err };
	};
	const git = (...args: string[]): string => {
		const result = spawnSync("git", args, {
			cwd: ws,
			encoding: "utf8",
			env: { ...env, GIT_DIR: join(store, `${name}.git`), GIT_WORK_TREE: ws },
		});
		if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
		return result.stdout;
	};
	const hostCommit = (files: Record<string, string | null>): void => {
		for (const [path, text] of Object.entries(files)) {
			if (text === null) rmSync(join(upstream, path), { force: true });
			else write(upstream, path, text);
		}
		const version = Number(read(upstream, ".plainvcs/version")) + 1;
		write(upstream, ".plainvcs/version", `${version}\n`);
	};
	return { ws, upstream, store, adapters, env, sg, git, hostCommit };
}

/** Put files in the workspace, init the repo with the plain adapter, and return the lab. */
export async function initialised(
	files: Record<string, string> = { "a.txt": "a\n", "src/b.txt": "b\n", "src/c.txt": "c\n" },
	flags: string[] = [],
	name = "demo",
): Promise<Lab> {
	const l = lab(name);
	for (const [path, text] of Object.entries(files)) {
		write(l.ws, path, text);
		write(l.upstream, path, text);
	}
	write(l.ws, ".plainvcs/version", "1\n");
	const result = await l.sg([
		"init",
		name,
		"--adapter",
		"plain",
		"--config",
		`shadow.plain.upstream=${l.upstream}`,
		...flags,
	]);
	if (result.code !== 0) throw new Error(`init failed: ${result.err}`);
	return l;
}

/** An adapter script in the lab's adapter directory. */
export function installAdapter(l: Lab, name: string, body: string): void {
	const file = join(l.adapters, `sg-adapter-${name}`);
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
}

/** The plain adapter run with chosen environment overrides: a stand-in for adapters that misbehave. */
export function installPlainWrapper(l: Lab, name: string, prelude: string, plainPath: string): void {
	installAdapter(l, name, `${prelude}\nexec sh "${plainPath}" "$@"`);
}
