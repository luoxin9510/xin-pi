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

describe("spec 03: forgetInheritedJob", () => {
	it("an xpi started from a session's shell drops the job it inherited; a session keeps its own", async () => {
		const { forgetInheritedJob } = await import("../src/session.ts");
		// what a worker leaves for what it starts: the id and the socket, not the token
		const inherited: NodeJS.ProcessEnv = {
			ROOST_JOB_ID: "j1",
			ROOST_SOCKET: "/tmp/s",
			ROOST_JOB_DIR: "/tmp/d",
			ROOST_RESTORE: "1",
			ROOST_HOME: "/keep",
			PATH: "/bin",
		};
		forgetInheritedJob(inherited);
		expect(inherited).toEqual({ ROOST_HOME: "/keep", PATH: "/bin" });
		// the session itself (its token is there): untouched
		const session: NodeJS.ProcessEnv = { ROOST_JOB_ID: "j2", ROOST_SOCKET: "/tmp/s", ROOST_JOB_TOKEN: "t" };
		forgetInheritedJob(session);
		expect(session).toEqual({ ROOST_JOB_ID: "j2", ROOST_SOCKET: "/tmp/s", ROOST_JOB_TOKEN: "t" });
		// no job at all: nothing to do
		const plain: NodeJS.ProcessEnv = { PATH: "/bin" };
		forgetInheritedJob(plain);
		expect(plain).toEqual({ PATH: "/bin" });
	});
});
