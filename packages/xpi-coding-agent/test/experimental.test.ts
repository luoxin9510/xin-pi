import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.XPI_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.XPI_EXPERIMENTAL;
		} else {
			process.env.XPI_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when XPI_EXPERIMENTAL is unset", () => {
		delete process.env.XPI_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when XPI_EXPERIMENTAL is empty", () => {
		process.env.XPI_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when XPI_EXPERIMENTAL is set to 1", () => {
		process.env.XPI_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when XPI_EXPERIMENTAL is set to 0", () => {
		process.env.XPI_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when XPI_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.XPI_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
