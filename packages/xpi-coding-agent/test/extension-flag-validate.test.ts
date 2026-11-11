import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";

describe("extension flag validate", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function servicesWith(value: string) {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-flag-validate-")));
		dirs.push(dir);
		const seen: Array<{ value: string; cwd: string }> = [];
		const services = await createAgentSessionServices({
			cwd: dir,
			agentDir: dir,
			extensionFlagValues: new Map([["shape", value]]),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerFlag("shape", {
							type: "string",
							validate: (flagValue, cwd) => {
								seen.push({ value: flagValue, cwd });
								if (flagValue === "throw") throw new Error("--shape: cannot read it");
								return flagValue === "round" ? undefined : `--shape: "${flagValue}" is not round`;
							},
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return { services, seen, dir };
	}

	it("sets a value the flag accepts, with the session cwd passed to validate", async () => {
		const { services, seen, dir } = await servicesWith("round");
		expect(services.diagnostics.filter((d) => d.type === "error")).toEqual([]);
		expect(seen).toEqual([{ value: "round", cwd: dir }]);
		expect(services.resourceLoader.getExtensions().runtime.flagValues.get("shape")).toBe("round");
	});

	// At startup the error diagnostic stops the run (main.ts). Services are created again for /new, a resume or a fork,
	// whose diagnostics are not shown: the value stays set, so the extension's session_start can report it.
	it("turns a returned message or a throw into an error diagnostic and keeps the value for the extension", async () => {
		for (const [value, message] of [
			["square", '--shape: "square" is not round'],
			["throw", "--shape: cannot read it"],
		]) {
			const { services } = await servicesWith(value!);
			expect(services.diagnostics).toContainEqual({ type: "error", message });
			expect(services.resourceLoader.getExtensions().runtime.flagValues.get("shape")).toBe(value);
		}
	});
});
