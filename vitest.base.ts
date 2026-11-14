import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/xpi-telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/xpi-telemetry/src/testing/index.ts", import.meta.url)),
	mcpIndex: fileURLToPath(new URL("./packages/xpi-mcp/src/index.ts", import.meta.url)),
	mcpOAuth: fileURLToPath(new URL("./packages/xpi-mcp/src/oauth/index.ts", import.meta.url)),
	mcpTesting: fileURLToPath(new URL("./packages/xpi-mcp/src/testing/index.ts", import.meta.url)),
	roostIndex: fileURLToPath(new URL("./packages/xpi-roost/src/index.ts", import.meta.url)),
	roostSession: fileURLToPath(new URL("./packages/xpi-roost/src/session.ts", import.meta.url)),
	roostHub: fileURLToPath(new URL("./packages/xpi-roost/src/hub/index.ts", import.meta.url)),
	shadowGitIndex: fileURLToPath(new URL("./packages/xpi-shadow-git/src/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/xpi-ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/xpi-ai/src/compat.ts", import.meta.url)),
	aiModels: fileURLToPath(new URL("./packages/xpi-ai/src/models.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/xpi-ai/src/oauth.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/xpi-ai/src/api", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/xpi-ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/xpi-ai/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/xpi-agent-core/src/index.ts", import.meta.url)),
	codemodeIndex: fileURLToPath(new URL("./packages/xpi-codemode/src/index.ts", import.meta.url)),
	codemodeDeclarations: fileURLToPath(new URL("./packages/xpi-codemode/src/declarations.ts", import.meta.url)),
	codemodeSource: fileURLToPath(new URL("./packages/xpi-codemode/src/source.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/xpi-coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/xpi-tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^xpi-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^xpi-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^xpi-mcp$/, replacement: workspaceSourcePaths.mcpIndex },
			{ find: /^xpi-mcp\/oauth$/, replacement: workspaceSourcePaths.mcpOAuth },
			{ find: /^xpi-mcp\/testing$/, replacement: workspaceSourcePaths.mcpTesting },
			// The library, the session entry and the hub from source; the daemon and host entries (`xpi-roost/daemon`, `/host`) are
			// resolved by Node at run time and need `npm run build` in packages/xpi-roost.
			{ find: /^xpi-roost$/, replacement: workspaceSourcePaths.roostIndex },
			{ find: /^xpi-roost\/session$/, replacement: workspaceSourcePaths.roostSession },
			{ find: /^xpi-roost\/hub$/, replacement: workspaceSourcePaths.roostHub },
			{ find: /^xpi-shadow-git$/, replacement: workspaceSourcePaths.shadowGitIndex },
			{ find: /^xpi-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^xpi-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
		{ find: /^xpi-ai\/models$/, replacement: workspaceSourcePaths.aiModels },
			{ find: /^xpi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^xpi-ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{
				find: /^xpi-ai\/api\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiApi}/$1.ts`,
			},
			{
				find: /^xpi-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^xpi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^xpi-codemode$/, replacement: workspaceSourcePaths.codemodeIndex },
			{ find: /^xpi-codemode\/declarations$/, replacement: workspaceSourcePaths.codemodeDeclarations },
			{ find: /^xpi-codemode\/source$/, replacement: workspaceSourcePaths.codemodeSource },
			{ find: /^xpi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
