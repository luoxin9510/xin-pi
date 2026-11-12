// Fixtures of the multi-agent long tasks (long-tasks.ts): three libraries to write from their spec, each with its
// tests, and three generated packages to audit. Every part is independent of the others and is minutes of work.

import { sequence } from "./tasks.ts";

// ------------------------------------------------------------------------------------- three libraries from a spec

export interface Library {
	name: string;
	spec: string;
	stub: string;
	test: string;
}

const CSV_SPEC = `# csv

\`src/index.js\` (CommonJS) exports \`parse\`, \`stringify\` and \`parseObjects\`.

## parse(text, options?) -> string[][]

- \`options.delimiter\`: one character, default \`,\`.
- Records end at \`\\n\` or \`\\r\\n\`. A newline at the very end of the text does not start another record. An empty
  text is no records (\`[]\`). An empty line inside the text is a record with one empty field (\`[""]\`).
- A field is quoted when its first character is \`"\`. Inside quotes, \`""\` is one \`"\`, and the delimiter, \`\\r\` and
  \`\\n\` are part of the field. After the closing quote comes the delimiter, the end of the record, or the end of the
  text; anything else throws an \`Error\`.
- An unquoted field is taken exactly as written (no trimming). A \`"\` inside an unquoted field throws an \`Error\`.
- A quote that is never closed throws an \`Error\`.

## stringify(rows, options?) -> string

- \`options.delimiter\` as above. Each record ends with \`\\r\\n\`; no rows is \`""\`.
- A field is quoted when it contains the delimiter, \`"\`, \`\\r\` or \`\\n\`, or starts or ends with a space; inside
  quotes \`"\` is written \`""\`. Other fields are written as they are.
- Numbers, booleans, \`null\` and \`undefined\` are written as \`String(value)\`, except \`null\` and \`undefined\`, which
  are empty fields.

## parseObjects(text, options?) -> object[]

- The first record is the header: the keys. Every other record becomes an object with those keys, in order.
- A record with fewer fields gets \`""\` for the missing keys. A record with more fields than the header throws an
  \`Error\`. No records, or only the header, is \`[]\`.
`;

const CSV_TEST = `const test = require("node:test");
const assert = require("node:assert/strict");
const { parse, stringify, parseObjects } = require("../src/index.js");

test("parse: plain records, both line ends, the last newline", () => {
	assert.deepEqual(parse("a,b,c\\n1,2,3\\n"), [["a", "b", "c"], ["1", "2", "3"]]);
	assert.deepEqual(parse("a,b\\r\\n1,2"), [["a", "b"], ["1", "2"]]);
	assert.deepEqual(parse(""), []);
	assert.deepEqual(parse("a\\n\\nb"), [["a"], [""], ["b"]]);
	assert.deepEqual(parse("a,,b,"), [["a", "", "b", ""]]);
	assert.deepEqual(parse(" a , b "), [[" a ", " b "]]);
});

test("parse: quoted fields", () => {
	assert.deepEqual(parse('"a,b","c""d"'), [["a,b", 'c"d']]);
	assert.deepEqual(parse('"line 1\\nline 2",x\\r\\ny,"r\\r\\n"'), [["line 1\\nline 2", "x"], ["y", "r\\r\\n"]]);
	assert.deepEqual(parse('""'), [[""]]);
	assert.deepEqual(parse('"",""\\n'), [["", ""]]);
});

test("parse: errors", () => {
	assert.throws(() => parse('"open'), Error);
	assert.throws(() => parse('a"b'), Error);
	assert.throws(() => parse('"a"b'), Error);
});

test("parse: another delimiter", () => {
	assert.deepEqual(parse("a;b,c\\n1;2", { delimiter: ";" }), [["a", "b,c"], ["1", "2"]]);
	assert.deepEqual(parse('"x;y";z', { delimiter: ";" }), [["x;y", "z"]]);
});

test("stringify", () => {
	assert.equal(stringify([]), "");
	assert.equal(stringify([["a", "b"], ["1", "2"]]), "a,b\\r\\n1,2\\r\\n");
	assert.equal(stringify([["a,b", 'q"q', "l\\nl", " s", "t ", "ok"]]), '"a,b","q""q","l\\nl"," s","t ",ok\\r\\n');
	assert.equal(stringify([[1, true, null, undefined, 2.5]]), "1,true,,,2.5\\r\\n");
	assert.equal(stringify([["a;b", "c,d"]], { delimiter: ";" }), '"a;b";c,d\\r\\n');
});

test("round trip", () => {
	const rows = [["id", "text"], ["1", 'say "hi", then\\nleave'], ["2", ""], ["3", " padded "]];
	assert.deepEqual(parse(stringify(rows)), rows);
});

test("parseObjects", () => {
	assert.deepEqual(parseObjects("id,name\\n1,ann\\n2\\n"), [{ id: "1", name: "ann" }, { id: "2", name: "" }]);
	assert.deepEqual(parseObjects("id,name\\n"), []);
	assert.deepEqual(parseObjects(""), []);
	assert.throws(() => parseObjects("id\\n1,2"), Error);
	assert.deepEqual(Object.keys(parseObjects("b,a\\n1,2")[0]), ["b", "a"]);
});
`;

