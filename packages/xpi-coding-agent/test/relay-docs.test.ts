import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderRelayDocs } from "../scripts/generate-relay-docs.ts";

describe("generated relay docs", () => {
	const current = readFileSync(new URL("../docs/relay.md", import.meta.url), "utf-8");

	it("keeps the diagram and the transition table of docs/relay.md in step with the relay graph", () => {
		expect(current, "docs/relay.md is stale; run npm run generate:relay-docs").toBe(renderRelayDocs(current));
	});

	it("refuses a document without the markers", () => {
		expect(() => renderRelayDocs("# Relay\n")).toThrow(/no relay-diagram markers/);
	});
});
