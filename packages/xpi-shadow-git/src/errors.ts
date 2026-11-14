/**
 * A command that ends with a message and an exit code: 1 for a git or adapter failure, 2 for a failed
 * precondition (a dirty tree, a broken invariant, no repo, a git that is too old).
 */
export class SgError extends Error {
	readonly code: 1 | 2;

	constructor(message: string, code: 1 | 2) {
		super(message);
		this.name = "SgError";
		this.code = code;
	}
}

/** A failed precondition (exit 2). */
export const precondition = (message: string): SgError => new SgError(message, 2);

/** A git or adapter failure (exit 1). */
export const failure = (message: string): SgError => new SgError(message, 1);
