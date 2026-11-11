import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("--strict-extensions", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	async function load(strictExtensions: boolean) {
		// vitest.config.ts sets offline mode, which skips installs; the install itself is mocked below.
		vi.stubEnv("XPI_OFFLINE", "");
		const root = mkdtempSync(join(tmpdir(), "pi-strict-ext-"));
		dirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir),
			additionalExtensionPaths: ["npm:broken-package"],
			strictExtensions,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		// No network: the install fails as npm would.
		vi.spyOn((loader as any).packageManager, "installParsedSource").mockRejectedValue(
			new Error("npm install broken-package failed with code 1"),
		);
		await loader.reload();
		return loader.getExtensions();
	}

	it("is parsed from the command line", () => {
		expect(parseArgs(["--strict-extensions"]).strictExtensions).toBe(true);
		expect(parseArgs([]).strictExtensions).toBeUndefined();
	});

	it("without it, an -e package that fails to install is a warning and the session starts without it", async () => {
		const result = await load(false);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([
			{ path: "npm:broken-package", warning: expect.stringContaining("failed to install") },
		]);
	});

	it("with it, the failure is an error (which stops the CLI's start) and not also a warning", async () => {
		const result = await load(true);
		expect(result.errors).toEqual([
			{ path: "npm:broken-package", error: expect.stringContaining("failed to install") },
		]);
		expect(result.warnings ?? []).toEqual([]);
	});
});
