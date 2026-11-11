import { describe, expect, it } from "vitest";
import { jobIdentity } from "../src/lib/agent-client.ts";
import { JOB_ENV_NAMES, jobEnv, readJobEnv, roostEnv } from "../src/lib/identity.ts";
import { ENV_NEVER } from "../src/lib/workspace-env.ts";

describe("a job's identity in the environment", () => {
	it("a worker gets ROOST_* names only; none of them is inherited by another job", () => {
		const env = jobEnv({ id: "j1", token: "t", socket: "/s", dir: "/d" });
		expect(env).toEqual({ ROOST_JOB_ID: "j1", ROOST_JOB_TOKEN: "t", ROOST_SOCKET: "/s", ROOST_JOB_DIR: "/d" });
		expect(readJobEnv({ ROOST_JOB_ID: "new" }, "id")).toBe("new");
		expect(jobIdentity({ ROOST_JOB_ID: "a", ROOST_JOB_TOKEN: "b", ROOST_SOCKET: "/c" })).toEqual({
			id: "a",
			token: "b",
			socket: "/c",
		});
		// pi-roost's names are not read: a pi-roost worker is not one of these
		expect(jobIdentity({ PI_JOB_ID: "a", PI_JOB_TOKEN: "b", PI_DAEMON_SOCK: "/c" })).toBeUndefined();
		for (const n of [...Object.keys(env), "ROOST_RESTORE"]) {
			expect(JOB_ENV_NAMES).toContain(n);
			expect(ENV_NEVER.has(n)).toBe(true);
		}
	});

	it("settings come from ROOST_* only", () => {
		expect(roostEnv("HOME", { ROOST_HOME: "/n", PI_ROOST_HOME: "/o" })).toBe("/n");
		expect(roostEnv("HOME", { PI_ROOST_HOME: "/o" })).toBeUndefined();
		expect(roostEnv("HOME", { ROOST_HOME: "" })).toBeUndefined();
	});
});
