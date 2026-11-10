import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Fingerprint of a text file's content that ignores trailing spaces, tabs and CR on every line, so an
 * editor trimming whitespace or converting line endings does not count as a change. Feed the file in
 * decoded pieces of any size with `update`, then call `digest` once.
 */
export class TextFingerprint {
	private readonly hash = createHash("sha256");
	private carry = "";
	private pending = "";

	update(text: string): void {
		const lines = (this.carry + text).split("\n");
		this.carry = lines.pop() ?? "";
		for (const line of lines) this.addLine(line, "\n");
	}

	digest(): string {
		this.addLine(this.carry, "");
		this.carry = "";
		this.hash.update(this.pending);
		this.pending = "";
		return this.hash.digest("hex");
	}

	private addLine(line: string, terminator: string): void {
		let end = line.length;
		while (end > 0) {
			const char = line.charCodeAt(end - 1);
			if (char !== 0x20 && char !== 0x09 && char !== 0x0d) break;
			end--;
		}
		this.pending += line.slice(0, end) + terminator;
		if (this.pending.length > 65536) {
			this.hash.update(this.pending);
			this.pending = "";
		}
	}
}

export function fingerprintText(text: string): string {
	const fingerprint = new TextFingerprint();
	fingerprint.update(text);
	return fingerprint.digest();
}

/** Real path when the file exists, else the resolved path (a file about to be created). */
async function fileKey(filePath: string): Promise<string> {
	const resolved = resolve(filePath);
	try {
		return await realpath(resolved);
	} catch {
		return resolved;
	}
}

/** Key of a virtual resource. Real keys are absolute paths, so the prefix keeps the two apart. */
function urlKey(url: string): string {
	return `url:${url}`;
}

/**
 * What one session has seen of each file: the fingerprint of the last text read, edit or write. `edit` and
 * `write` over an existing file consult it so they never overwrite changes the model has not seen.
 * Nothing is persisted: a new store (new session, resumed session, fork, subagent process) knows no file.
 */
export class FileStateStore {
	private readonly fingerprints = new Map<string, string>();
	private readonly isEnabled: () => boolean;

	constructor(isEnabled: () => boolean = () => true) {
		this.isEnabled = isEnabled;
	}

	get enabled(): boolean {
		return this.isEnabled();
	}

	/** Remember the content of a file as the model now knows it. Recorded even while the guard is off. */
	async record(absolutePath: string, fingerprint: string): Promise<void> {
		this.fingerprints.set(await fileKey(absolutePath), fingerprint);
	}

	/**
	 * Throw when the file was not read in this session, or its content differs from the last read or write.
	 * `action` ends the message: "editing" or "overwriting it". Does nothing while the guard is off.
	 */
	async verify(
		absolutePath: string,
		displayPath: string,
		currentFingerprint: string,
		action: "editing" | "overwriting it",
	): Promise<void> {
		if (!this.enabled) return;
		this.check(await fileKey(absolutePath), `File ${displayPath}`, currentFingerprint, action);
	}

	/** Like {@link record} for a virtual resource, keyed by its URL (see `registerScheme`). */
	recordUrl(url: string, fingerprint: string): void {
		this.fingerprints.set(urlKey(url), fingerprint);
	}

	/** Like {@link verify} for a virtual resource, keyed by its URL. */
	verifyUrl(url: string, currentFingerprint: string, action: "editing" | "overwriting it"): void {
		if (!this.enabled) return;
		this.check(urlKey(url), `Resource ${url}`, currentFingerprint, action);
	}

	private check(key: string, label: string, currentFingerprint: string, action: string): void {
		const known = this.fingerprints.get(key);
		if (known === undefined) {
			throw new Error(`${label} has not been read in this session. Read it before ${action}.`);
		}
		if (known !== currentFingerprint) {
			throw new Error(`${label} changed since you last read it. Read it again before ${action}.`);
		}
	}
}
