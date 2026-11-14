/** The prompt paragraphs `builtin:shadow-git` adds (one section, the same every turn). */

import type { Backend } from "xpi-shadow-git";

export const PRIMARY_PROMPT = (workspace: string): string =>
	[
		`A host version control system owns the workspace ${workspace}. git works on a private shadow repository over it (GIT_DIR and GIT_WORK_TREE are set), so use git as usual for diffs, commits and branches.`,
		"Never call the host VCS to write (no check-in, update or sync commands), and never run sg-adapter-* programs: importing from and exporting to the host is the user's job.",
		"`xpi sg export` shows the user what is pending. Always write `xpi sg`, never bare `sg` (a different program on some systems).",
	].join("\n");

export const SANDBOX_PROMPT = (ref: string, id: string, workspace: string, backend: Backend): string =>
	[
		`You are in shadow-git sandbox ${ref}. The primary workspace ${workspace} is read-only: your files are private copies in your working tree.`,
		`Your work only counts as commits on branch sbx/${id}: commit it with git. The user merges it with /sg merge sbx/${id}. Never call the host VCS.`,
		backend === "namespace"
			? "The primary workspace is mounted read-only under your command line too."
			: "bash is not sandboxed here, so write only inside your working tree, the sandbox scratch area and temp directories; the file tools refuse other writes.",
		"Always write `xpi sg`, never bare `sg`.",
	].join("\n");
