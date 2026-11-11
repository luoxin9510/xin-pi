export const meta = {
  name: "review",
  description: "Review a diff with parallel read-only reviewers and one verifier. /review [branch | commit | #PR]; no argument reviews the uncommitted changes.",
  phases: ["diff", "review", "verify"],
}

// Built-in workflow `/review [target]`. The target is the working tree against HEAD (no argument), a branch (its
// merge-base diff against HEAD), a commit, or `#N` for a GitHub pull request (needs `gh`).
//
// The part between BEGIN helpers and END helpers is pure (no tools, no agents): test/subagent/review-workflow.test.ts
// evaluates exactly that text, so the helpers have one source. A workflow file cannot import anything.

// BEGIN helpers
const PRIORITIES = ["P0", "P1", "P2", "P3"]

// Files nobody reviews: lockfiles, generated and minified output, build directories, snapshots, binaries.
const SKIP = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|go\.sum|flake\.lock|uv\.lock|mix\.lock|Podfile\.lock|pubspec\.lock)$/,
  /\.lock$/,
  /\.min\.[^/]+$/,
  /\.map$/,
  /\.generated\./,
  /\.snap$/,
  /(^|\/)__snapshots__\//,
  /(^|\/)(dist|build|out|node_modules|vendor|\.next|coverage)\//,
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|avif|svg|pdf|mp[34]|mov|wav|webm)$/i,
  /\.(woff2?|ttf|otf|eot)$/i,
  /\.(zip|tar|gz|tgz|bz2|xz|7z|rar|jar|war|wasm)$/i,
]

const isSkipped = (path) => SKIP.some((re) => re.test(path))

const REF = /^[\w.\/@~^{}+-]+$/

// What follows `/review`: undefined or "" is the working tree; `#N` a pull request; a name or sha is a ref, whose
// kind (branch or commit) the script finds out with git.
function parseTarget(input) {
  if (input === undefined || input === null) return { kind: "worktree" }
  if (typeof input !== "string" && typeof input !== "number") {
    return { error: "the target must be a branch, a commit or #N, not " + JSON.stringify(input) }
  }
  const text = String(input).trim()
  if (text === "") return { kind: "worktree" }
  const pr = /^#(\d+)$/.exec(text)
  if (pr) return { kind: "pr", number: pr[1] }
  if (text.startsWith("-") || !REF.test(text)) return { error: "not a branch, commit or #N: " + text }
  return { kind: "ref", ref: text }
}

const sq = (text) => "'" + text.replace(/'/g, "'\\''") + "'"

// Split a unified diff into one entry per file: path, changed line counts, binary or not, and its own text.
function splitDiff(text) {
  const files = []
  for (const part of text.split(/^(?=diff --git )/m)) {
    if (!part.startsWith("diff --git ")) continue
    const lines = part.split("\n")
    let renamed = null
    let to = null
    let from = null
    let added = 0
    let removed = 0
    let hunk = false
    for (const line of lines) {
      if (hunk) {
        if (line.startsWith("+")) added++
        else if (line.startsWith("-")) removed++
      } else if (line.startsWith("@@")) hunk = true
      else if (line.startsWith("rename to ")) renamed = line.slice(10)
      else if (line.startsWith("+++ b/")) to = line.slice(6).replace(/\t.*$/, "")
      else if (line.startsWith("--- a/")) from = line.slice(6).replace(/\t.*$/, "")
    }
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0])
    const path = renamed ?? to ?? from ?? (header ? header[2] : null)
    if (path === null) continue
    const binary = /^(Binary files .* differ|GIT binary patch)$/m.test(part)
    files.push({ path, added, removed, lines: Math.max(1, added + removed), binary, text: part })
  }
  return files
}

// How many reviewers a change gets, never more than it has files.
function reviewerCount(fileCount, changedLines) {
  const n = changedLines < 100 || fileCount <= 2 ? 1 : changedLines < 500 ? 2 : changedLines < 2000 ? 4 : 8
  return Math.max(1, Math.min(n, fileCount))
}

const isTest = (path) =>
  /(^|\/)(tests?|__tests__|specs?)\//.test(path) || /\.(test|spec)\.[^/.]+$/.test(path) || /(^|\/)test_[^/]*$/.test(path) || /_test\.[^/.]+$/.test(path)

