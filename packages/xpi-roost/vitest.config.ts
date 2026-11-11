import { defineConfig } from "vitest/config";

export default defineConfig({
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
