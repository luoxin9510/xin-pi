import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { withFileMutationQueue, withUrlMutationQueue } from "./file-mutation-queue.ts";
import { type FileStateStore, fingerprintText } from "./file-state.ts";
import { resolveToCwd } from "./path-utils.ts";
import { writeRenderers } from "./renderers/write.ts";
import type { SchemeResolver } from "./scheme-resolver.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["Use write only for new files or complete rewrites."],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
	/**
	 * Read the current contents of an existing file; reject with code ENOENT or ENOTDIR when it does not
	 * exist. The stale-edit guard needs it to tell an overwrite from a new file; without it the guard
	 * does not check this tool's writes.
	 */
	readFile?: (absolutePath: string) => Promise<Buffer>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
	readFile: (path) => fsReadFile(path),
};

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
	/**
	 * What the session has read. When set, overwriting an existing file fails if it was not read through the
	 * same store or changed since. Creating a new file needs no read. Without a store the tool overwrites
	 * any file, as before.
	 */
	fileState?: FileStateStore;
	/**
	 * Resolves `name://...` paths of registered schemes (`registerScheme`). A file-backed scheme writes the
	 * located file like any path; a virtual one writes through the handler's `write`, one call per URL at a time.
	 */
	schemes?: SchemeResolver;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	const fileState = options?.fileState;
	const schemes = options?.schemes;
	return {
		name: "write",
		label: "write",
		effect: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const target = await schemes?.resolve(path, ctx);
			if (schemes && target) schemes.assertWritable(target);
			if (schemes && target?.kind === "virtual") {
				return withUrlMutationQueue(target.url, async () => {
					// As below: checking after each await keeps the queue locked until the handler has settled.
					const throwIfAborted = (): void => {
						if (signal?.aborted) throw new Error("Operation aborted");
					};
					throwIfAborted();
					if (fileState?.enabled) {
						let existing: string | undefined;
						try {
							existing = await schemes.read(target, ctx);
						} catch {
							// A resource the handler cannot resolve does not exist yet: this write creates it.
						}
						throwIfAborted();
						if (existing !== undefined)
							fileState.verifyUrl(target.url, fingerprintText(existing), "overwriting it");
					}
					await schemes.write(target, content, ctx);
					fileState?.recordUrl(target.url, fingerprintText(content));
					throwIfAborted();
					return {
						content: [{ type: "text" as const, text: `Successfully wrote to ${path}` }],
						details: undefined,
					};
				});
			}
			const absolutePath = resolveToCwd(target?.kind === "file" ? target.path : path, ctx?.cwd || cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				if (fileState?.enabled && ops.readFile) {
					let existing: Buffer | undefined;
					try {
						existing = await ops.readFile(absolutePath);
					} catch (error: unknown) {
						if (!isMissingFileError(error)) throw error;
					}
					throwIfAborted();
					if (existing)
						await fileState.verify(
							absolutePath,
							path,
							fingerprintText(existing.toString("utf-8")),
							"overwriting it",
						);
				}

				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				// Write the file contents.
				await ops.writeFile(absolutePath, content);
				await fileState?.record(absolutePath, fingerprintText(content));
				throwIfAborted();

				return {
					content: [{ type: "text", text: `Successfully wrote to ${path}` }],
					details: undefined,
				};
			});
		},
		...writeRenderers,
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): TypeBoxAgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
