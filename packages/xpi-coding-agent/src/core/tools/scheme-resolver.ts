import { isAbsolute } from "node:path";
import type { ExtensionContext, SchemeHandler } from "../extensions/types.ts";
import type { SchemeRegistry } from "../schemes.ts";

/** What a `name://rest` path of a registered scheme stands for. */
export type SchemeTarget =
	| {
			/** A real file: the tool continues on `path`. */
			kind: "file";
			url: string;
			scheme: string;
			path: string;
			handler: SchemeHandler;
	  }
	| {
			/** A resource the handler serves; `read`, `write` and `edit` go through it. */
			kind: "virtual";
			url: string;
			scheme: string;
			handler: SchemeHandler;
	  };

const SCHEME_PREFIX = /^([a-z][a-z0-9+.-]*):\/\//;

/**
 * Turns a path with a registered scheme into a file path or a virtual resource. One resolver is shared by
 * `read`, `write`, `edit`, `ls`, `grep` and `find` (injected like the stale-edit guard's file-state store);
 * it reads the registry on every call, so schemes registered later are seen.
 */
export class SchemeResolver {
	private readonly registry: SchemeRegistry;
	private readonly createContext: () => ExtensionContext;

	/** `createContext` supplies the context handlers get when a tool is called without one. */
	constructor(registry: SchemeRegistry, createContext: () => ExtensionContext) {
		this.registry = registry;
		this.createContext = createContext;
	}

	/** The target for `path`, or undefined when it is not `name://...` of a registered scheme. */
	async resolve(path: string, ctx?: ExtensionContext): Promise<SchemeTarget | undefined> {
		const url = path.startsWith("@") ? path.slice(1) : path;
		const name = SCHEME_PREFIX.exec(url)?.[1];
		const scheme = name === undefined ? undefined : this.registry.get(name);
		if (!scheme) return undefined;
		const { handler } = scheme;
		if (!handler.locate) return { kind: "virtual", url, scheme: scheme.name, handler };
		const located = await handler.locate(url, ctx ?? this.createContext());
		if (typeof located !== "string" || !isAbsolute(located)) {
			throw new Error(`${scheme.name}:// locate() must return an absolute path for ${url}, got ${String(located)}`);
		}
		return { kind: "file", url, scheme: scheme.name, path: located, handler };
	}

	/** The current content of a virtual resource. */
	async read(target: SchemeTarget & { kind: "virtual" }, ctx?: ExtensionContext): Promise<string> {
		// resolve is set: validateScheme requires one of resolve/locate and a locate target is never virtual.
		const result = await target.handler.resolve!(target.url, ctx ?? this.createContext());
		if (typeof result?.content !== "string") {
			throw new Error(`${target.scheme}:// resolve() must return { content: string } for ${target.url}`);
		}
		return result.content;
	}

	/** Throw "<scheme>:// is read-only" when the target cannot be written (`write` and `edit`). */
	assertWritable(target: SchemeTarget): void {
		if (target.handler.readOnly || (target.kind === "virtual" && !target.handler.write)) {
			throw new Error(`${target.scheme}:// is read-only`);
		}
	}

	/** Write a virtual resource through its handler. Call {@link assertWritable} first. */
	async write(target: SchemeTarget & { kind: "virtual" }, content: string, ctx?: ExtensionContext): Promise<void> {
		await target.handler.write!(target.url, content, ctx ?? this.createContext());
	}

	/**
	 * The path `ls`, `grep` and `find` search: `path` itself, or the located file of a file-backed scheme.
	 * A virtual resource has nothing to list or search, so it fails with a pointer to `read`.
	 */
	async searchPath(path: string, ctx?: ExtensionContext): Promise<string> {
		const target = await this.resolve(path, ctx);
		if (!target) return path;
		if (target.kind === "virtual") throw new Error(`${target.url} is a virtual resource; use read`);
		return target.path;
	}
}