const SEMVER_SPEC = `# semver

\`src/index.js\` (CommonJS) exports \`parse\`, \`compare\`, \`satisfies\` and \`maxSatisfying\`.

## parse(version) -> { major, minor, patch, prerelease }

- \`MAJOR.MINOR.PATCH\`, each a non-negative integer without leading zeros (\`0\` itself is fine), optionally followed
  by \`-\` and a prerelease: identifiers separated by \`.\`, each \`[0-9A-Za-z-]+\`, a numeric one without leading zeros.
  Optionally followed by \`+\` and build metadata (identifiers \`[0-9A-Za-z-]+\`), which is ignored.
- A leading \`v\` is allowed. Surrounding spaces are not.
- \`prerelease\` is an array: numeric identifiers as numbers, the others as strings. Anything else throws an \`Error\`.

## compare(a, b) -> -1 | 0 | 1

SemVer 2.0.0 precedence of two version strings: major, minor, patch numerically; then a version with a prerelease is
lower than the same version without one; prereleases compare identifier by identifier: numeric ones numerically,
a numeric one is lower than an alphanumeric one, alphanumeric ones in ASCII order, and when one list is a prefix of
the other the shorter is lower. Build metadata does not count.

## satisfies(version, range) -> boolean

Only versions without a prerelease are asked. A range is one or more comparator sets separated by \`||\`; the version
satisfies the range when it satisfies every comparator of at least one set. In a set, comparators are separated by
spaces. Comparators:

- \`1.2.3\` or \`=1.2.3\`: exactly; \`>1.2.3\`, \`>=1.2.3\`, \`<1.2.3\`, \`<=1.2.3\`.
- \`*\`, \`x\`, \`X\` or an empty set: any version.
- Partial and x-ranges: \`1\`, \`1.x\`, \`1.*\` mean \`>=1.0.0 <2.0.0\`; \`1.2\`, \`1.2.x\` mean \`>=1.2.0 <1.3.0\`.
- Tilde: \`~1.2.3\` is \`>=1.2.3 <1.3.0\`; \`~1.2\` is \`>=1.2.0 <1.3.0\`; \`~1\` is \`>=1.0.0 <2.0.0\`.
- Caret: the first non-zero part may not change. \`^1.2.3\` is \`>=1.2.3 <2.0.0\`; \`^0.2.3\` is \`>=0.2.3 <0.3.0\`;
  \`^0.0.3\` is \`>=0.0.3 <0.0.4\`; \`^1.2\` is \`>=1.2.0 <2.0.0\`; \`^0.2\` is \`>=0.2.0 <0.3.0\`.
- Hyphen: \`1.2.3 - 2.3.4\` is \`>=1.2.3 <=2.3.4\`. A partial lower end is filled with zeros (\`1.2 - 2.3.4\` is
  \`>=1.2.0 <=2.3.4\`); a partial upper end takes everything it names (\`1.2.3 - 2.3\` is \`>=1.2.3 <2.4.0\`,
  \`1.2.3 - 2\` is \`>=1.2.3 <3.0.0\`).
- A range that does not parse throws an \`Error\`.

## maxSatisfying(versions, range) -> string | null

The highest of \`versions\` (by \`compare\`) that satisfies \`range\`, as given; \`null\` when none does.
`;

