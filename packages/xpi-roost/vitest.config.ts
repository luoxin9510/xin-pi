import { defineConfig } from "vitest/config";
import { workspaceSourcePaths } from "../../vitest.base.ts";

export default defineConfig({
	// The hub draws with xpi-tui: from source, as the other packages' tests use it.
	resolve: { alias: [{ find: /^xpi-tui$/, replacement: workspaceSourcePaths.tuiIndex }] },
	test: {
		include: ["test/**/*.test.ts"],
		// Daemons, hosts and PTYs are real processes: one test file per fork, generous timeouts.
		testTimeout: 20_000,
		pool: "forks",
		// M78: processes an earlier killed run left behind go before this one starts.
		globalSetup: ["test/support/global-setup.ts"],
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
});
