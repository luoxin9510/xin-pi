// A process of the exit test (extension.test.ts): starts a session in the workspace given as argument, prints its pid and
// exits with no shutdown event. The extension's exit hook has to remove the live-session entry.
import { createShadowGitExtension } from "../../../src/extensions/shadow-git/index.ts";
import { fakeApi, fakeCtx } from "./lab.ts";

const api = fakeApi();
createShadowGitExtension({ cwd: process.argv[2] })(api.pi);
await api.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(process.argv[2]).ctx);
console.log(process.pid);
