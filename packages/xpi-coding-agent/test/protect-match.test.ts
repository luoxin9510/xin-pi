import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.ts";
import protect from "../src/extensions/protect/index.ts";
import { type ProtectRules, protectLevel, relativeForMatch, validEntries } from "../src/extensions/protect/match.ts";

const DEFAULTS: ProtectRules = {
	secret: SETTINGS_DEFAULTS.protect.secret,
	readOnly: SETTINGS_DEFAULTS.protect.readOnly,
};

describe("protect matching", () => {
	let root: string;
	let project: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "protect-match-")));
		project = join(root, "project");
		mkdirSync(project);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const level = (path: string, rules: ProtectRules = DEFAULTS, cwd = project) => protectLevel(rules, path, cwd);

	it("applies the default lists", () => {
		expect(level(".env")).toBe("secret");
		expect(level(".env.local")).toBe("secret");
		expect(level("sub/dir/.env")).toBe("secret");
		expect(level(".env.example")).toBeUndefined();
		expect(level(".env.sample")).toBeUndefined();
		expect(level("foo.environment")).toBeUndefined();
		expect(level("keys/server.pem")).toBe("secret");
		expect(level("id_rsa")).toBe("secret");
		expect(level("id_ed25519")).toBe("secret");
		expect(level("id_rsa.pub")).toBeUndefined();
		expect(level(".git/config")).toBe("readOnly");
		expect(level("node_modules/x/index.js")).toBe("readOnly");
		expect(level("src/index.ts")).toBeUndefined();
	});

	it("matches a directory pattern against a file of that name, as in a git worktree", () => {
		writeFileSync(join(project, ".git"), "gitdir: /elsewhere\n");
		expect(level(".git")).toBe("readOnly");
		expect(level("vendor", { secret: [], readOnly: ["vendor/"] })).toBe("readOnly");
	});

	it("reads user and project entries in order, and lets ! undo a default", () => {
		const rules: ProtectRules = {
			secret: [...DEFAULTS.secret, "config/credentials.json", "!.env.local"],
			readOnly: [...DEFAULTS.readOnly, "vendor/", "!vendor/"],
		};
		expect(level("config/credentials.json", rules)).toBe("secret");
		expect(level(".env.local", rules)).toBeUndefined();
		expect(level(".env.production", rules)).toBe("secret");
		expect(level("vendor/a.js", rules)).toBeUndefined();
		// A file under an excluded directory cannot be re-included.
		const keep: ProtectRules = { secret: [], readOnly: ["node_modules/", "!node_modules/keep.js"] };
		expect(level("node_modules/keep.js", keep)).toBe("readOnly");
	});

	it("is a secret when a path is in both lists", () => {
		expect(level("a.txt", { secret: ["a.txt"], readOnly: ["a.txt"] })).toBe("secret");
	});

	it("never matches the root and does not throw on it", () => {
		const everything: ProtectRules = { secret: ["*"], readOnly: ["*"] };
		expect(level(".", everything)).toBeUndefined();
		expect(level("", everything)).toBeUndefined();
		expect(level(project, everything)).toBeUndefined();
	});

	it("matches paths outside the project by their absolute path", () => {
		expect(level(join(homedir(), ".ssh", "id_rsa"))).toBe("secret");
		expect(level("~/.ssh/id_ed25519")).toBe("secret");
		expect(level(join(root, "other", ".env"))).toBe("secret");
		// An anchored pattern only matches inside the project.
		const anchored: ProtectRules = { secret: ["config/x"], readOnly: [] };
		expect(level("config/x", anchored)).toBe("secret");
		expect(level(join(root, "other", "config", "x"), anchored)).toBeUndefined();
	});

	it("follows a symlink to a protected file", () => {
		writeFileSync(join(project, ".env"), "SECRET=1\n");
		symlinkSync(join(project, ".env"), join(project, "notes.txt"));
		expect(level("notes.txt")).toBe("secret");
		mkdirSync(join(project, ".git"));
		symlinkSync(join(project, ".git"), join(project, "innocent"));
		expect(level("innocent/config")).toBe("readOnly");
	});

	it("follows a symlink when the project is under a symlinked directory", () => {
		const link = join(root, "link");
		symlinkSync(project, link);
		writeFileSync(join(project, ".env"), "x");
		symlinkSync(join(project, ".env"), join(project, "alias"));
		const anchored: ProtectRules = { secret: ["secrets/a"], readOnly: [] };
		mkdirSync(join(project, "secrets"));
		writeFileSync(join(project, "secrets", "a"), "x");
		expect(level("alias", DEFAULTS, link)).toBe("secret");
		expect(level("secrets/a", anchored, link)).toBe("secret");
		expect(level(join(project, "secrets", "a"), anchored, link)).toBe("secret");
	});

	it("matches a new file under a protected directory", () => {
		mkdirSync(join(project, ".git"));
		expect(level(".git/hooks/pre-commit")).toBe("readOnly");
		expect(level("node_modules/new/dir/file.js")).toBe("readOnly");
	});

	it("is case-insensitive on darwin and win32 only", () => {
		expect(protectLevel(DEFAULTS, ".ENV", project, "darwin")).toBe("secret");
		expect(protectLevel(DEFAULTS, ".ENV", project, "win32")).toBe("secret");
		expect(protectLevel(DEFAULTS, ".ENV", project, "linux")).toBeUndefined();
		expect(protectLevel(DEFAULTS, ".Git/config", project, "linux")).toBeUndefined();
		expect(protectLevel(DEFAULTS, ".Git/config", project, "darwin")).toBe("readOnly");
	});

	it("skips entries that are not strings and counts them", () => {
		expect(validEntries([".env", 5, null, "a"])).toEqual({ entries: [".env", "a"], skipped: 2 });
		expect(level(".env", { secret: [42, ".env"], readOnly: [] })).toBe("secret");
	});
});

