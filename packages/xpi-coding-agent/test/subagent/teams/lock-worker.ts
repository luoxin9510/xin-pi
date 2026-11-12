// A process of the lock test (files.test.ts): waits for the start time, then takes the lock `rounds` times. Inside the
// lock it logs enter/exit lines and bumps a counter file; with exclusion the log alternates enter, exit.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { withLock } from "../../../src/extensions/subagent/team-files.ts";

const [file, log, counter, startAt, rounds] = process.argv.slice(2) as [string, string, string, string, string];
while (Date.now() < Number(startAt)) await new Promise((r) => setTimeout(r, 1));
for (let i = 0; i < Number(rounds); i++) {
	await withLock(file, async () => {
		appendFileSync(log, `enter ${process.pid}\n`);
		const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
		await new Promise((r) => setTimeout(r, 5));
		writeFileSync(counter, String(n + 1));
		appendFileSync(log, `exit ${process.pid}\n`);
	});
}