const SEMVER_TEST = `const test = require("node:test");
const assert = require("node:assert/strict");
const { parse, compare, satisfies, maxSatisfying } = require("../src/index.js");

test("parse", () => {
	assert.deepEqual(parse("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
	assert.deepEqual(parse("v0.10.0-alpha.1+build.5"), { major: 0, minor: 10, patch: 0, prerelease: ["alpha", 1] });
	assert.deepEqual(parse("2.0.0-rc-1.x7"), { major: 2, minor: 0, patch: 0, prerelease: ["rc-1", "x7"] });
	for (const bad of ["1.2", "01.2.3", "1.2.3-01", "1.2.3-", "1.2.3-a..b", " 1.2.3", "a.b.c", "1.2.3+"])
		assert.throws(() => parse(bad), Error, bad);
});

test("compare", () => {
	assert.equal(compare("1.2.3", "1.2.3"), 0);
	assert.equal(compare("1.2.3", "1.10.0"), -1);
	assert.equal(compare("2.0.0", "1.99.99"), 1);
	assert.equal(compare("1.0.0+a", "1.0.0+b"), 0);
	const ordered = [
		"1.0.0-alpha",
		"1.0.0-alpha.1",
		"1.0.0-alpha.beta",
		"1.0.0-beta",
		"1.0.0-beta.2",
		"1.0.0-beta.11",
		"1.0.0-rc.1",
		"1.0.0",
	];
	for (let i = 0; i + 1 < ordered.length; i++) {
		assert.equal(compare(ordered[i], ordered[i + 1]), -1, \`\${ordered[i]} < \${ordered[i + 1]}\`);
		assert.equal(compare(ordered[i + 1], ordered[i]), 1, \`\${ordered[i + 1]} > \${ordered[i]}\`);
	}
});

const yes = (v, r) => assert.equal(satisfies(v, r), true, \`\${v} satisfies \${r}\`);
const no = (v, r) => assert.equal(satisfies(v, r), false, \`\${v} does not satisfy \${r}\`);

test("satisfies: comparators and sets", () => {
	yes("1.2.3", "1.2.3");
	yes("1.2.3", "=1.2.3");
	no("1.2.4", "1.2.3");
	yes("1.2.4", ">1.2.3");
	no("1.2.3", ">1.2.3");
	yes("1.2.3", ">=1.2.3 <2.0.0");
	no("2.0.0", ">=1.2.3 <2.0.0");
	yes("0.9.0", "<1.0.0");
	yes("1.0.0", "<=1.0.0");
	yes("3.1.0", "1.x || >=3.0.0");
	no("2.5.0", "1.x || >=3.0.0");
	yes("9.9.9", "*");
	yes("9.9.9", "");
	yes("0.0.0", "x");
});

test("satisfies: partial, x, tilde, caret", () => {
	yes("1.9.9", "1");
	no("2.0.0", "1");
	yes("1.2.9", "1.2.x");
	no("1.3.0", "1.2");
	yes("1.0.0", "1.*");
	yes("1.2.9", "~1.2.3");
	no("1.3.0", "~1.2.3");
	no("1.2.2", "~1.2.3");
	yes("1.2.0", "~1.2");
	yes("1.9.0", "~1");
	no("2.0.0", "~1");
	yes("1.9.9", "^1.2.3");
	no("2.0.0", "^1.2.3");
	no("1.2.2", "^1.2.3");
	yes("0.2.9", "^0.2.3");
	no("0.3.0", "^0.2.3");
	yes("0.0.3", "^0.0.3");
	no("0.0.4", "^0.0.3");
	yes("1.5.0", "^1.2");
	yes("0.2.0", "^0.2");
	no("0.3.0", "^0.2");
});

test("satisfies: hyphen ranges", () => {
	yes("1.2.3", "1.2.3 - 2.3.4");
	yes("2.3.4", "1.2.3 - 2.3.4");
	no("2.3.5", "1.2.3 - 2.3.4");
	yes("1.2.0", "1.2 - 2.3.4");
	no("1.1.9", "1.2 - 2.3.4");
	yes("2.3.9", "1.2.3 - 2.3");
	no("2.4.0", "1.2.3 - 2.3");
	yes("2.9.9", "1.2.3 - 2");
	no("3.0.0", "1.2.3 - 2");
});

test("satisfies: a range that does not parse", () => {
	for (const bad of [">=a.b.c", "~>1.2", "1.2.3 -", "^"]) assert.throws(() => satisfies("1.2.3", bad), Error, bad);
});

test("maxSatisfying", () => {
	const versions = ["1.2.3", "1.10.0", "1.9.9", "2.0.0", "0.9.0"];
	assert.equal(maxSatisfying(versions, "^1.2.0"), "1.10.0");
	assert.equal(maxSatisfying(versions, "~1.9"), "1.9.9");
	assert.equal(maxSatisfying(versions, ">=3"), null);
	assert.equal(maxSatisfying(["v1.0.0", "1.0.1"], "1.0.x"), "1.0.1");
});
`;

