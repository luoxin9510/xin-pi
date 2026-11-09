// Child session directories, the agent meta file, and agent ids (spec 5, Sessions).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ParentContext } from "./resolve.ts";
import type { WorktreeRef } from "./worktree.ts";

type SessionRef = Pick<ParentContext, "sessionFile" | "sessionId">;

export function subagentSessionDir(parent: SessionRef): string {
	return join(dirname(parent.sessionFile!), "subagents", parent.sessionId);
}

// Written next to the child session by the registry (src/registry.ts), so a resume knows which agent it was.
function agentMetaFile(parent: ParentContext, agentId: string): string {
	return join(subagentSessionDir(parent), `${agentId}.json`);
}

// What a resumable run was started with: its agentType and the worktree it ran in, if isolated. Throws for anything that
// cannot be resumed.
export function storedAgent(parent: ParentContext, resume: string): { agentType: string; worktree?: WorktreeRef } {
	if (!/^[A-Za-z0-9._-]+$/.test(resume) || /^\.+$/.test(resume)) throw new Error(`invalid resume id "${resume}"`);
	if (!parent.sessionFile) throw new Error("resume needs a persisted parent session");
	const file = agentMetaFile(parent, resume);
	if (!existsSync(file)) throw new Error(`no subagent session "${resume}" to resume`);
	return JSON.parse(readFileSync(file, "utf8"));
}

export function newAgentId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	return [...randomBytes(12)].map((b) => alphabet[b % alphabet.length]).join("");
}

export const RESULT_LIMIT = 8000; // bytes (UTF-8)

// Text for a message to main: as is up to RESULT_LIMIT bytes, else the first RESULT_LIMIT bytes (cut at a character
// boundary) plus the path of a file holding all of it (the parent session's subagents dir; a temp dir for an in-memory
// session).
export function capText(text: string, parent: SessionRef, name: string): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= RESULT_LIMIT) return text;
	const dir = parent.sessionFile ? subagentSessionDir(parent) : mkdtempSync(join(tmpdir(), "subagent-"));
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${name}-${Date.now()}.txt`);
	writeFileSync(file, text);
	let end = RESULT_LIMIT;
	while ((bytes[end] & 0xc0) === 0x80) end--; // not in the middle of a multibyte character
	return `${bytes.subarray(0, end).toString("utf8")}\n... (cut, ${bytes.length} bytes; all of it is in ${file})`;
}
