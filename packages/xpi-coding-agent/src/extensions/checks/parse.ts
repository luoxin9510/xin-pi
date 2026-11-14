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

function parseLine(line: string, cwd: string, command: string): CheckError | undefined {
	let m = TSC.exec(line);
	if (m) return { command, file: relativeTo(cwd, m[1]), line: Number(m[2]), col: Number(m[3]), message: m[4].trim() };
	m = GITHUB.exec(line);
	if (m) {
		// Only ::error counts; a recognised ::warning is not an error and is not retried as another format.
		if (m[1] !== "error") return undefined;
		const props = githubProps(m[2]);
		return {
			command,
			file: relativeTo(cwd, props.get("file") ?? ""),
			line: Number(props.get("line") ?? 0),
			col: Number(props.get("col") ?? 0),
			message: m[3].trim(),
		};
	}
	m = MYPY.exec(line);
	if (m) return { command, file: relativeTo(cwd, m[1]), line: Number(m[2]), col: 0, message: m[3].trim() };
	m = COLON.exec(line);
	if (m) return { command, file: relativeTo(cwd, m[1]), line: Number(m[2]), col: Number(m[3]), message: m[4].trim() };
	return undefined;
}

function isRecognised(line: string): boolean {
	return GITHUB.test(line) || parseLine(line, "", "") !== undefined;
}

/**
 * Errors in one command's output. A line that matches no known format is ignored; when no line matched at all but
 * the command failed, the failure is one error holding the output's last lines, with the exit code as its message
 * so the same failure stays the same error between checks.
 */
export function parseCheckOutput(result: RunResult, cwd: string): CheckError[] {
	const lines = result.output.split(/\r?\n/);
	const errors: CheckError[] = [];
	let recognised = false;
	for (const line of lines) {
		const error = parseLine(line.trimEnd(), cwd, result.command);
		if (error) errors.push(error);
		if (error || isRecognised(line.trimEnd())) recognised = true;
	}
	if (recognised || result.code === 0 || result.code === null) return errors;
	const tail = lines.filter((line) => line.trim() !== "").slice(-UNPARSED_TAIL_LINES);
	return [{ command: result.command, file: "", line: 0, col: 0, message: `exit ${result.code}\n${tail.join("\n")}` }];
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
