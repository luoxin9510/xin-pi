import { describe, expect, it } from "vitest";
import { VIRTUAL_MODEL_STATE_ENTRY as PACKAGE_CONSTANT } from "xpi-relay";
import { VIRTUAL_MODEL_STATE_ENTRY } from "../src/core/virtual-models.ts";

describe("xpi-relay and the coding agent", () => {
	// The package reads the router state from the branch by this entry name, so it keeps its own copy of the constant.
	it("names the virtual-model state entry like the core does", () => {
		expect(PACKAGE_CONSTANT).toBe(VIRTUAL_MODEL_STATE_ENTRY);
	});
});