const INI_SPEC = `# ini

\`src/index.js\` (CommonJS) exports \`parse\` and \`stringify\`.

## parse(text) -> object

- The text is read line by line (\`\\n\` or \`\\r\\n\`); each line is trimmed. Empty lines and lines starting with \`;\` or
  \`#\` are skipped.
- \`[name]\` starts a section: the keys that follow go into \`result[name]\`. A dotted name nests: \`[a.b]\` is
  \`result.a.b\`. A section seen again adds to the same object. Keys before the first section go into the result itself.
- \`key = value\` sets a key; the first \`=\` separates them, and both are trimmed. \`key[] = value\` appends to an array
  under \`key\` (created on first use). Otherwise a key seen again takes the later value.
- Values:
  - a value that starts with \`"\` is a quoted string up to the next unescaped \`"\`; inside, \`\\\\"\` is \`"\`, \`\\\\\\\\\`
    is \`\\\\\`, \`\\\\n\` is a newline and \`\\\\t\` is a tab. After the closing quote only spaces and a comment may follow.
  - in an unquoted value, \` ;\` or \` #\` (a space, then \`;\` or \`#\`) starts a comment, which is dropped, and the
    value is trimmed again.
  - an unquoted \`true\` or \`false\` is a boolean; an unquoted value matching \`-?\\d+(\\.\\d+)?\` is a number; any
    other unquoted value is a string, possibly empty.
- Any other line throws an \`Error\` whose message contains \`line N\` (1-based), as does an unclosed quote.

## stringify(object) -> string

Writes text that \`parse\` reads back into an equal object (same keys, values and types), for objects whose values
are strings, numbers, booleans, arrays of those, and objects of the same kind (sections). Keys that are not objects
come before any section, in their order; then each section, a section's own keys first, then its subsections as
\`[parent.child]\`. Strings are quoted when they would not read back as the same string. Lines end with \`\\n\`.
`;

