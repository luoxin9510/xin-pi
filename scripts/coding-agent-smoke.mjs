import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const codingAgentName = "xpi-coding-agent";

export function smokeTestCodingAgent(directory, runtime = process.execPath) {
	const packageDir = join(directory, "node_modules", codingAgentName);
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const home = mkdtempSync(join(tmpdir(), "pi-coding-agent-smoke-home-"));
	const entry = join(directory, "coding-agent-smoke.mjs");
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		APPDATA: home,
		LOCALAPPDATA: home,
		XDG_CONFIG_HOME: home,
		XDG_CACHE_HOME: home,
		XPI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		XPI_OFFLINE: "1",
		XPI_TELEMETRY: "0",
	};
	for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	try {
		writeFileSync(entry, `import assert from "node:assert/strict";
import { createAgentSession, SessionManager, ModelRuntime } from "${codingAgentName}";
assert.equal(typeof createAgentSession, "function");
assert.equal(typeof SessionManager.inMemory, "function");
assert.equal(typeof ModelRuntime.create, "function");
`);
		execFileSync(runtime, [entry], { cwd: directory, env, stdio: ["inherit", "pipe", "pipe"], timeout: 30_000 });
		// The bin is the bundle. The unbundled dist/cli.js needs the xpi-* workspace packages, which the published
		// package does not carry (scripts/coding-agent-publish.mjs), so it is not a CLI users can run.
		for (const cli of [manifest.bin.xpi]) {
			const output = execFileSync(runtime, [join(packageDir, cli), "--version"], {
				cwd: directory,
				encoding: "utf8",
				env,
				stdio: ["inherit", "pipe", "pipe"],
				timeout: 30_000,
			});
			if (output.trim() !== manifest.version) throw new Error(`Unexpected version from ${cli}: ${output}`);
		}
	} finally {
		rmSync(entry, { force: true });
		rmSync(home, { recursive: true, force: true });
	}
	console.log(`Coding-agent policy smoke tests passed (${runtime}).`);
}

/**
 * `xpi roost` from the packed package (Node, macOS and Linux): the bundle starts its daemon, the daemon runs a
 * shell-command session in a PTY host (both bundle entries and node-pty, an optional dependency), and the command
 * line lists it, prints its screen and removes it. Users start sessions with `xpi --bg`; this starts one through the
 * daemon's socket as the client library does. The daemon follows this process (ROOST_PARENT_PID) and is stopped at
 * the end.
 */
export function smokeTestRoost(directory) {
	if (process.platform === "win32") return;
	const packageDir = join(directory, "node_modules", codingAgentName);
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const cli = join(packageDir, manifest.bin.xpi);
	// The consumer was installed with --ignore-scripts; a user's install runs node-pty's script, which compiles it on
	// Linux (macOS uses its prebuilt binary).
	if (process.platform === "linux") {
		execFileSync("npm", ["rebuild", "node-pty"], { cwd: directory, stdio: ["ignore", "pipe", "inherit"] });
	}
	const home = mkdtempSync(join(tmpdir(), "xpi-roost-smoke-home-"));
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		XDG_CONFIG_HOME: home,
		XDG_CACHE_HOME: home,
		XPI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		XPI_OFFLINE: "1",
		XPI_TELEMETRY: "0",
		ROOST_PARENT_PID: String(process.pid),
	};
	const roost = (...args) =>
		execFileSync(process.execPath, [cli, "roost", ...args], {
			cwd: home,
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
		});
	const until = (what, fn) => {
		const deadline = Date.now() + 20_000;
		for (;;) {
			const value = fn();
			if (value) return value;
			if (Date.now() > deadline) throw new Error(`roost smoke: ${what} did not happen`);
			execFileSync("sleep", ["0.2"]);
		}
	};
	let socketDir;
	try {
		if (roost("ls").trim() !== "no background sessions") throw new Error("roost smoke: a new roost lists sessions");
		const status = roost("daemon", "status");
		if (!/node-pty {4}ok/.test(status)) throw new Error(`roost smoke: the daemon cannot load node-pty:\n${status}`);
		socketDir = /socket dir {2}(.+)/.exec(status)?.[1];
		if (!socketDir) throw new Error(`roost smoke: no socket dir in:\n${status}`);
		const dispatch = {
			id: 1,
			op: "dispatch",
			args: {
				cwd: home,
				sessionFile: "",
				kind: "shell",
				command: ["/bin/sh", "-c", "echo roost-smoke-ok; sleep 60"],
				env: { PATH: process.env.PATH },
				name: "smoke",
				origin: "dispatch",
			},
		};
		const reply = execFileSync(
			process.execPath,
			[
				"-e",
				`const s = require("node:net").connect(process.argv[1]); s.on("connect", () => s.write(process.argv[2] + "\\n")); s.on("data", (d) => { process.stdout.write(d); s.end(); });`,
				join(socketDir, "daemon.sock"),
				JSON.stringify(dispatch),
			],
			{ encoding: "utf8", timeout: 10_000 },
		);
		if (!JSON.parse(reply.split("\n")[0]).ok) throw new Error(`roost smoke: dispatch refused: ${reply}`);
		until("the session's output", () => {
			try {
				return roost("logs", "smoke").includes("roost-smoke-ok");
			} catch {
				return false;
			}
		});
		const rows = JSON.parse(roost("ls", "--json"));
		if (!rows.some((row) => row.name === "smoke" && row.kind === "shell")) throw new Error("roost smoke: ls --json");
		if (!roost("rm", "smoke").startsWith("removed")) throw new Error("roost smoke: rm");
	} finally {
		try {
			roost("daemon", "stop");
		} catch {}
		rmSync(home, { recursive: true, force: true });
		if (socketDir) rmSync(socketDir, { recursive: true, force: true });
	}
	console.log("xpi roost smoke test passed (daemon, PTY host, shell-command session).");
}
