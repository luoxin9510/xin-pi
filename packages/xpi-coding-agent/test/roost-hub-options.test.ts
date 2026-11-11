// T17: what builtin:roost gives the hub (`/agents`, `xpi roost hub`): the trust decision each session it starts gets,
// presets and grouping written back to the user's settings through xpi's settings, the launch of a new or resumed
// session, `/agents` registered in every session, the standalone hub's arguments and model list.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOST_LOCATION_ENV } from "xpi-roost/hub";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { hubDirProblem, parseModelList, runHub } from "../src/extensions/roost/hub-main.ts";
import { hubOptions, trustFor, type XpiHost } from "../src/extensions/roost/hub-options.ts";

let home: string;
let agentDir: string;
let work: string;
let other: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ROOST_LOCATION_ENV) saved[k] = process.env[k];
	home = mkdtempSync(join(tmpdir(), "roost-hubopts-"));
	agentDir = join(home, "agent");
	work = join(home, "work");
	other = join(home, "other");
	for (const d of [agentDir, work, other]) mkdirSync(d, { recursive: true });
});
afterEach(() => {
	for (const k of ROOST_LOCATION_ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(home, { recursive: true, force: true });
});

const host = (over: Partial<XpiHost> = {}): XpiHost => ({
	cwd: work,
	agentDir,
	argv: [process.execPath, "/xpi/cli.js"],
	projectTrusted: true,
	commands: () => [],
	models: () => ["a/one"],
	scopedModels: () => [],
	currentSession: () => undefined,
	sessionDir: () => undefined,
	...over,
});

describe("the trust decision a session the hub starts gets (xpi --bg's rule)", () => {
	it("in the host's folder its answer (when the folder has something to trust); elsewhere only a stored decision", () => {
		mkdirSync(join(work, ".agents", "skills"), { recursive: true });
		mkdirSync(join(other, ".agents", "skills"), { recursive: true });
		expect(trustFor(work, host())).toBe(true);
		expect(trustFor(work, host({ projectTrusted: false }))).toBe(false);
		// another folder: the host's answer is not its; nothing stored, so no (never left to a question nobody sees)
		expect(trustFor(other, host())).toBe(false);
		new ProjectTrustStore(agentDir).set(other, true);
		expect(trustFor(other, host())).toBe(true);
		// `xpi roost hub`: no session of its own, so no answer even for its folder
		expect(trustFor(work, host({ projectTrusted: undefined }))).toBe(false);
		new ProjectTrustStore(agentDir).set(work, true);
		expect(trustFor(work, host({ projectTrusted: undefined }))).toBe(true);
		// the command line's decision counts in the host's folder only
		rmSync(join(work, ".agents"), { recursive: true });
		new ProjectTrustStore(agentDir).set(work, null);
		expect(trustFor(work, host({ argv: [process.execPath, "/xpi/cli.js", "--approve"] }))).toBe(true);
		expect(trustFor(work, host())).toBe(false);
	});

	it("a new session and a resumed one carry it in their command", () => {
		const o = hubOptions(host());
		new ProjectTrustStore(agentDir).set(other, true);
		const fresh = o.launch("fix the tests", { cwd: other });
		expect(fresh.command).toContain("--approve");
		expect(fresh.command.slice(-2)).toEqual(["--", "fix the tests"]);
		const resumed = o.launch("", { cwd: work, sessionFile: join(work, "s.jsonl"), origin: "adopt" });
		expect(resumed.command).toContain("--no-approve");
		expect(resumed.sessionFile).toBe(join(work, "s.jsonl"));
		// the hub's process carries the roost's location, as `xpi roost` does
		expect(process.env.ROOST_AGENT_DIR).toBe(agentDir);
	});
});

describe("settings the hub changes", () => {
	// xpi's settings write in the background (a queue), before the next key the hub handles
	const written = () => new Promise((r) => setTimeout(r, 20));

	it("a saved preset and the grouping go to the user's settings; a project's preset is not the user's", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", roost: { fullscreen: false } }));
		mkdirSync(join(work, ".pi"), { recursive: true });
		writeFileSync(
			join(work, ".pi", "settings.json"),
			JSON.stringify({ roost: { presets: { shared: { thinking: "low" } } } }),
		);
		const o = hubOptions(host());
		expect(o.fullscreen).toBe(false);
		expect(Object.keys(o.presets!())).toEqual(["shared"]);
		expect(o.userPreset!("shared")).toBe(false);
		o.savePreset!("fast", { model: "a/one", thinking: "high" });
		o.onGroupBy!("directory");
		await written();
		const file = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(file).toEqual({
			theme: "dark",
			roost: { fullscreen: false, presets: { fast: { model: "a/one", thinking: "high" } }, groupBy: "directory" },
		});
		expect(o.userPreset!("fast")).toBe(true);
		expect(Object.keys(o.presets!()).sort()).toEqual(["fast", "shared"]);
		o.savePreset!("fast", null);
		await written();
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).roost).toEqual({
			fullscreen: false,
			groupBy: "directory",
		});
	});

	it("the hub's options from the settings: grouping, row details, the detach key, xpi's commands", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ roost: { groupBy: "directory", rowDetails: false } }),
		);
		writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.suspend": "ctrl+y" }));
		const o = hubOptions(host());
		expect(o.groupBy).toBe("directory");
		expect(o.rowDetails).toBe(false);
		expect(o.detachKeyName).toBe("ctrl+y");
		expect(o.isDetachKey("\x19")).toBe(true);
		expect(o.isDetachKey("\x1a")).toBe(false);
		expect(o.builtins!().find((c) => c.name === "tree")).toMatchObject({ how: "picker" });
	});
});

describe("xpi roost hub", () => {
	it("takes one directory; a file, a missing one, a flag or two are refused before anything is drawn", async () => {
		expect(hubDirProblem(work)).toBeUndefined();
		writeFileSync(join(home, "f"), "");
		expect(hubDirProblem(join(home, "f"))).toMatch(/is not a directory/);
		expect(hubDirProblem(join(home, "nope"))).toMatch(/no directory/);
		const err: string[] = [];
		const write = process.stderr.write;
		process.stderr.write = ((s: string) => err.push(s)) as never;
		try {
			expect(await runHub(["a", "b"], { cwd: work, agentDir })).toBe(2);
			expect(await runHub(["--all"], { cwd: work, agentDir })).toBe(2);
			expect(await runHub(["nope"], { cwd: work, agentDir })).toBe(1);
		} finally {
			process.stderr.write = write;
		}
		expect(err.join("")).toMatch(/usage: xpi roost hub \[dir\][\s\S]*no directory/);
	});

	it("reads xpi --list-models' table; anything else lists nothing", () => {
		const out =
			"provider   model          context  max-out  thinking  images\nanthropic  claude-x      200K     64K      yes       yes\nopenai     gpt-y          128K     16K      no        yes\n";
		expect(parseModelList(out)).toEqual(["anthropic/claude-x", "openai/gpt-y"]);
		expect(parseModelList("No models available. Use /login\n")).toEqual([]);
	});
});
