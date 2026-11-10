import type { SchemeHandler } from "./extensions/types.ts";

/** Names an extension cannot take: the file tools and bash already give these meaning. */
export const RESERVED_SCHEME_NAMES: readonly string[] = ["http", "https", "file", "data"];

const SCHEME_NAME = /^[a-z][a-z0-9+.-]*$/;

/** A scheme an extension registered with `pi.registerScheme()`. */
export interface RegisteredScheme {
	name: string;
	handler: SchemeHandler;
	/** Path of the extension that registered the scheme. */
	extensionPath: string;
}

/**
 * Check a `registerScheme` call. Extension code is a trust boundary: the types do not hold for plain JavaScript.
 * Returns the problem, or undefined when the name and handler are valid.
 */
export function validateScheme(name: string, handler: SchemeHandler): string | undefined {
	if (typeof name !== "string" || !SCHEME_NAME.test(name)) {
		return `scheme name "${String(name)}" must start with a lowercase letter and contain only lowercase letters, digits, "+", "." and "-"`;
	}
	if (RESERVED_SCHEME_NAMES.includes(name)) return `scheme name "${name}" is reserved`;
	if (typeof handler !== "object" || handler === null) return "the handler must be an object";
	if (typeof handler.describe !== "string" || handler.describe.trim() === "" || /[\r\n]/.test(handler.describe)) {
		return "describe must be a non-empty single line";
	}
	const hasResolve = handler.resolve !== undefined;
	const hasLocate = handler.locate !== undefined;
	if (hasResolve === hasLocate) return "set exactly one of resolve (virtual) and locate (file-backed)";
	if (hasResolve && typeof handler.resolve !== "function") return "resolve must be a function";
	if (hasLocate && typeof handler.locate !== "function") return "locate must be a function";
	if (handler.write !== undefined) {
		if (typeof handler.write !== "function") return "write must be a function";
		if (hasLocate) return "write is for virtual schemes; a file-backed scheme writes to the located file";
	}
	if (handler.readOnly !== undefined && typeof handler.readOnly !== "boolean") return "readOnly must be a boolean";
	return undefined;
}

/** Schemes registered by the extensions of one runtime, in registration order. */
export class SchemeRegistry {
	private readonly schemes = new Map<string, RegisteredScheme>();

	/** The caller has validated the scheme and checked that the name is free. */
	register(scheme: RegisteredScheme): void {
		this.schemes.set(scheme.name, scheme);
	}

	get(name: string): RegisteredScheme | undefined {
		return this.schemes.get(name);
	}

	list(): RegisteredScheme[] {
		return [...this.schemes.values()];
	}
}
