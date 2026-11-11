import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, envPolicy, loadUserConfig, mergeConfig, USER_ONLY } from "../src/lib/config.ts";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "xroost-cfg-"));
});
afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

const settings = (v: unknown) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify(v));

describe("the roost section of settings.json", () => {
	it("defaults without a file, a section, or an agent directory", () => {
		expect(loadUserConfig(agentDir)).toEqual(DEFAULTS);
		expect(loadUserConfig(undefined)).toEqual(DEFAULTS);
		settings({ subagent: { model: "x/y" } });
		expect(loadUserConfig(agentDir)).toEqual(DEFAULTS);
	});

	it("reads the user's section; bad values and a file that does not parse are ignored", () => {
		settings({
			roost: { leftArrowOpensAgents: false, reapIdleMinutes: 30, groupBy: "sideways", envAllowList: ["MINE", 3] },
		});
		expect(loadUserConfig(agentDir)).toMatchObject({
			leftArrowOpensAgents: false,
			reapIdleMinutes: 30,
			envAllowList: ["MINE"],
			groupBy: "state",
		});
		writeFileSync(join(agentDir, "settings.json"), "{ not json");
		expect(loadUserConfig(agentDir)).toEqual(DEFAULTS);
		settings({ roost: "on" });
		expect(loadUserConfig(agentDir)).toEqual(DEFAULTS);
	});

	it("a project's section overrides the user's, except the keys only the user may set", () => {
		const user = { reapIdleMinutes: 30, envAllowList: ["MINE"], inheritEnv: true, workspaceEnv: "direnv" };
		const project = {
			reapIdleMinutes: 5,
			envAllowList: ["AWS_SECRET_ACCESS_KEY"],
			inheritEnv: false,
			envDenyList: ["HOME"],
			workspaceEnv: "off",
		};
		const c = mergeConfig(user, project);
		expect(c).toMatchObject({ reapIdleMinutes: 5, envAllowList: ["MINE"], inheritEnv: true, workspaceEnv: "direnv" });
		expect(c.envDenyList).toEqual([]);
		expect([...USER_ONLY].sort()).toEqual(["envAllowList", "envDenyList", "inheritEnv", "workspaceEnv"]);
		expect(envPolicy({ ...c, inheritEnv: false }).workspaceEnv).toBe("off");
	});
});

describe("M27 presets", () => {
	it("takes model, thinking and dir only, merges the user's and a project's by name", () => {
		const user = {
			groupBy: "directory",
			presets: {
				review: { model: "a/one", thinking: "high", agent: "reviewer", worktree: false },
				wide: { fanout: ["a/one", "b/two"], dir: "api" },
				"bad name!": { model: "a/one" },
				odd: { model: "noslash", thinking: "LOUD", dir: "../../etc" },
			},
		};
		const p = mergeConfig(user, { presets: { review: { model: "c/three" }, abs: { dir: "/etc" } } }).presets!;
		expect(p.review).toEqual({ model: "c/three" });
		expect(p.wide).toEqual({ dir: "api" });
		expect(p.odd).toEqual({});
		expect(p.abs).toEqual({});
		expect("bad name!" in p).toBe(false);
		// no way out of the project's directory
		const q = mergeConfig(undefined, {
			presets: {
				a: { dir: "C:\\x" },
				b: { dir: "\\\\host\\share" },
				c: { dir: "sub/dir" },
				off: { model: "a/one" },
			},
		}).presets!;
		expect([q.a, q.b, q.c]).toEqual([{}, {}, { dir: "sub/dir" }]);
		expect(Object.hasOwn(q, "off")).toBe(false);
		expect(Object.getPrototypeOf(q)).toBeNull();
	});
});
