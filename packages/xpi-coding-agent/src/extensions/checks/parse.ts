// Turns a check command's output into errors, and compares two checks. Plain functions: no session, no process.

import { isAbsolute, relative } from "node:path";
import type { RunResult } from "./runner.ts";

export interface CheckError {
	command: string;
	/** Relative to the working directory when it lies inside it; "" for an unparsed failure. */
	file: string;
	line: number;
	col: number;
	message: string;
}

/** Lines of output kept when a failing command could not be parsed. */
const UNPARSED_TAIL_LINES = 20;

// tsc: path(line,col): error TS2322: message
const TSC = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+:\s*.*)$/;
// GitHub annotation: ::error file=path,line=n,col=n,title=...::message  (also ::warning, which is ignored)
const GITHUB = /^::(error|warning)\s+(.*?)::(.*)$/;
// mypy: path:line: error: message
const MYPY = /^(.+?):(\d+):\s+error:\s+(.*)$/;
// ruff concise, eslint unix, gcc-like: path:line:col: message
const COLON = /^(.+?):(\d+):(\d+):\s+(.*)$/;

function relativeTo(cwd: string, file: string): string {
	if (!isAbsolute(file)) return file.replace(/^\.\//, "");
	const rel = relative(cwd, file);
	return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? file : rel;
}

function githubProps(text: string): Map<string, string> {
	const props = new Map<string, string>();
	for (const part of text.split(",")) {
		const eq = part.indexOf("=");
		if (eq > 0) props.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
	}
	return props;
}

// A message that is a warning or a note, not an error: the generic formats carry no severity field.
const NOT_AN_ERROR = /^(warning|note)\b/i;

interface LineMatch {
	/** The line is in a known format, even when it is not an error (a warning). */
	matched: boolean;
	error?: CheckError;
}

function parseLine(line: string, cwd: string, command: string): LineMatch {
	const make = (file: string, row: string, col: string, message: string): LineMatch => {
		const text = message.trim();
		if (NOT_AN_ERROR.test(text) || text.includes("[Warning/")) return { matched: true };
		return {
			matched: true,
			error: { command, file: relativeTo(cwd, file), line: Number(row), col: Number(col), message: text },
		};
	};
	let m = TSC.exec(line);
	if (m) return make(m[1], m[2], m[3], m[4]);
	m = GITHUB.exec(line);
	if (m) {
		// Only ::error counts; a recognised ::warning is not an error and is not retried as another format.
		if (m[1] !== "error") return { matched: true };
		const props = githubProps(m[2]);
		return {
			matched: true,
			error: {
				command,
				file: relativeTo(cwd, props.get("file") ?? ""),
				line: Number(props.get("line") ?? 0),
				col: Number(props.get("col") ?? 0),
				message: m[3].trim(),
			},
		};
	}
	m = MYPY.exec(line);
	if (m) return make(m[1], m[2], "0", m[3]);
	m = COLON.exec(line);
	if (m) return make(m[1], m[2], m[3], m[4]);
	return { matched: false };
}

/**
 * Errors in one command's output. A line that matches no known format is ignored; when no line matched at all but
 * the command failed, the failure is one error holding the output's last lines, with the exit code as its message
 * so the same failure stays the same error between checks. A process killed by a signal we did not send (out of
 * memory, a crash) has no exit code and counts as a failure the same way, with the message "signal".
 */
export function parseCheckOutput(result: RunResult, cwd: string): CheckError[] {
	const lines = result.output.split(/\r?\n/);
	const errors: CheckError[] = [];
	let recognised = false;
	for (const line of lines) {
		const match = parseLine(line.trimEnd(), cwd, result.command);
		if (match.matched) recognised = true;
		if (match.error) errors.push(match.error);
	}
	if (recognised || result.code === 0) return errors;
	const tail = lines.filter((line) => line.trim() !== "").slice(-UNPARSED_TAIL_LINES);
	const head = result.code === null ? "signal" : `exit ${result.code}`;
	return [{ command: result.command, file: "", line: 0, col: 0, message: `${head}\n${tail.join("\n")}` }];
}

/** The identity of an error: its position is left out so an edit above an old error does not make it new. */
export function errorKey(error: CheckError): string {
	// An unparsed failure is identified by its command and exit code only; its output tail may vary.
	const message = error.file === "" ? error.message.split("\n", 1)[0] : error.message;
	return JSON.stringify([error.command, error.file, message]);
}

/** Errors in `current` that `baseline` does not have, counting duplicates: two where there was one is one new. */
export function newErrors(baseline: readonly CheckError[], current: readonly CheckError[]): CheckError[] {
	const known = new Map<string, number>();
	for (const error of baseline) known.set(errorKey(error), (known.get(errorKey(error)) ?? 0) + 1);
	const fresh: CheckError[] = [];
	for (const error of current) {
		const key = errorKey(error);
		const left = known.get(key) ?? 0;
		if (left > 0) known.set(key, left - 1);
		else fresh.push(error);
	}
	return fresh;
}

/** One line for the model: `path:line:col message (command)`. */
export function formatError(error: CheckError): string {
	const where = error.file === "" ? "" : `${error.file}:${error.line}:${error.col} `;
	return `${where}${error.message} (${error.command})`;
}
