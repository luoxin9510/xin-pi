// The tasks of the delegation evaluation. Each one builds a small repository, gives the model one prompt and checks
// the result from outside: the model never sees the check. The set covers work that should gain from delegation
// (wide searches, independent edits, large outputs), work that should not (a one-line fix, one deep bug, strictly
// sequential steps) and work in between.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Task {
	name: string;
	/** What we expect before measuring: which way of working should suit the task. */
	expect: "solo" | "delegate" | "relay" | "open";
	prompt: string;
	/** Time limit of one run. Default 15 minutes. */
	timeoutMs?: number;
	/** How the run is driven: print mode (`-p`, the default) or rpc mode (rpc-driver.ts), where scripts can run in the
	 * background and the way main waits for its agents is measured. */
	driver?: "print" | "rpc";
	/** Fill the empty directory `repo`. It may make it a git repository; otherwise the runner does. */
	setup(repo: string): void;
	/** Undefined: passed. A string: why not. */
	check(repo: string): string | undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function write(repo: string, path: string, text: string): void {
	const file = join(repo, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

export function read(repo: string, path: string): string | undefined {
	const file = join(repo, path);
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** Run node in the repository; the error text when it fails. */
export function node(repo: string, args: string[]): { ok: boolean; out: string } {
	try {
		const out = execFileSync("node", args, { cwd: repo, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, out: out.toString("utf8") };
	} catch (error) {
		const e = error as { stdout?: Buffer; stderr?: Buffer; message: string };
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message };
	}
}

/** Evaluate `code` (CommonJS, in the repository) and expect it to print "ok". */
export function probe(repo: string, code: string): string | undefined {
	const result = node(repo, ["-e", code]);
	if (result.ok && result.out.trim() === "ok") return undefined;
	return result.out.trim().split("\n").slice(-3).join(" | ").slice(0, 300) || "the check printed nothing";
}

const hash = (text: string | undefined) =>
	text === undefined ? "missing" : createHash("sha1").update(text).digest("hex");

export function unchanged(repo: string, files: Record<string, string>): string | undefined {
	for (const [path, text] of Object.entries(files)) {
		if (hash(read(repo, path)) !== hash(text)) return `${path} was changed or removed`;
	}
	return undefined;
}

/** A deterministic pseudo-random sequence, so every run sees the same repository. */
export function sequence(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

// ---------------------------------------------------------------------------------------------- 1. call sites

const CALLERS = [3, 7, 8, 15, 19, 22, 28, 31, 36];

function callSiteFile(index: number): string {
	const name = `m${pad(index)}`;
	const lines = [`// ${name}: part of the sync client`, `const { log } = require("./lib/log");`];
	if (CALLERS.includes(index) || index === 17) lines.push(`const { legacyFetch } = require("./lib/legacy");`);
	if (index === 11) lines.push(`const { legacyFetchAll } = require("./lib/legacy");`);
	lines.push("", `function ${name}Load(url, options) {`, `\tlog("${name} load " + url);`);
	if (CALLERS.includes(index)) {
		const forms = [
			"\treturn legacyFetch(url, options);",
			"\tconst pending = legacyFetch (url);\n\treturn pending;",
			"\treturn Promise.resolve().then(() => legacyFetch(url));",
			"\treturn legacyFetch(\n\t\turl,\n\t\toptions,\n\t);",
		];
		lines.push(forms[index % forms.length]!);
	} else if (index === 5) {
		lines.push("\t// legacyFetch(url) was removed here in favour of fetchNext", "\treturn fetchNext(url, options);");
	} else if (index === 11) {
		lines.push("\treturn legacyFetchAll([url]);");
	} else if (index === 25) {
		lines.push('\tlog("use legacyFetch(url) only for old servers");', "\treturn fetchNext(url, options);");
	} else {
		lines.push("\treturn fetchNext(url, options);");
	}
	lines.push("}", "", "function fetchNext(url, options) {", "\treturn { url, options, next: true };", "}", "");
	lines.push(`module.exports = { ${name}Load };`, "");
	return lines.join("\n");
}

const callSites: Task = {
	name: "call sites in 40 files",
	expect: "delegate",
	prompt:
		"List every file under src/ that calls the function legacyFetch. Count real calls only: not comments, not strings, not imports without a call, not other functions with similar names, and not the file that defines it. Write the paths relative to the repository root (like src/m01.js), sorted, one per line, to answer.txt.",
	setup(repo) {
		for (let i = 1; i <= 40; i++) write(repo, `src/m${pad(i)}.js`, callSiteFile(i));
		write(repo, "src/lib/log.js", "exports.log = (line) => line;\n");
		write(
			repo,
			"src/lib/legacy.js",
			"function legacyFetch(url) {\n\treturn { url, legacy: true };\n}\nconst legacyFetchAll = (urls) => urls.map((url) => ({ url }));\nmodule.exports = { legacyFetch, legacyFetchAll };\n",
		);
	},
	check(repo) {
		const answer = read(repo, "answer.txt");
		if (answer === undefined) return "answer.txt is missing";
		const got = answer
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.sort();
		const want = CALLERS.map((index) => `src/m${pad(index)}.js`);
		const missing = want.filter((file) => !got.includes(file));
		const extra = got.filter((file) => !want.includes(file));
		if (missing.length + extra.length === 0) return undefined;
		return `missing: ${missing.join(" ") || "-"}; extra: ${extra.join(" ") || "-"}`;
	},
};

// ---------------------------------------------------------------------------------------------- 2. six modules

const MODULES: Record<string, { source: string; test: string }> = {
	a: {
		source: "exports.sum = (list) => list.reduce((total, n) => total + n, 1);\n",
		test: 'const { sum } = require("../mod/a");\nconst assert = require("node:assert");\nassert.strictEqual(sum([1, 2, 3]), 6);\nassert.strictEqual(sum([]), 0);\n',
	},
	b: {
		source: "exports.clamp = (x, lo, hi) => Math.min(lo, Math.max(x, hi));\n",
		test: 'const { clamp } = require("../mod/b");\nconst assert = require("node:assert");\nassert.strictEqual(clamp(5, 0, 3), 3);\nassert.strictEqual(clamp(-2, 0, 3), 0);\nassert.strictEqual(clamp(2, 0, 3), 2);\n',
	},
	c: {
		source: "exports.capitalize = (text) => text.charAt(0).toLowerCase() + text.slice(1);\n",
		test: 'const { capitalize } = require("../mod/c");\nconst assert = require("node:assert");\nassert.strictEqual(capitalize("hello"), "Hello");\nassert.strictEqual(capitalize(""), "");\n',
	},
	d: {
		source: "exports.unique = (list) => list.filter((item, index) => list.indexOf(item) !== index);\n",
		test: 'const { unique } = require("../mod/d");\nconst assert = require("node:assert");\nassert.deepStrictEqual(unique([1, 2, 2, 3, 1]), [1, 2, 3]);\n',
	},
	e: {
		source:
			"exports.range = (n) => {\n\tconst out = [];\n\tfor (let i = 0; i <= n; i++) out.push(i);\n\treturn out;\n};\n",
		test: 'const { range } = require("../mod/e");\nconst assert = require("node:assert");\nassert.deepStrictEqual(range(3), [0, 1, 2]);\nassert.deepStrictEqual(range(0), []);\n',
	},
	f: {
		source: "exports.isEven = (n) => n % 2 === 1;\n",
		test: 'const { isEven } = require("../mod/f");\nconst assert = require("node:assert");\nassert.strictEqual(isEven(4), true);\nassert.strictEqual(isEven(7), false);\nassert.strictEqual(isEven(-2), true);\n',
	},
};

const RUN_TESTS = `const { execFileSync } = require("node:child_process");
let failed = 0;
for (const name of ["a", "b", "c", "d", "e", "f"]) {
	try {
		execFileSync("node", ["test/" + name + ".test.js"], { stdio: "pipe" });
		console.log("ok   " + name);
	} catch (error) {
		failed++;
		console.log("FAIL " + name + ": " + String(error.stderr).split("\\n").find((line) => line.includes("Error")));
	}
}
process.exit(failed ? 1 : 0);
`;

const sixModules: Task = {
	name: "six independent modules",
	expect: "delegate",
	prompt:
		"`node run-tests.js` fails. Fix the modules in mod/ so that it passes. Do not edit the tests or run-tests.js.",
	setup(repo) {
		for (const [name, files] of Object.entries(MODULES)) {
			write(repo, `mod/${name}.js`, files.source);
			write(repo, `test/${name}.test.js`, files.test);
		}
		write(repo, "run-tests.js", RUN_TESTS);
	},
	check(repo) {
		const tests = Object.fromEntries(
			Object.entries(MODULES).map(([name, files]) => [`test/${name}.test.js`, files.test]),
		);
		const changed = unchanged(repo, { ...tests, "run-tests.js": RUN_TESTS });
		if (changed) return changed;
		const result = node(repo, ["run-tests.js"]);
		return result.ok
			? undefined
			: result.out
					.split("\n")
					.filter((line) => line.startsWith("FAIL"))
					.join("; ");
	},
};

// ---------------------------------------------------------------------------------------------- 3. a long log

function buildLog(): { text: string; first: string } {
	const random = sequence(7);
	const total = 3000;
	const kinds = new Map<number, string>();
	const place = (code: string, count: number, level: string) => {
		for (let placed = 0; placed < count; ) {
			const line = Math.floor(random() * total);
			if (kinds.has(line)) continue;
			kinds.set(line, `${level} code=${code}`);
			placed++;
		}
	};
	place("E207", 52, "ERROR");
	place("E330", 41, "ERROR");
	place("E101", 37, "ERROR");
	place("E412", 18, "ERROR");
	place("E330", 30, "WARN");
	const lines: string[] = [];
	let first = "";
	const start = Date.UTC(2026, 2, 1);
	for (let i = 0; i < total; i++) {
		const stamp = new Date(start + i * 7000).toISOString().replace(".000Z", "Z");
		const kind = kinds.get(i);
		if (kind?.startsWith("ERROR code=E207") && !first) first = stamp;
		const id = Math.floor(random() * 90000) + 10000;
		lines.push(
			kind
				? `${stamp} ${kind} request=${id} ${kind.startsWith("WARN") ? "recovered after retry" : "upstream failed"}`
				: `${stamp} INFO request=${id} served in ${Math.floor(random() * 400)} ms`,
		);
	}
	return { text: `${lines.join("\n")}\n`, first };
}

const longLog: Task = {
	name: "digest of a 3000-line log",
	expect: "delegate",
	prompt:
		'In app.log, look at the ERROR lines only (WARN lines do not count). Which error code occurs most often, how many times, and what is the timestamp of its first occurrence? Write {"code": "...", "count": N, "first": "..."} to answer.json.',
	setup(repo) {
		write(repo, "app.log", buildLog().text);
	},
	check(repo) {
		const answer = read(repo, "answer.json");
		if (answer === undefined) return "answer.json is missing";
		try {
			const got = JSON.parse(answer) as { code?: unknown; count?: unknown; first?: unknown };
			const want = { code: "E207", count: 52, first: buildLog().first };
			if (got.code === want.code && Number(got.count) === want.count && got.first === want.first) return undefined;
			return `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
		} catch {
			return "answer.json is not JSON";
		}
	},
};

// ---------------------------------------------------------------------------------------------- 4. scattered facts

const scatteredFacts: Task = {
	name: "three facts in three places",
	expect: "delegate",
	prompt:
		"For the sync client: the retry count is in a JSON config file, the backoff between retries is stated in the operations documentation, and the request timeout is a constant in the networking code. Compute retries x backoff (ms) + timeout (ms) and write the number alone to answer.txt.",
	setup(repo) {
		for (let i = 1; i <= 12; i++) {
			write(
				repo,
				`config/service-${pad(i)}.json`,
				`${JSON.stringify({ name: `service-${i}`, port: 8000 + i, workers: (i % 4) + 1 }, null, 2)}\n`,
			);
			write(
				repo,
				`docs/notes-${pad(i)}.md`,
				`# Notes ${i}\n\nService ${i} is restarted every ${i + 3} days. Nothing here concerns the sync client.\n`,
			);
			write(
				repo,
				`src/net/helper${pad(i)}.js`,
				`// helper ${i}\nconst BUFFER_BYTES = ${1024 * i};\nmodule.exports = { BUFFER_BYTES };\n`,
			);
		}
		write(
			repo,
			"config/clients.json",
			`${JSON.stringify({ upload: { retries: 3, parallel: 4 }, sync: { retries: 7, parallel: 2 } }, null, 2)}\n`,
		);
		write(
			repo,
			"docs/operations.md",
			"# Operations\n\n## Upload client\n\nThe upload client waits 900 ms between retries.\n\n## Sync client\n\nThe sync client waits 350 ms between retries, because the index server rate-limits bursts.\n",
		);
		write(
			repo,
			"src/net/sync-client.js",
			"// The sync client.\nconst CONNECT_TIMEOUT_MS = 800;\nconst REQUEST_TIMEOUT_MS = 4200;\nmodule.exports = { CONNECT_TIMEOUT_MS, REQUEST_TIMEOUT_MS };\n",
		);
		write(
			repo,
			"src/net/upload-client.js",
			"// The upload client.\nconst REQUEST_TIMEOUT_MS = 15000;\nmodule.exports = { REQUEST_TIMEOUT_MS };\n",
		);
	},
	check(repo) {
		const answer = read(repo, "answer.txt");
		if (answer === undefined) return "answer.txt is missing";
		return answer.trim() === String(7 * 350 + 4200)
			? undefined
			: `got ${answer.trim().slice(0, 40)}, want ${7 * 350 + 4200}`;
	},
};

// ---------------------------------------------------------------------------------------------- 5. one line

const oneLine: Task = {
	name: "one-line fix",
	expect: "solo",
	prompt: "`node test.js` fails. Fix src/page.js.",
	setup(repo) {
		write(
			repo,
			"src/page.js",
			"// How many pages `total` items need at `size` items per page.\nexports.pageCount = (total, size) => Math.floor(total / size);\n",
		);
		write(
			repo,
			"test.js",
			'const { pageCount } = require("./src/page");\nconst assert = require("node:assert");\nassert.strictEqual(pageCount(10, 5), 2);\nassert.strictEqual(pageCount(11, 5), 3);\nconsole.log("ok");\n',
		);
	},
	check(repo) {
		return probe(
			repo,
			'const { pageCount } = require("./src/page"); const a = require("node:assert"); a.strictEqual(pageCount(10, 5), 2); a.strictEqual(pageCount(11, 5), 3); a.strictEqual(pageCount(0, 5), 0); a.strictEqual(pageCount(1, 5), 1); console.log("ok");',
		);
	},
};

// ---------------------------------------------------------------------------------------------- 6. one deep bug

const CALC = `// A small arithmetic evaluator: + - * / ^, unary minus, parentheses, decimals.
function tokenize(text) {
	const tokens = [];
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === " ") {
			i++;
			continue;
		}
		if (/[0-9]/.test(c)) {
			let j = i;
			while (j < text.length && /[0-9]/.test(text[j])) j++;
			tokens.push({ type: "num", value: Number(text.slice(i, j)) });
			i = j;
			continue;
		}
		if ("+-*/^()".includes(c)) {
			tokens.push({ type: c });
			i++;
			continue;
		}
		throw new Error("bad character " + c);
	}
	return tokens;
}

function evaluate(text) {
	const tokens = tokenize(text);
	let position = 0;
	const peek = () => tokens[position];
	const next = () => tokens[position++];

	function expression() {
		let value = term();
		while (peek() && (peek().type === "+" || peek().type === "-")) {
			const operator = next().type;
			const right = term();
			value = operator === "+" ? value + right : value - right;
		}
		return value;
	}

	function term() {
		let value = unary();
		while (peek() && (peek().type === "*" || peek().type === "/")) {
			const operator = next().type;
			const right = unary();
			if (operator === "/" && right === 0) throw new Error("division by zero");
			value = operator === "*" ? value * right : value / right;
		}
		return value;
	}

	function unary() {
		if (peek() && peek().type === "-") {
			next();
			return -unary();
		}
		return power();
	}

	function power() {
		let value = atom();
		while (peek() && peek().type === "^") {
			next();
			value = Math.pow(value, atom());
		}
		return value;
	}

	function atom() {
		const token = next();
		if (!token) throw new Error("unexpected end");
		if (token.type === "num") return token.value;
		if (token.type === "(") {
			const value = expression();
			const close = next();
			if (!close || close.type !== ")") throw new Error("expected )");
			return value;
		}
		throw new Error("unexpected " + token.type);
	}

	const value = expression();
	if (position < tokens.length) throw new Error("unexpected " + tokens[position].type);
	return value;
}

module.exports = { evaluate };
`;

const CALC_CASES: [string, number][] = [
	["1+2*3", 7],
	["8-3-2", 3],
	["2^3^2", 512],
	["1.5+1", 2.5],
	["-2^2", -4],
	["2^-1", 0.5],
	["(1+2)*3", 9],
	["10/4", 2.5],
	["0.5*4", 2],
	["2^2^0", 2],
	["-(2+3)*2", -10],
];

const deepBug: Task = {
	name: "bugs in one evaluator",
	expect: "solo",
	prompt:
		"`node test.js` fails. Fix src/calc.js. There may be more than one bug. Standard arithmetic rules apply: ^ is right-associative, binds tighter than unary minus, and its exponent may be negative; numbers may have decimals. Do not edit test.js.",
	setup(repo) {
		write(repo, "src/calc.js", CALC);
		const visible = CALC_CASES.slice(0, 5).map(
			([text, value]) => `assert.strictEqual(evaluate(${JSON.stringify(text)}), ${value});`,
		);
		write(
			repo,
			"test.js",
			`const { evaluate } = require("./src/calc");\nconst assert = require("node:assert");\n${visible.join("\n")}\nconsole.log("ok");\n`,
		);
	},
	check(repo) {
		const all = CALC_CASES.map(
			([text, value]) => `a.strictEqual(evaluate(${JSON.stringify(text)}), ${value}, ${JSON.stringify(text)});`,
		).join(" ");
		return probe(
			repo,
			`const { evaluate } = require("./src/calc"); const a = require("node:assert"); ${all} console.log("ok");`,
		);
	},
};

// ---------------------------------------------------------------------------------------------- 7. a chain of steps

const STEPS = 8;
const stepToken = (n: number, previous: string) =>
	createHash("sha1").update(`relay-eval:${n}:${previous}`).digest("hex").slice(0, 10);
const finalToken = () => {
	let token = "";
	for (let n = 1; n <= STEPS; n++) token = stepToken(n, token);
	return token;
};

const STEP_JS = `// Step n needs the token that step n-1 printed.
const { createHash } = require("node:crypto");
const token = (n, previous) => createHash("sha1").update("relay-eval:" + n + ":" + previous).digest("hex").slice(0, 10);
const n = Number(process.argv[2]);
const given = process.argv[3] || "";
if (!Number.isInteger(n) || n < 1 || n > ${STEPS}) {
	console.error("usage: node step.js <1..${STEPS}> [token of the previous step]");
	process.exit(2);
}
let expected = "";
for (let i = 1; i < n; i++) expected = token(i, expected);
if (given !== expected) {
	console.error("step " + n + ": wrong token from step " + (n - 1));
	process.exit(1);
}
console.log(token(n, given));
`;

const chain: Task = {
	name: "eight steps in a chain",
	expect: "solo",
	prompt: `Run the steps in order: \`node step.js 1\` prints a token; every later step needs the token of the step before it (\`node step.js 2 <token>\`), up to step ${STEPS}. Write the token of step ${STEPS} alone to answer.txt.`,
	setup(repo) {
		write(repo, "step.js", STEP_JS);
	},
	check(repo) {
		const answer = read(repo, "answer.txt");
		if (answer === undefined) return "answer.txt is missing";
		return answer.trim() === finalToken() ? undefined : `got ${answer.trim().slice(0, 40)}, want ${finalToken()}`;
	},
};

// ---------------------------------------------------------------------------------------------- 8. a small feature

const SLUG_SPEC = `# slugify(text, options)

\`src/slug.js\` exports \`slugify\`.

1. A non-string \`text\` throws a TypeError.
2. Letters are lower-cased.
3. Accented letters lose their accent (é becomes e, Ü becomes u).
4. Every run of characters that are not a-z or 0-9 becomes one separator.
5. No separator at the start or at the end.
6. \`options.separator\` is the separator, "-" by default.
7. \`options.maxLength\`, when given, cuts the result to at most that many characters, and the cut result does not end
   with a separator.
8. An empty result is "n-a" (with the default separator; the separator option replaces the "-" in it).

Tests go in \`test/slug.test.js\`; \`node test/slug.test.js\` must exit 0.
`;

const slugFeature: Task = {
	name: "a function from a written spec, with tests",
	expect: "relay",
	prompt: "Implement what SPEC.md describes, with the tests it asks for.",
	setup(repo) {
		write(repo, "SPEC.md", SLUG_SPEC);
	},
	check(repo) {
		if (read(repo, "test/slug.test.js") === undefined) return "test/slug.test.js is missing";
		const own = node(repo, ["test/slug.test.js"]);
		if (!own.ok) return `the repository's own tests fail: ${own.out.split("\n").slice(-2).join(" | ").slice(0, 200)}`;
		const cases: [string, unknown, string][] = [
			["Hello World", undefined, "hello-world"],
			["  Hello,   World!  ", undefined, "hello-world"],
			["Crème Brûlée", undefined, "creme-brulee"],
			["ÜBER uns", undefined, "uber-uns"],
			["a_b.c", undefined, "a-b-c"],
			["Hello World", { separator: "_" }, "hello_world"],
			["hello world again", { maxLength: 11 }, "hello-world"],
			["hello world again", { maxLength: 6 }, "hello"],
			["!!!", undefined, "n-a"],
			["", { separator: "_" }, "n_a"],
			["Version 2.0 (beta)", undefined, "version-2-0-beta"],
		];
		const asserts = cases
			.map(
				([text, options, want]) =>
					`a.strictEqual(slugify(${JSON.stringify(text)}, ${JSON.stringify(options)}), ${JSON.stringify(want)});`,
			)
			.join(" ");
		return probe(
			repo,
			`const { slugify } = require("./src/slug"); const a = require("node:assert"); ${asserts} a.throws(() => slugify(42), TypeError); console.log("ok");`,
		);
	},
};

// ---------------------------------------------------------------------------------------------- 9. tests one at a time

const DATES = `function isLeap(year) {
	return year % 4 === 0;
}

function daysInMonth(year, month) {
	if (month === 1) return isLeap(year) ? 29 : 28;
	return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

// date: { y, m, d } with m from 1 to 12
function addDays(date, days) {
	let { y, m, d } = date;
	d += days;
	while (d > daysInMonth(y, m)) {
		d -= daysInMonth(y, m);
		m++;
	}
	return { y, m, d };
}

function dayOfYear(date) {
	let n = date.d;
	for (let month = 1; month < date.m; month++) n += daysInMonth(date.y, month);
	return n;
}

module.exports = { isLeap, daysInMonth, addDays, dayOfYear };
`;

const DATES_TEST = `// Stops at the first failure.
const { isLeap, daysInMonth, addDays, dayOfYear } = require("./src/dates");
const assert = require("node:assert");
assert.strictEqual(isLeap(2024), true);
assert.strictEqual(isLeap(1900), false);
assert.strictEqual(isLeap(2000), true);
assert.strictEqual(daysInMonth(2024, 2), 29);
assert.strictEqual(daysInMonth(2023, 2), 28);
assert.strictEqual(daysInMonth(2024, 1), 31);
assert.deepStrictEqual(addDays({ y: 2023, m: 12, d: 30 }, 5), { y: 2024, m: 1, d: 4 });
assert.strictEqual(dayOfYear({ y: 2024, m: 3, d: 1 }), 61);
assert.strictEqual(dayOfYear({ y: 1900, m: 3, d: 1 }), 60);
console.log("ok");
`;

const oneAtATime: Task = {
	name: "three bugs behind a test that stops at the first",
	expect: "relay",
	prompt: "`node test.js` fails. Fix src/dates.js until it passes. Do not edit test.js.",
	setup(repo) {
		write(repo, "src/dates.js", DATES);
		write(repo, "test.js", DATES_TEST);
	},
	check(repo) {
		const changed = unchanged(repo, { "test.js": DATES_TEST });
		if (changed) return changed;
		const own = node(repo, ["test.js"]);
		if (!own.ok)
			return (
				own.out
					.split("\n")
					.find((line) => line.includes("Error"))
					?.slice(0, 200) ?? "test.js fails"
			);
		return probe(
			repo,
			'const { addDays } = require("./src/dates"); const a = require("node:assert"); a.deepStrictEqual(addDays({ y: 2024, m: 2, d: 28 }, 2), { y: 2024, m: 3, d: 1 }); a.deepStrictEqual(addDays({ y: 2023, m: 12, d: 31 }, 366), { y: 2024, m: 12, d: 31 }); console.log("ok");',
		);
	},
};

// ---------------------------------------------------------------------------------------------- 10. a rename

type Use = "config" | "namespace" | "url" | "both";
const USES: Use[] = [
	"config",
	"namespace",
	"url",
	"config",
	"both",
	"config",
	"namespace",
	"url",
	"config",
	"both",
	"namespace",
	"config",
];

function renameFile(index: number, use: Use): string {
	const name = `f${pad(index)}`;
	const text = `name=${name}\\nsize=${index * 3}`;
	const url = `https://example.test/${name}?n=${index}`;
	const lines: string[] = [];
	if (use === "config") {
		lines.push(
			'const { parse } = require("./config");',
			"",
			"exports.run = () => {",
			`\tconst settings = parse("${text}");`,
			"\treturn settings.name + ':' + settings.size;",
			"};",
		);
	} else if (use === "namespace") {
		lines.push(
			'const config = require("./config");',
			"",
			"exports.run = () => {",
			`\tconst settings = config.parse("${text}");`,
			`\tconst extra = JSON.parse('{"n": ${index}}');`,
			"\treturn settings.name + ':' + extra.n;",
			"};",
		);
	} else if (use === "url") {
		lines.push(
			'const { parse } = require("./url");',
			"",
			"exports.run = () => {",
			`\tconst parts = parse("${url}");`,
			"\treturn parts.host + parts.path;",
			"};",
		);
	} else {
		lines.push(
			'const { parse } = require("./config");',
			'const { parse: parseUrl } = require("./url");',
			"",
			"exports.run = () => {",
			`\tconst settings = parse("${text}");`,
			`\tconst parts = parseUrl("${url}");`,
			"\treturn settings.name + '@' + parts.host;",
			"};",
		);
	}
	return `${lines.join("\n")}\n`;
}

const RENAME_CONFIG = `// key=value lines to an object
function parse(text) {
	const out = {};
	for (const line of text.split("\\n")) {
		const at = line.indexOf("=");
		if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	return out;
}

module.exports = { parse };
`;

const RENAME_URL = `// a URL to { host, path }
function parse(url) {
	const rest = url.replace(/^[a-z]+:\\/\\//, "");
	const slash = rest.indexOf("/");
	return { host: slash < 0 ? rest : rest.slice(0, slash), path: slash < 0 ? "/" : rest.slice(slash).split("?")[0] };
}

module.exports = { parse };
`;

const RENAME_MAIN = `const names = [${USES.map((_, index) => `"f${pad(index + 1)}"`).join(", ")}];
console.log(names.map((name) => name + "=" + require("./src/" + name).run()).join("\\n"));
`;

function renameExpected(): string {
	return `${USES.map((use, i) => {
		const index = i + 1;
		const name = `f${pad(index)}`;
		if (use === "config") return `${name}=${name}:${index * 3}`;
		if (use === "namespace") return `${name}=${name}:${index}`;
		if (use === "url") return `${name}=example.test/${name}`;
		return `${name}=${name}@example.test`;
	}).join("\n")}\n`;
}

const rename: Task = {
	name: "a rename with look-alikes",
	expect: "open",
	prompt:
		"Rename the function `parse` exported by src/config.js to `parseConfig` and update every use of it. Other functions named parse (JSON.parse, the one in src/url.js) must stay as they are. `node main.js` must still print exactly what expected.txt holds.",
	setup(repo) {
		for (const [index, use] of USES.entries()) write(repo, `src/f${pad(index + 1)}.js`, renameFile(index + 1, use));
		write(repo, "src/config.js", RENAME_CONFIG);
		write(repo, "src/url.js", RENAME_URL);
		write(repo, "main.js", RENAME_MAIN);
		write(repo, "expected.txt", renameExpected());
	},
	check(repo) {
		const changed = unchanged(repo, { "src/url.js": RENAME_URL, "main.js": RENAME_MAIN });
		if (changed) return changed;
		const run = node(repo, ["main.js"]);
		if (!run.ok) return `main.js fails: ${run.out.split("\n").slice(-2).join(" | ").slice(0, 200)}`;
		if (run.out !== renameExpected()) return "main.js prints something else";
		return probe(
			repo,
			'const c = require("./src/config"); const a = require("node:assert"); a.strictEqual(typeof c.parseConfig, "function"); a.strictEqual(c.parse, undefined, "config still exports parse"); a.strictEqual(typeof require("./src/url").parse, "function"); console.log("ok");',
		);
	},
};

export const tasks: Task[] = [
	callSites,
	sixModules,
	longLog,
	scatteredFacts,
	oneLine,
	deepBug,
	chain,
	slugFeature,
	oneAtATime,
	rename,
];