const INI_TEST = `const test = require("node:test");
const assert = require("node:assert/strict");
const { parse, stringify } = require("../src/index.js");

test("keys, sections, nesting, comments", () => {
	const text = [
		"; top comment",
		"name = demo",
		"# another",
		"",
		"[server]",
		"host = example.invalid",
		"port = 8080",
		"",
		"[server.tls]",
		"enabled = true",
		"[db]",
		"  user =  admin  ",
		"[server]",
		"timeout = 2.5",
	].join("\\r\\n");
	assert.deepEqual(parse(text), {
		name: "demo",
		server: { host: "example.invalid", port: 8080, tls: { enabled: true }, timeout: 2.5 },
		db: { user: "admin" },
	});
});

test("values", () => {
	const parsed = parse(
		[
			'quoted = "a \\\\"b\\\\" \\\\\\\\ c\\\\n\\\\td"  ; comment',
			'keep = "  spaced ; not a comment  "',
			"inline = value ; dropped",
			"hash = v # dropped",
			"glued = a;b#c",
			"empty =",
			'text = "true"',
			"neg = -12",
			"version = 1.2.3",
			"eq = a=b",
			"no = false",
			"again = 1",
			"again = 2",
		].join("\\n"),
	);
	assert.deepEqual(parsed, {
		quoted: 'a "b" \\\\ c\\n\\td',
		keep: "  spaced ; not a comment  ",
		inline: "value",
		hash: "v",
		glued: "a;b#c",
		empty: "",
		text: "true",
		neg: -12,
		version: "1.2.3",
		eq: "a=b",
		no: false,
		again: 2,
	});
});

test("arrays", () => {
	assert.deepEqual(parse("[s]\\nlist[] = a\\nlist[] = 2\\nlist[] = \\"x y\\""), { s: { list: ["a", 2, "x y"] } });
});

test("errors name the line", () => {
	assert.throws(() => parse("a = 1\\njust words"), /line 2/);
	assert.throws(() => parse("[ok]\\nx = 1\\n\\nq = \\"open"), /line 4/);
	assert.throws(() => parse('q = "a" trailing'), /line 1/);
});

test("stringify reads back", () => {
	const objects = [
		{ a: 1, b: "two", c: true },
		{ s: "  padded  ", t: "true", n: "42", semi: "x ; y", hash: "x # y", quote: 'say "hi"', back: "a\\\\b", nl: "l1\\nl2", tab: "a\\tb", empty: "" },
		{ top: "x", list: ["a", 1, false], sec: { k: "v", deep: { more: { z: -3.5 } }, after: 1 }, other: { list: ["only"] } },
	];
	for (const object of objects) assert.deepEqual(parse(stringify(object)), object);
});

test("stringify layout", () => {
	assert.equal(stringify({ a: 1, s: { b: "x" } }), "a = 1\\n\\n[s]\\nb = x\\n");
	const text = stringify({ sec: { child: { k: 1 }, own: 2 }, top: 3 });
	assert.ok(text.indexOf("top = 3") < text.indexOf("[sec]"), text);
	assert.ok(text.indexOf("own = 2") < text.indexOf("[sec.child]"), text);
});
`;

const stub = (names: string[]) =>
	`// See ../SPEC.md.\n\n${names.map((n) => `function ${n}() {\n\tthrow new Error("not implemented");\n}\n`).join("\n")}\nmodule.exports = { ${names.join(", ")} };\n`;

export const LIBRARIES: Library[] = [
	{ name: "csv", spec: CSV_SPEC, stub: stub(["parse", "stringify", "parseObjects"]), test: CSV_TEST },
	{
		name: "semver",
		spec: SEMVER_SPEC,
		stub: stub(["parse", "compare", "satisfies", "maxSatisfying"]),
		test: SEMVER_TEST,
	},
	{ name: "ini", spec: INI_SPEC, stub: stub(["parse", "stringify"]), test: INI_TEST },
];

// ------------------------------------------------------------------------------------ three generated packages to audit

const pad = (n: number) => String(n).padStart(2, "0");
export const AUDIT_FILES = 36;

