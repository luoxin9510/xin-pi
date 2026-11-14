// builtin:shadow-git inside a sandbox (XPI_SG_SANDBOX): the path check of the file tools by real path, the paths that are
// always writable, the bash block list and the prompt. Real sandboxes with the policy backend; no model.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createShadowGitExtension } from "../../../src/extensions/shadow-git/index.ts";
import { fakeApi, fakeCtx, type Lab, lab, write } from "./lab.ts";

// What `xpi sg sbx run w1 -- xpi` gives the session.
async function inSandbox(l: Lab, extra: { backend?: string } = {}) {
	write(l.ws, "extra/data.txt", "untracked\n");
	const made = await l.sg(["sbx", "create", "w1"]);
	assert.equal(made.code, 0, made.err);
	const tree = join(l.store, "demo.sbx", "w1", "tree");
	Object.assign(process.env, {
		XPI_SG_SANDBOX: "demo/w1",
		XPI_SG_BACKEND: extra.backend ?? "policy",
		GIT_DIR: join(l.store, "demo.git", "worktrees", "w1"),
		GIT_WORK_TREE: tree,
	});
	const api = fakeApi();
	createShadowGitExtension()(api.pi);
	const c = fakeCtx(tree);
	const sessionDir = join(l.root, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	c.ctx.sessionManager.getSessionDir = () => sessionDir;
	await api.emit("session_start", { type: "session_start", reason: "startup" }, c.ctx);
	const call = (toolName: string, input: Record<string, unknown>) =>
		api.emit("tool_call", { type: "tool_call", toolName, input }, c.ctx);
	return { api, c, tree, call, sessionDir };
}

test("a sandbox registers its hooks only: no /sg command, no live entry, no change to GIT_DIR", async () => {
	const l = await lab();
	try {
		const { api, tree } = await inSandbox(l);
		assert.deepEqual(Object.keys(api.commands), []);
		assert.deepEqual(api.others, []);
		assert.equal(process.env.GIT_WORK_TREE, tree);
		assert.equal(process.env.GIT_DIR, join(l.store, "demo.git", "worktrees", "w1"));
	} finally {
		l.restore();
	}
});

test("write and edit: the sandbox's own copy is writable, the primary is not, also through a link into it", async () => {
	const l = await lab();
	try {
		const { tree, call } = await inSandbox(l);
		// own files, existing and new
		assert.equal(await call("write", { path: join(tree, "a.txt"), content: "x" }), undefined);
		assert.equal(await call("write", { path: "new/dir/file.txt", content: "x" }), undefined);
		assert.equal(await call("edit", { path: "src/b.txt", edits: [] }), undefined);
		// the primary workspace, by its own path
		const direct = await call("write", { path: join(l.ws, "a.txt"), content: "x" });
		assert.equal(direct.block, true);
		assert.match(direct.reason, /shadow-git sandbox demo\/w1: .*a\.txt is read-only/);
		assert.equal((await call("write", { path: join(l.ws, "brand-new.txt"), content: "x" })).block, true);
		// a link into primary: extra/ is untracked, so the tree holds a link to it
		const through = await call("write", { path: "extra/data.txt", content: "x" });
		assert.equal(through.block, true, "a write through a link into primary is a write to the primary file");
		assert.equal((await call("edit", { path: join(tree, "extra", "data.txt"), edits: [] })).block, true);
		// reading it is fine
		assert.equal(await call("read", { path: "extra/data.txt" }), undefined);
		assert.equal(await call("read", { path: join(l.ws, "a.txt") }), undefined);
	} finally {
		l.restore();
	}
});

test("a hidden path (the adapter's metadata) cannot be read; grep, find and ls are held to the read check", async () => {
	const l = await lab();
	try {
		const { call } = await inSandbox(l);
		for (const [tool, input] of [
			["read", { path: join(l.ws, ".plainvcs", "version") }],
			["grep", { pattern: "1", path: join(l.ws, ".plainvcs") }],
			["find", { pattern: "*", path: join(l.ws, ".plainvcs") }],
			["ls", { path: join(l.ws, ".plainvcs") }],
		] as const) {
			const result = await call(tool, input);
			assert.equal(result?.block, true, tool);
			assert.match(result.reason, /is hidden/);
		}
		assert.equal(await call("ls", {}), undefined, "no path: the working directory");
		assert.equal(await call("grep", { pattern: "a", path: "src" }), undefined);
		assert.equal(await call("read", { path: "name://scheme/path" }), undefined, "other schemes are not files");
	} finally {
		l.restore();
	}
});

test("always writable: xpi's agent directory, the session directory, the temp directory, scratch and the tree; never the store, the workspace or other places", async () => {
	const l = await lab();
	try {
		const { call, sessionDir } = await inSandbox(l);
		write(l.ws, "x", "");
		await l.sg(["sbx", "create", "w2"]);
		const scratch = join(l.store, "demo.sbx", "w1", "scratch");
		for (const path of [
			join(l.agentDir, "sessions", "s.jsonl"),
			join(sessionDir, "s.jsonl"),
			join(tmpdir(), "xpi-sg-int-scratch-file"),
			join(scratch, "out.o"),
		]) {
			assert.equal(await call("write", { path, content: "x" }), undefined, path);
		}
		// the store is inside the agent directory? Here it is not, and it is refused either way; so is the other sandbox
		for (const path of [
			join(l.store, "registry"),
			join(l.store, "demo.sbx", "w2", "tree", "a.txt"),
			join(l.store, "demo.git", "config"),
			"/usr/xpi-sg-not-allowed",
		]) {
			assert.equal((await call("write", { path, content: "x" })).block, true, path);
		}
		// a symlink under the temp directory that leads into the primary is a write to the primary
		const link = join(tmpdir(), `xpi-sg-int-link-${process.pid}`);
		try {
			symlinkSync(l.ws, link);
			assert.equal((await call("write", { path: join(link, "a.txt"), content: "x" })).block, true);
		} finally {
			rmSync(link, { force: true });
		}
	} finally {
		l.restore();
	}
});

test("the store is never writable, also when it is inside the agent directory (the default)", async () => {
	const l = await lab("demo", { storeInAgentDir: true });
	try {
		const { call } = await inSandbox(l);
		await l.sg(["sbx", "create", "w2"]);
		assert.equal(await call("write", { path: join(l.agentDir, "sessions", "s.jsonl"), content: "x" }), undefined);
		assert.equal(await call("write", { path: join(l.agentDir, "settings.json"), content: "{}" }), undefined);
		for (const path of [
			join(l.store, "registry"),
			join(l.store, "demo.git", "hooks", "pre-commit"),
			join(l.store, "demo.sbx", "w2", "tree", "a.txt"),
			join(l.store, "demo.sbx", "w2", "scratch", "x"),
		]) {
			assert.equal((await call("write", { path, content: "x" })).block, true, path);
		}
		// its own tree is inside the store and stays writable
		assert.equal(
			await call("write", { path: join(l.store, "demo.sbx", "w1", "tree", "a.txt"), content: "x" }),
			undefined,
		);
	} finally {
		l.restore();
	}
});

test("bash in a sandbox: the same block list; the paragraph says whose sandbox it is and that the primary is read-only", async () => {
	const l = await lab();
	try {
		const { api, c, call } = await inSandbox(l);
		assert.equal((await call("bash", { command: "xpi sg import" })).block, true);
		assert.equal((await call("bash", { command: "sg-adapter-plain update" })).block, true);
		assert.equal(await call("bash", { command: "xpi sg status" }), undefined);
		assert.equal(await call("bash", { command: "git commit -am work" }), undefined);
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await api.emit("before_agent_start", event, c.ctx);
		const text = event.systemPromptOptions.sections["shadow-git"];
		assert.match(text, /You are in shadow-git sandbox demo\/w1/);
		assert.match(text, /primary workspace .* is read-only/);
		assert.match(text, /commits on branch sbx\/w1/);
		assert.match(text, /Never call the host VCS/);
		assert.match(text, /bash is not sandboxed/, "policy backend: bash is advisory");
	} finally {
		l.restore();
	}
});

test("a sandbox that cannot be opened blocks every tool call", async () => {
	const l = await lab();
	try {
		process.env.XPI_SG_SANDBOX = "demo/missing";
		const api = fakeApi();
		createShadowGitExtension()(api.pi);
		const c = fakeCtx(l.ws);
		const result = await api.emit(
			"tool_call",
			{ type: "tool_call", toolName: "read", input: { path: "a.txt" } },
			c.ctx,
		);
		assert.equal(result.block, true);
		assert.match(result.reason, /XPI_SG_SANDBOX=demo\/missing cannot be opened/);
	} finally {
		l.restore();
	}
});
