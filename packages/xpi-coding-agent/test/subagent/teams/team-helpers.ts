// Shared by the team tests: a team with a stub host, mailbox shortcuts and a fake running child.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import type { ParentContext } from "../../../src/extensions/subagent/resolve.ts";
import { type Member, Team, type TeamHost } from "../../../src/extensions/subagent/team.ts";
import { readTeamSettings } from "../../../src/extensions/subagent/team-config.ts";
import { appendEntry, type EntryKind, inboxFile, newEntryId } from "../../../src/extensions/subagent/team-files.ts";

export const parent = (sessionId: string): ParentContext => ({
	cwd: tmpdir(),
	thinking: "off",
	trusted: true,
	sessionId,
});

export interface Stub {
	team: Team;
	toLead: string[];
	warns: string[];
	wakes: { name: string; prompt: () => string; finish: () => void; fail: (e: Error) => void }[];
	root: string;
	say(from: string, to: string, text: string, kind?: EntryKind, extra?: object): Promise<void>;
	// A member that runs: a record in the registry with a fake child that takes the commands it is sent.
	child(name: string): {
		id: string;
		sent: { type: string; message?: string }[];
		accept: boolean;
		take(text: string): void;
	};
}

export function stubTeam(sessionId: string, overrides: Partial<TeamHost> = {}): Stub {
	const root = mkdtempSync(join(tmpdir(), "team-root-"));
	const toLead: string[] = [];
	const warns: string[] = [];
	const wakes: Stub["wakes"] = [];
	const host: TeamHost = {
		settings: readTeamSettings({ enabled: true }),
		parent: () => parent(sessionId),
		toLead: (content) => {
			toLead.push(content);
			return true;
		},
		warn: (m) => warns.push(m),
		wake: (member: Member, prompt: () => string) =>
			new Promise<void>((resolve, reject) =>
				wakes.push({ name: member.name, prompt, finish: resolve, fail: reject }),
			),
		...overrides,
	};
	const team = new Team(sessionId, host, root);
	return {
		team,
		toLead,
		warns,
		wakes,
		root,
		async say(from, to, text, kind = "message", extra = {}) {
			await appendEntry(inboxFile(team.dir, to), {
				id: newEntryId(),
				from,
				to,
				text,
				kind,
				at: Date.now(),
				...extra,
			});
		},
		child(name) {
			const id = `${name}-id`;
			const sent: { type: string; message?: string }[] = [];
			const state = { id, sent, accept: true, take: (_text: string) => {} };
			registry.begin(parent(sessionId), {
				id,
				type: "general-purpose",
				name,
				description: "d",
				model: "m",
				thinking: "off",
			});
			registry.attach(id, {
				send: (command) => {
					if (!state.accept) return false;
					sent.push(command as { type: string; message?: string });
					return true;
				},
				setModel: async () => undefined,
			});
			state.take = (text) => registry.event(id, { type: "message_end", message: { role: "user", content: text } });
			return state;
		},
	};
}

export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