const VERBS = [
	"load",
	"save",
	"merge",
	"split",
	"check",
	"build",
	"sort",
	"count",
	"apply",
	"reset",
	"parse",
	"format",
];
const NOUNS = [
	"Entry",
	"Total",
	"Batch",
	"Account",
	"Ledger",
	"Rate",
	"Report",
	"Range",
	"Note",
	"Tag",
	"Limit",
	"Owner",
];

/** packages/ledger: exported functions, some with a JSDoc block directly above. Answer: "mNN.js:name", sorted. */
export function ledgerPackage(): { files: Record<string, string>; undocumented: string[] } {
	const random = sequence(901);
	const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;
	const files: Record<string, string> = {};
	const undocumented: string[] = [];
	for (let i = 1; i <= AUDIT_FILES; i++) {
		const name = `m${pad(i)}.js`;
		const lines = [`// ${name}: ledger helpers`, `"use strict";`, ""];
		const exported: string[] = [];
		const count = 3 + Math.floor(random() * 3);
		const used = new Set<string>();
		for (let f = 0; f < count; f++) {
			let fn = `${pick(VERBS)}${pick(NOUNS)}`;
			while (used.has(fn)) fn = `${pick(VERBS)}${pick(NOUNS)}`;
			used.add(fn);
			const isExported = f === 0 || random() < 0.7; // every module exports something
			const doc = random();
			if (doc < 0.45)
				lines.push("/**", ` * ${fn}: ${pick(NOUNS).toLowerCase()} handling.`, " * @param {number} x", " */");
			else if (doc < 0.6)
				lines.push(`// ${fn} is used by the report`); // a line comment is not JSDoc
			else if (doc < 0.7) lines.push(`/* ${fn}: plain block comment */`); // nor is a plain block comment
			lines.push(
				`function ${fn}(x) {`,
				`\tconst y = x * ${2 + Math.floor(random() * 9)};`,
				`\treturn y + ${f};`,
				"}",
				"",
			);
			if (isExported) {
				exported.push(fn);
				if (doc >= 0.45) undocumented.push(`${name}:${fn}`);
			}
		}
		lines.push(`module.exports = { ${exported.join(", ")} };`, "");
		files[`packages/ledger/src/${name}`] = lines.join("\n");
	}
	return { files, undocumented: undocumented.sort() };
}

interface Call {
	url: string;
	method: string;
	body?: unknown;
}

/** packages/router: modules calling the deprecated `legacyRequest(url, method, body?)`. Answer: the calls each module's
 * `run()` makes, in order. */
