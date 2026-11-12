// A process of the watcher tests (team.test.ts): a team whose watcher and poll run, in one of three scenarios, printing how
// many passes over the mailboxes ran. Run in its own process because a watcher that feeds on itself starves the event loop
// of the test that hosts it (found on Linux, where inotify reports the files a pass writes): the parent kills this process
// on a timer, so a regression fails instead of hanging the run.

import { emptyUsage } from "../../../src/extensions/subagent/runner.ts";
import { appendEntry, inboxFile, newEntryId } from "../../../src/extensions/subagent/team-files.ts";
import { settle, stubTeam } from "./team-helpers.ts";

const scenario = process.argv[2];
const t = stubTeam(`sess-${scenario}`);
const out: Record<string, unknown> = {};
t.team.start();

if (scenario === "empty-mailbox") {
	t.team.addMember("a", "a-id", "general-purpose", "idle");
	await t.say("a", "lead", "one"); // delivered; the mailbox stays as an empty array
	await t.say("lead", "a", "wake");
	await settle(1500);
	out.toLead = t.toLead.length;
} else if (scenario === "refused-steer") {
	// the child settled but has not exited: it takes no command. The message must wait, not be taken and put back again
	t.team.addMember("a", "a-id", "general-purpose", "running");
	const child = t.child("a");
	child.accept = false;
	await t.say("lead", "a", "hello");
	await settle(1500);
	out.passesWhileRefused = t.team.passes;
	out.attempts = child.attempts;
	// its exchange ends: the message is delivered as a new exchange
	await t.team.exchangeEnded("a", {
		run: { status: "completed", output: "x", usage: emptyUsage(), turns: 1, durationMs: 1, aborted: false },
	});
	await settle(400);
	out.wakes = t.wakes.length;
	out.prompt = t.wakes[0]?.prompt() ?? "";
	t.team.beginClose();
	console.log(JSON.stringify(out));
	process.exit(0);
} else if (scenario === "rewrite-without-input") {
	// a pass that rewrites a mailbox with nothing new, by a path nothing notes: passes must still not chain
	t.team.addMember("a", "a-id", "general-purpose", "idle");
	await appendEntry(inboxFile(t.team.dir, "a"), {
		id: newEntryId(),
		from: "lead",
		to: "a",
		text: "x",
		kind: "message",
		at: 1,
	});
	const { readFileSync, writeFileSync, renameSync } = await import("node:fs");
	const file = inboxFile(t.team.dir, "lead");
	writeFileSync(file, "[]");
	const pass = (t.team as unknown as { drainStrays: () => Promise<void> }).drainStrays;
	(t.team as unknown as { drainStrays: () => Promise<void> }).drainStrays = async function (this: unknown) {
		writeFileSync(`${file}.tmp2`, readFileSync(file));
		renameSync(`${file}.tmp2`, file); // a rewrite with the same content, every pass
		return pass.call(this);
	};
	await settle(1500);
	out.passesWhileRewriting = t.team.passes;
	// the forced rewrites stop: from here only the poll may run passes (about one a second)
	(t.team as unknown as { drainStrays: () => Promise<void> }).drainStrays = pass;
	await settle(300);
	const quiet = t.team.passes;
	await settle(2200);
	out.passesWhenQuiet = t.team.passes - quiet;
}
t.team.beginClose();
out.passes = t.team.passes;
console.log(JSON.stringify(out));
process.exit(0);