describe("protect path forms on Windows", () => {
	it("drops the drive colon, the UNC and the extended prefixes, and uses / throughout", () => {
		const root = "C:\\work\\project";
		expect(relativeForMatch("C:\\work\\project\\.env", root, "win32")).toBe(".env");
		expect(relativeForMatch("c:\\WORK\\project\\sub\\a", root, "win32")).toBe("sub/a");
		expect(relativeForMatch("C:\\Users\\x\\.ssh\\id_rsa", root, "win32")).toBe("C/Users/x/.ssh/id_rsa");
		expect(relativeForMatch("\\\\server\\share\\x\\.env", root, "win32")).toBe("server/share/x/.env");
		expect(relativeForMatch("\\\\?\\C:\\x", root, "win32")).toBe("C/x");
		expect(relativeForMatch("\\\\?\\C:\\work\\project\\a", root, "win32")).toBe("a");
		expect(relativeForMatch("C:\\work\\project", root, "win32")).toBeUndefined();
		expect(relativeForMatch("C:\\work\\project-two\\a", root, "win32")).toBe("C/work/project-two/a");
	});

	it("gives ignore a path it accepts, with ignore loaded while the platform is win32", () => {
		// `ignore` is CommonJS and decides its Windows mode when it loads, so this runs in a child process.
		const script = `
			Object.defineProperty(process, "platform", { value: "win32" });
			const ig = require("ignore");
			let threw = false;
			try { ig().add("x").ignores("C:/x"); } catch { threw = true; }
			const matched = ig({ ignorecase: true }).add("id_rsa*").ignores("C/Users/x/.ssh/id_rsa");
			process.stdout.write(JSON.stringify({ threw, matched }));
		`;
		const out = execFileSync(process.execPath, ["-e", script], {
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			encoding: "utf8",
		});
		expect(JSON.parse(out)).toEqual({ threw: true, matched: true });
		expect(relativeForMatch("C:\\Users\\x\\.ssh\\id_rsa", "C:\\work", "win32")).toBe("C/Users/x/.ssh/id_rsa");
	});
});

describe("protect handler", () => {
	function install(settings: Record<string, unknown>) {
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const notifications: string[] = [];
		const pi = {
			on: (name: string, handler: (...args: never[]) => unknown) => handlers.set(name, handler),
			registerCommand: () => {},
			getSettings: () => settings,
		};
		protect(pi as never);
		const ctx = {
			cwd: "/nonexistent-protect-cwd",
			hasUI: true,
			ui: { notify: (m: string) => notifications.push(m) },
		};
		const call = (input: Record<string, unknown>, effect = "read") =>
			(handlers.get("tool_call") as (e: unknown, c: unknown) => unknown)({ effect, input }, ctx);
		return { call, notifications };
	}

	it("skips a path with a scheme", () => {
		const { call } = install({});
		expect(call({ path: "docs://.env" })).toBeUndefined();
		expect(call({ path: "@docs://.env" })).toBeUndefined();
		expect(call({ path: ".env" })).toMatchObject({ block: true });
	});

	it("reports non-string entries once per session and keeps the rest", () => {
		const { call, notifications } = install({ protect: { secret: [7, "a.txt"] } });
		expect(call({ path: "a.txt" })).toMatchObject({ block: true });
		expect(call({ path: "a.txt" })).toMatchObject({ block: true });
		expect(notifications.filter((text) => text.includes("not strings"))).toHaveLength(1);
	});

	it("reports a list that is not an array", () => {
		const { call, notifications } = install({ protect: { secret: "oops" } });
		expect(call({ path: ".env" })).toMatchObject({ block: true });
		expect(notifications.filter((text) => text.includes("not an array"))).toHaveLength(1);
	});
});
