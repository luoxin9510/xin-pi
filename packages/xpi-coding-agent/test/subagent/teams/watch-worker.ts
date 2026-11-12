// A process of the watcher test (team.test.ts): a team that has delivered a message, left alone for a while. Prints how many
// passes over the mailboxes ran. Run in its own process because a run-away watcher starves the event loop of the test that
// hosts it (found on Linux, where inotify reports the lock files a pass creates): the parent kills this process on a timer.
import { settle, stubTeam } from "./team-helpers.ts";

const t = stubTeam("sess-nospin");
t.team.addMember("a", "a-id", "general-purpose", "idle");
t.team.start();
await t.say("a", "lead", "one"); // delivered; the mailbox stays as an empty array
await t.say("lead", "a", "wake");
await settle(1500);
t.team.beginClose();
console.log(JSON.stringify({ passes: t.team.passes, toLead: t.toLead.length }));
process.exit(0);