export function routerPackage(): { files: Record<string, string>; calls: Record<string, Call[]> } {
	const random = sequence(902);
	const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;
	const files: Record<string, string> = {
		"packages/router/lib/http.js": [
			"// The HTTP layer. Every call is recorded in `log` (the tests read it).",
			'"use strict";',
			"",
			"const log = [];",
			"",
			"/** Send a request: { url, method, body? }. */",
			"function request(options) {",
			"\tlog.push(options);",
			"\treturn { ok: true };",
			"}",
			"",
			"/** @deprecated Use request({ url, method, body }). */",
			"function legacyRequest(url, method, body) {",
			"\treturn request(body === undefined ? { url, method } : { url, method, body });",
			"}",
			"",
			"module.exports = { log, request, legacyRequest };",
			"",
		].join("\n"),
	};
	const calls: Record<string, Call[]> = {};
	const RESOURCES = ["users", "orders", "items", "invoices", "teams", "events", "files", "tags"];
	for (let i = 1; i <= AUDIT_FILES; i++) {
		const name = `m${pad(i)}.js`;
		const resource = pick(RESOURCES);
		const lines = [
			`// ${name}: routes for ${resource}`,
			'"use strict";',
			"",
			'const { legacyRequest } = require("../lib/http");',
			"",
			`const BASE = "/v${1 + Math.floor(random() * 3)}/${resource}";`,
			"",
			"function run() {",
		];
		const made: Call[] = [];
		const base = lines[5]!.match(/"(.*)"/)![1]!;
		const n = 1 + Math.floor(random() * 4);
		for (let c = 0; c < n; c++) {
			const id = Math.floor(random() * 900) + 100;
			const kind = random();
			if (kind < 0.3) {
				lines.push(`\tlegacyRequest(BASE + "/${id}", "GET");`);
				made.push({ url: `${base}/${id}`, method: "GET" });
			} else if (kind < 0.55) {
				lines.push(`\tlegacyRequest(BASE, "POST", { name: "n${id}", size: ${id % 7} });`);
				made.push({ url: base, method: "POST", body: { name: `n${id}`, size: id % 7 } });
			} else if (kind < 0.75) {
				// over several lines
				lines.push(
					"\tlegacyRequest(",
					`\t\tBASE + "/${id}",`,
					'\t\t"PUT",',
					`\t\t{ active: ${id % 2 === 0} },`,
					"\t);",
				);
				made.push({ url: `${base}/${id}`, method: "PUT", body: { active: id % 2 === 0 } });
			} else if (kind < 0.9) {
				lines.push(
					`\tconst r${c} = legacyRequest(\`\${BASE}/${id}\`, "DELETE");`,
					`\tif (!r${c}.ok) return false;`,
				);
				made.push({ url: `${base}/${id}`, method: "DELETE" });
			} else {
				// a string that mentions the old name is not a call
				lines.push(`\tvoid "migrating legacyRequest(${id}) callers";`);
			}
		}
		lines.push("\treturn true;", "}", "", "module.exports = { run };", "");
		files[`packages/router/src/${name}`] = lines.join("\n");
		calls[name] = made;
	}
	return { files, calls };
}

interface Todo {
	file: string;
	line: number;
	text: string;
}

/** packages/notes: `// TODO(owner): text` comments among distractors. Answer: by owner, sorted by file and line. */
export function notesPackage(): { files: Record<string, string>; todos: Record<string, Todo[]> } {
	const random = sequence(903);
	const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;
	const OWNERS = ["ana", "bo", "cy", "dee", "eli"];
	const TASKS = [
		"handle empty input",
		"cache the result",
		"remove after the migration",
		"check the limits",
		"log the failure",
		"split this function",
		"rename the field",
	];
	const files: Record<string, string> = {};
	const todos: Record<string, Todo[]> = {};
	const add = (owner: string, todo: Todo) => {
		todos[owner] ??= [];
		todos[owner].push(todo);
	};
	for (let i = 1; i <= AUDIT_FILES; i++) {
		const name = `src/m${pad(i)}.js`;
		const lines = [`// ${name}: note helpers`, '"use strict";', ""];
		const blocks = 4 + Math.floor(random() * 4);
		for (let b = 0; b < blocks; b++) {
			const kind = random();
			const fn = `step${b}`;
			if (kind < 0.35) {
				const owner = pick(OWNERS);
				const text = pick(TASKS);
				lines.push(`// TODO(${owner}): ${text}`);
				add(owner, { file: name, line: lines.length, text });
			} else if (kind < 0.45) {
				lines.push(`// TODO: ${pick(TASKS)}`); // no owner: not collected
			} else if (kind < 0.55) {
				lines.push(`const hint${b} = "TODO(${pick(OWNERS)}): ${pick(TASKS)}";`); // in a string: not a comment
			} else if (kind < 0.65) {
				const owner = pick(OWNERS);
				const text = pick(TASKS);
				lines.push(`function ${fn}a(x) { return x + ${b}; } // TODO(${owner}): ${text}`); // after code: collected
				add(owner, { file: name, line: lines.length, text });
			}
			lines.push(`function ${fn}(x) {`, `\treturn x * ${b + 2};`, "}", "");
		}
		lines.push(`module.exports = {};`, "");
		files[`packages/notes/${name}`] = lines.join("\n");
	}
	return { files, todos };
}
