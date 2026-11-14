// Runs `xpi sg <args>` in this process's cwd. The namespace tests start it inside a user namespace they made.
import { runSg } from "../src/index.ts";

process.exitCode = await runSg(process.argv.slice(2), { cwd: process.cwd() });
