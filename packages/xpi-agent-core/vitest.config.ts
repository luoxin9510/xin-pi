import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../xpi-telemetry/src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../xpi-ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../xpi-ai/src/compat.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^xpi-telemetry$/, replacement: telemetrySrcIndex },
			{ find: /^xpi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^xpi-ai$/, replacement: aiSrcIndex },
			{ find: /^xpi-ai\/compat$/, replacement: aiSrcCompat },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
