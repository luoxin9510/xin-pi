/**
 * Protected Paths Extension
 *
 * Blocks calls of tools whose effect is "write" (write, edit, and any tool that declares it) to protected paths.
 * Useful for preventing accidental modifications to sensitive files.
 */

import type { ExtensionAPI } from "xpi-coding-agent";

export default function (pi: ExtensionAPI) {
	const protectedPaths = [".env", ".git/", "node_modules/"];

	pi.on("tool_call", async (event, ctx) => {
		const input: Record<string, unknown> = event.input;
		if (event.effect !== "write" || typeof input.path !== "string") {
			return undefined;
		}

		const path = input.path;
		const isProtected = protectedPaths.some((p) => path.includes(p));

		if (isProtected) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
			}
			return { block: true, reason: `Path "${path}" is protected` };
		}

		return undefined;
	});
}
