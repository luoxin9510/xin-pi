// M75: the op reference of docs/protocol.md is generated from the schemas; the library
// stands on its own.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POLICY } from "../src/lib/callers.ts";
import { AGENT_CAPABILITIES, DAEMON_CAPABILITIES } from "../src/lib/protocol.ts";
import { OPS, ResultSchemas } from "../src/lib/protocol-schema.ts";
import { DOC_PATH, END, renderOpReference, START, spliceDoc } from "./support/protocol-doc.ts";

describe("docs/protocol.md", () => {
	it("has the generated op reference up to date", () => {
		const doc = readFileSync(DOC_PATH, "utf8");
		expect(doc, "stale: run npm run docs:protocol in packages/xpi-roost").toBe(spliceDoc(doc, renderOpReference()));
		expect(doc.indexOf(START)).toBeGreaterThan(0);
		expect(doc.indexOf(END)).toBeGreaterThan(doc.indexOf(START));
	});

	it("names every op, and the capabilities hello answers with", () => {
		const ref = renderOpReference();
		for (const op of OPS) expect(ref).toContain(`### \`${op}\``);
		for (const c of [...DAEMON_CAPABILITIES, ...AGENT_CAPABILITIES]) expect(ref).toContain(`| \`${c}\` |`);
	});
});

describe("the schemas", () => {
	it("have a result for each op, and a callers row for each op: decision 4's eighteen and spec 02's six", () => {
		expect(Object.keys(ResultSchemas).sort()).toEqual([...OPS].sort());
		for (const op of OPS) expect(Object.hasOwn(POLICY, op)).toBe(true);
		expect([...OPS].sort()).toEqual(
			[
				"hello",
				"report",
				"ack",
				"ping",
				"list",
				"resolve",
				"status",
				"dispatch",
				"subscribe",
				"stop",
				"rm",
				"respawn",
				"pin",
				"rename",
				"reorder",
				"reply",
				"shutdown",
				"events",
				"schedules",
				"schedule-add",
				"schedule-edit",
				"schedule-rm",
				"schedule-pause",
				"schedule-run",
			].sort(),
		);
	});
});

describe("the import graph", () => {
	const root = new URL("../", import.meta.url);
	const files = (dir: string): string[] =>
		readdirSync(new URL(`${dir}/`, root), { withFileTypes: true }).flatMap((e) =>
			e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : [],
		);
	/** Files that load `pkg` (a static or dynamic import, a re-export, a require); comments and strings that only name it do not count. */
	const loading = (dirs: string[], pkg: string) => {
		const spec = `["']${pkg}(?:/[^"']*)?["']`;
		const re = new RegExp(
			`(?:^|[;\\s])(?:import|export)[^;"']*?from\\s*${spec}|import\\s*\\(\\s*${spec}|require\\s*\\(\\s*${spec}|^\\s*import\\s+${spec}`,
			"m",
		);
		return dirs.flatMap(files).filter((f) => re.test(readFileSync(new URL(f, root), "utf8")));
	};

	it("has no typebox in src, in any form of import", () => {
		expect(files("src").length).toBeGreaterThan(20);
		for (const pkg of ["typebox", "@sinclair/typebox"]) expect(loading(["src"], pkg), pkg).toEqual([]);
	});

	it("has no xpi package in src but the hub's xpi-tui: the agent directory and the entry files come from the caller", () => {
		expect(loading(["src"], "xpi-(?!tui[\"'/])[^\"'/]+")).toEqual([]);
		// the hub draws with xpi-tui (decision 6: it imports xpi-tui directly); nothing else in src does
		const tui = loading(["src"], "xpi-tui");
		expect(tui.length).toBeGreaterThan(0);
		expect(tui.filter((f) => !f.startsWith("src/hub/"))).toEqual([]);
		// Upstream pi's scope, written in two parts so the rename check (scripts/xpi-rename.mjs) leaves this line alone.
		expect(loading(["src"], `${["@earendil", "works"].join("-")}/[^"'/]+`)).toEqual([]);
	});

	it("the checks catch each form", () => {
		const re = (pkg: string) =>
			new RegExp(
				`(?:^|[;\\s])(?:import|export)[^;"']*?from\\s*["']${pkg}["']|import\\s*\\(\\s*["']${pkg}["']|require\\s*\\(\\s*["']${pkg}["']`,
				"m",
			);
		for (const line of [
			'import { Type } from "typebox";',
			'export { Type } from "typebox";',
			'const t = await import("typebox");',
			'const t = require("typebox");',
		])
			expect(re("typebox").test(line), line).toBe(true);
		expect(re("typebox").test("// typebox is xpi's, not ours")).toBe(false);
	});
});
