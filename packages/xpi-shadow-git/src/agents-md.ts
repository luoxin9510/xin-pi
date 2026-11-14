// The AGENTS.md template for a shadow-git workspace: what an agent needs to know that the extension's prompt does not
// say (how to commit for the host, where output goes, what to fill in for this workspace). `xpi sg init --agents-md`
// writes it into the workspace as a local-only file; `xpi sg agents-md` prints it (for CLAUDE.md or other tools).

export const AGENTS_MD_FILE = "AGENTS.md";

export const AGENTS_MD_TEMPLATE = `# Working in this workspace

<!-- Written by \`xpi sg init --agents-md\`. shadow-git tracks this file but never exports it to the host VCS
(it is a local-only path). Edit it freely; the HTML comments are notes for you and can be deleted. -->

This directory is owned by a host version control system that is not git. A private, local-only git history
(shadow-git) sits on top of it, outside the directory. Use git for your work; leave the host VCS to the user.

## Rules

- Never run the host VCS to change anything: no check-ins, locks, updates, adds or deletes. Reading its status is fine.
  <!-- List this host VCS's write commands here, and add a regex for each to \`shadow.blockCommand\`
  (\`xpi sg config --add shadow.blockCommand '<regex>'\`) so xpi blocks them. -->
- Use git as usual: \`git status\`, \`git diff\`, \`git log\` and \`git commit\` reach the shadow repo. In xpi this is set up
  for you; in other tools run \`eval "$(xpi sg env)"\` first.
- Never run \`xpi sg import\`, \`xpi sg merge\` or \`xpi sg export --apply\`. They change the primary workspace or the host
  and are the user's to run.
- \`xpi sg export\` (without \`--apply\`) prints what is pending for the host. Use it to tell the user what would be
  checked in.
- Say \`xpi sg\`, never a bare \`sg\` (that is a different system command on Linux).

## Commits

- Commit small, one change per commit.
- Write each subject as a check-in comment for the host: \`xpi sg export --apply\` joins the subjects of the pending
  commits into the host check-in message.
- Do not commit build or test output. Write it to the scratch paths listed below.

## In a sandbox

When \`XPI_SG_SANDBOX\` is set you are in a sandbox:

- Your work counts only as commits on your branch \`sbx/<id>\`. Uncommitted changes are not merged.
- The primary workspace is read-only to you. Shared files outside your tree are read through links; do not try to
  write them.
- When you are done, commit and stop. The user merges your branch with \`xpi sg merge\`.

## This workspace

<!-- Fill these in for this workspace. -->

- Build: <!-- the command, and where it writes -->
- Tests: <!-- the command, and where it writes -->
- Scratch paths (output goes here): <!-- e.g. build/, out/ -->
- Shared paths that must not change: <!-- e.g. a shared library or test suite -->
`;