const stemOf = (path) =>
  path.replace(/^.*\//, "").replace(/\.[^.]*$/, "").replace(/\.(test|spec)$/, "").replace(/_test$/, "").replace(/^test_/, "")

const dirOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf("/")))

// Split files into at most `n` groups of about equal changed lines. A test file joins the implementation with the same
// base name (same directory first); units are ordered by path, so files of one directory stay together.
function groupFiles(files, n) {
  const units = []
  const byStem = new Map()
  for (const f of files) {
    if (isTest(f.path)) continue
    const unit = { key: f.path, lines: f.lines, files: [f] }
    units.push(unit)
    const stem = stemOf(f.path)
    byStem.set(stem, [...(byStem.get(stem) ?? []), unit])
  }
  for (const f of files) {
    if (!isTest(f.path)) continue
    const candidates = byStem.get(stemOf(f.path)) ?? []
    const unit = candidates.find((u) => dirOf(u.key) === dirOf(f.path)) ?? candidates[0]
    if (unit) {
      unit.files.push(f)
      unit.lines += f.lines
    } else units.push({ key: f.path, lines: f.lines, files: [f] })
  }
  units.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const total = units.reduce((sum, u) => sum + u.lines, 0)
  const groups = Array.from({ length: n }, () => [])
  let before = 0
  for (const u of units) {
    groups[Math.min(n - 1, Math.floor(((before + u.lines / 2) / total) * n))].push(...u.files)
    before += u.lines
  }
  return groups.filter((g) => g.length > 0)
}

// The command that prints the diff of `files` (all of the change when `files` is empty).
function diffCommand(target, files) {
  const git = "git -c core.quotepath=false --literal-pathspecs"
  if (target.kind === "pr") return "gh pr diff " + target.number + " --color=never"
  const paths = (list) => (list.length > 0 ? " -- " + list.map((f) => sq(f.path)).join(" ") : "")
  if (target.kind === "worktree") {
    const tracked = files.filter((f) => !f.untracked)
    const fresh = files.filter((f) => f.untracked)
    const commands = []
    if (files.length === 0 || tracked.length > 0) commands.push(git + " diff HEAD --no-color --no-ext-diff" + paths(tracked))
    for (const f of fresh) commands.push(git + " diff --no-index --no-color --no-ext-diff -- /dev/null " + sq(f.path))
    return commands.join("; ")
  }
  if (target.kind === "branch") return git + " diff " + sq(target.ref + "...HEAD") + " --no-color --no-ext-diff" + paths(files)
  return git + " show --format= --no-color --no-ext-diff " + sq(target.ref) + paths(files)
}

const ranked = (findings) =>
  [...findings].sort(
    (a, b) =>
      PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) ||
      b.confidence - a.confidence ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.lineStart - b.lineStart,
  )

function formatFinding(n, f) {
  const lines = f.lineEnd > f.lineStart ? f.lineStart + "-" + f.lineEnd : String(f.lineStart)
  const body = String(f.body).trim().replace(/\n/g, "\n   ")
  return n + ". [" + f.priority + "] " + f.title + " — " + f.file + ":" + lines + "\n   " + body + "\n   Confidence: " + f.confidence
}

// The result text: findings first, then what was not reviewed or went wrong.
function formatResult(r) {
  const out = ["Review of " + r.label]
  const found = ranked(r.findings)
  if (found.length === 0) out.push("No findings.")
  else out.push(found.map((f, i) => formatFinding(i + 1, f)).join("\n\n"))
  const notes = []
  if (r.verifierFailed) notes.push("Verifier failed: these findings are unverified.")
  else if (r.dropped.length > 0) {
    notes.push("Dropped by the verifier: " + r.dropped.length)
    for (const d of r.dropped) notes.push("  - " + d.title + ": " + d.reason)
  }
  if (r.skipped.length > 0) notes.push("Skipped files (" + r.skipped.length + "): " + r.skipped.join(", "))
  notes.push("Reviewers: " + r.reviewers + (r.failed.length > 0 ? ", failed: " + r.failed.join(", ") : ""))
  out.push(notes.join("\n"))
  return out.join("\n\n")
}

const FINDING = {
  type: "object",
  required: ["title", "body", "priority", "confidence", "file", "lineStart", "lineEnd"],
  properties: {
    title: { type: "string", description: "One line naming the bug" },
    body: { type: "string", description: "What goes wrong, the input or path that triggers it, and why the change causes it" },
    priority: { type: "string", enum: PRIORITIES },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    file: { type: "string", description: "Path as it appears in the diff" },
    lineStart: { type: "integer", description: "First line in the new version of the file" },
    lineEnd: { type: "integer", description: "Last line in the new version of the file" },
  },
}

const FINDINGS_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: { findings: { type: "array", items: FINDING } },
}

const VERIFIED_SCHEMA = {
  type: "object",
  required: ["findings", "dropped"],
  properties: {
    findings: { type: "array", items: FINDING, description: "The findings you confirmed, duplicates merged" },
    dropped: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "reason"],
        properties: { title: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
}

const INLINE_MAX = 30000

function reviewPrompt(label, target, group, index, count, all) {
  const list = group.map((f) => "- " + f.path + (f.untracked ? " (new, untracked)" : "") + " (+" + f.added + " -" + f.removed + ")").join("\n")
  const diff = group.map((f) => f.text).join("")
  const where = target.kind === "worktree" ? "the working tree" : target.kind === "pr" ? "the pull request" : "the revision"
  const how =
    diff.length <= INLINE_MAX
      ? "The diff of your files:\n\n" + diff
      : "The diff of your files is too long to paste. Print it with:\n" + diffCommand(target, group) +
        (target.kind === "pr" ? "\nThat prints the whole pull request; read only your files' sections." : "")
  return [
    "Review " + label + ". You are reviewer " + (index + 1) + " of " + count + "; each reviewer has its own files, and yours are:",
    list,
    all > group.length ? "The rest of the change goes to the other reviewers. Read their files only to trace how a changed value is used." : "",
    "Report bugs this change introduces in your files, as the structured result. Use line numbers of the new version of a file (the +start in the hunk headers). The files on disk may not be exactly " + where + " (for a commit or a pull request the checkout can differ); when it matters, read a file as of the revision with git show.",
    how,
  ]
    .filter((p) => p !== "")
    .join("\n\n")
}

function verifyPrompt(label, target, findings, files) {
  const command = diffCommand(target, files)
  return [
    "Verify review findings for " + label + ". Other reviewers produced the findings below. For each one, read the code it points at (and the code that consumes the value it names) and decide whether it is a real bug that this change introduced.",
    "Keep a finding only when you can confirm it. You may correct its priority, confidence, line range or text. Merge findings that share one root cause into one. Drop findings you cannot confirm, that were already present before the change, or that are only style; for each dropped one give a short reason in `dropped`.",
    "Do not add findings of your own. The diff of the files involved: " + command,
    "Findings:\n" + JSON.stringify(findings, null, 1),
  ].join("\n\n")
}
// END helpers

const bash = async (command) => {
  const r = await tools.bash({ command })
  return { code: r.exit_code, out: r.output, truncated: r.truncated }
}

// Run a command and bring its whole output back. It is written to a temporary file and read in chunks, because one
// bash result is cut at 2000 lines or 50KB.
async function capture(command) {
  const made = await bash(
    't=$(mktemp) && ( ' + command + ' ) > "$t" 2> "$t.err"; rc=$?; echo "$rc"; echo "$t"; wc -l < "$t"',
  )
  const [rc, file, count] = made.out.trim().split("\n")
  const total = Number(count)
  const parts = []
  let start = 1
  let size = 800
  while (start <= total) {
    const chunk = await bash("sed -n '" + start + "," + (start + size - 1) + "p' " + sq(file))
    if (chunk.truncated && size > 10) {
      size = Math.max(10, size >> 1)
      continue
    }
    parts.push(chunk.out.replace(/\n$/, ""))
    start += size
  }
  const err = Number(rc) === 0 ? "" : (await bash("cat " + sq(file + ".err"))).out.trim()
  await bash("rm -f " + sq(file) + " " + sq(file + ".err"))
  return { code: Number(rc), text: parts.length > 0 ? parts.join("\n") + "\n" : "", err }
}

const MAX_DIFF_LINES = 60000
const GIT = "git -c core.quotepath=false"

async function load(target) {
  if (target.kind === "pr") {
    const r = await capture("gh pr diff " + target.number + " --color=never")
    if (r.code !== 0) return { error: "gh pr diff " + target.number + " failed: " + (r.err || "no output") }
    const title = await bash("gh pr view " + target.number + " --json title -q .title")
    return { diff: r.text, label: "GitHub PR #" + target.number + (title.code === 0 ? " " + title.out.trim() : "") }
  }
  const inside = await bash("git rev-parse --is-inside-work-tree")
  if (inside.code !== 0) return { error: "not inside a git repository" }
  if (target.kind === "worktree") {
    const head = await bash("git rev-parse --verify --quiet HEAD")
    if (head.code !== 0) return { error: "the repository has no commits yet, so there is nothing to compare against" }
    const tracked = await capture(GIT + " diff HEAD --no-color --no-ext-diff")
    if (tracked.code !== 0) return { error: "git diff failed: " + tracked.err }
    const names = await bash(GIT + " ls-files --others --exclude-standard")
    const untracked = names.out.split("\n").filter((n) => n !== "")
    const fresh =
      untracked.length === 0
        ? { text: "" }
        : await capture(GIT + " ls-files --others --exclude-standard -z | xargs -0 -n1 " + GIT + " diff --no-index --no-color --no-ext-diff -- /dev/null")
    return { diff: tracked.text + fresh.text, untracked, label: "the uncommitted changes (working tree against HEAD, with new files)" }
  }
  const known = await bash("git rev-parse --verify --quiet " + sq(target.ref + "^{commit}"))
  if (known.code !== 0) return { error: target.ref + " is not a branch, tag or commit of this repository" }
  const isBranch = await bash("git show-ref --verify --quiet " + sq("refs/heads/" + target.ref) + " || git show-ref --verify --quiet " + sq("refs/remotes/" + target.ref))
  if (isBranch.code === 0) {
    target.kind = "branch"
    const r = await capture(diffCommand(target, []))
    if (r.code !== 0) return { error: "git diff failed: " + r.err }
    return { diff: r.text, label: "the changes on HEAD since it left " + target.ref }
  }
  target.kind = "commit"
  const r = await capture(diffCommand(target, []))
  if (r.code !== 0) return { error: "git show failed: " + r.err }
  const subject = await bash(GIT + " log -1 --format='%h %s' " + sq(target.ref))
  return { diff: r.text, label: "commit " + subject.out.trim() }
}

phase("diff")
const target = parseTarget(args)
if (target.error) return "review: " + target.error
if (typeof tools.bash !== "function") return "review: this run has no bash tool, which /review needs to read the diff"

const loaded = await load(target)
if (loaded.error) return "review: " + loaded.error
const all = splitDiff(loaded.diff)
const untracked = new Set(loaded.untracked ?? [])
for (const f of all) if (untracked.has(f.path)) f.untracked = true
if (all.length === 0) return "review: nothing to review, the diff of " + loaded.label + " is empty"
const skipped = all.filter((f) => f.binary || isSkipped(f.path)).map((f) => f.path)
const files = all.filter((f) => !f.binary && !isSkipped(f.path))
if (files.length === 0) return "review: nothing to review, all " + all.length + " changed files are on the skip list: " + skipped.join(", ")
const changed = files.reduce((sum, f) => sum + f.lines, 0)
if (changed > MAX_DIFF_LINES) return "review: the diff has " + changed + " changed lines, too many for one review; review a narrower target"

const groups = groupFiles(files, reviewerCount(files.length, changed))
log("reviewing " + files.length + " files (" + changed + " changed lines) with " + groups.length + " reviewers")

phase("review")
const reviews = await parallel(
  groups.map((group, i) => () =>
    agent(reviewPrompt(loaded.label, target, group, i, groups.length, files.length), {
      type: "reviewer",
      label: "review " + (i + 1) + "/" + groups.length,
      schema: FINDINGS_SCHEMA,
    }),
  ),
)
const failed = []
const found = []
reviews.forEach((r, i) => {
  if (r === null || r === undefined) failed.push("reviewer " + (i + 1))
  else found.push(...r.findings)
})

const result = { label: loaded.label, findings: found, dropped: [], skipped, reviewers: groups.length, failed, verifierFailed: false }
if (found.length > 0) {
  phase("verify")
  const involved = files.filter((f) => found.some((x) => x.file === f.path))
  let verified = null
  try {
    verified = await agent(verifyPrompt(loaded.label, target, found, involved), {
      type: "reviewer",
      label: "verify",
      schema: VERIFIED_SCHEMA,
    })
  } catch (err) {
    log("verifier failed: " + err.message)
  }
  if (verified) {
    result.findings = verified.findings
    result.dropped = verified.dropped
  } else result.verifierFailed = true
}
return formatResult(result)
