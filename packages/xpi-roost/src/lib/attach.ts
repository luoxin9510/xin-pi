import { connect, type Socket } from "node:net";
import { encodeFrame, encodeJsonFrame, type Frame, FrameDecoder, FrameType, parseJsonPayload } from "./framing.ts";
import { checkLevels, socketDirLevels } from "./paths.ts";

export type DetachReason = "local" | "takeover" | "exit" | "request" | "closed" | "error";

export interface AttachIO {
	stdin: NodeJS.ReadStream;
	stdout: NodeJS.WriteStream;
}

/**
 * Decision 11: which key detaches is the caller's (xpi passes the user's `app.suspend`
 * keybinding); this library has no key of its own. It is asked about each key in the
 * input, one at a time: a whole escape sequence, ESC and a character, a UTF-8 character or
 * a control byte. A key release, if the caller does not want it, is the caller's to refuse.
 */
export type DetachKeyMatcher = (key: string) => boolean;

/** The start of an escape sequence a chunk may end in (sent on: only the scan waits for the rest). */
const PARTIAL_ESC = /\x1b(?:\[[\d;:]*)?$/;
/** No input for this long while in a paste: its end marker was lost. */
const PASTE_IDLE_MS = 1000;

// Modes a worker may have left on (AT-4): kitty keyboard, bracketed paste,
// mouse tracking, focus events, modifyOtherKeys, synchronized output; then autowrap and
// the cursor back. Leaving the alternate screen (M14) is added only when the session
// entered it: in a terminal on its main screen ?1049l may restore a stale cursor.
export const TERMINAL_RESET =
	"\x1b[<u\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[>4;0m\x1b[?2026l\x1b[?7h\x1b[?25h";
const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";

/** Whether `chunk` leaves the alternate screen on (true), off (false) or as it was. */
export function altScreenAfter(chunk: string, was: boolean): boolean {
	const on = chunk.lastIndexOf(ALT_ON);
	const off = chunk.lastIndexOf(ALT_OFF);
	return on === off ? was : on > off;
}

export function isLocalDetach(chunk: Buffer, isDetachKey: DetachKeyMatcher): boolean {
	const s = chunk.toString("latin1");
	const r = localDetachAt(s, isDetachKey);
	return r.at === 0 && r.end === s.length;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * The length of the key at `i` of `s` (bytes as latin1): a CSI or SS3 sequence, an OSC
 * string, ESC and one character, a UTF-8 character, or one byte. Undefined when the input
 * ends inside a sequence (the next chunk finishes it).
 */
export function keyLength(s: string, i: number): number | undefined {
	const c = s.charCodeAt(i);
	if (c !== 0x1b) {
		const n = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
		return Math.min(n, s.length - i);
	}
	if (i + 1 >= s.length) return undefined;
	const next = s[i + 1];
	if (next === "[") {
		let j = i + 2;
		while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
		while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
		if (j >= s.length) return undefined;
		const f = s.charCodeAt(j);
		return f >= 0x40 && f <= 0x7e ? j - i + 1 : 1;
	}
	if (next === "O") return i + 2 < s.length ? 3 : undefined;
	if (next === "]") {
		const bel = s.indexOf("\x07", i + 2);
		const st = s.indexOf("\x1b\\", i + 2);
		const ends = [bel === -1 ? -1 : bel + 1, st === -1 ? -1 : st + 2].filter((e) => e > 0);
		return ends.length > 0 ? Math.min(...ends) - i : undefined;
	}
	if (next === "\x1b") return 1;
	return 2;
}

/**
 * M22: where the local detach key is in a chunk of input, if anywhere. Keys typed fast,
 * a terminal or multiplexer that batches input, or a lock key held on can put it among
 * other bytes; sent on, it would reach the session's xpi, which suspends itself, and
 * nothing in the background would ever continue it. Inside a bracketed paste it is text.
 * `pasting` carries a paste across chunks. Offsets are bytes (latin1).
 */
export function localDetachAt(
	s: string,
	isDetachKey: DetachKeyMatcher,
	pasting = false,
): { at: number; end: number; pasting: boolean } {
	for (let i = 0; i < s.length; ) {
		if (s.startsWith(PASTE_START, i)) {
			pasting = true;
			i += PASTE_START.length;
			continue;
		}
		if (s.startsWith(PASTE_END, i)) {
			pasting = false;
			i += PASTE_END.length;
			continue;
		}
		const n = keyLength(s, i);
		if (n === undefined) break;
		if (!pasting && isDetachKey(Buffer.from(s.slice(i, i + n), "latin1").toString("utf8")))
			return { at: i, end: i + n, pasting };
		i += n;
	}
	return { at: -1, end: -1, pasting };
}

/**
 * Pass the terminal through to a job's PTY host until detach. The caller owns
 * the terminal before and after: this only toggles raw mode while attached.
 */
export function attachToHost(
	socketPath: string,
	io: AttachIO,
	opts: { isDetachKey: DetachKeyMatcher },
): Promise<DetachReason> {
	// the host's socket is in the runtime directory: its levels are checked before it is used
	try {
		checkLevels(socketDirLevels(socketPath));
	} catch (err) {
		return Promise.reject(err);
	}
	return new Promise((resolve) => {
		const { stdin, stdout } = io;
		const wasRaw = stdin.isTTY ? stdin.isRaw : false;
		const decoder = new FrameDecoder();
		let settled = false;
		let sock: Socket | undefined;
		let alt = false;
		/** A host since M14 greets first; an older one only redraws, so clear for it. */
		let greeted: boolean | undefined;

		const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
		let pasting = false;
		let lastInput = 0;
		// the unfinished escape sequence a chunk ended in: the next chunk may finish it
		let tail = "";
		const onInput = (chunk: Buffer | string) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
			const now = Date.now();
			// a paste whose end marker was lost does not swallow the detach key for ever
			if (pasting && now - lastInput > PASTE_IDLE_MS) pasting = false;
			lastInput = now;
			const text = buf.toString("latin1");
			const scan = tail + text;
			const r = localDetachAt(scan, opts.isDetachKey, pasting);
			pasting = r.pasting;
			const at = r.at - tail.length;
			tail = (PARTIAL_ESC.exec(scan)?.[0] ?? "").slice(-32);
			if (r.at === -1) {
				sock?.write(encodeFrame(FrameType.DATA, buf));
				return;
			}
			// what was typed before it still goes; what follows it is the view's
			if (at > 0) sock?.write(encodeFrame(FrameType.DATA, buf.subarray(0, at)));
			finish("local");
		};
		const onResize = () => sock?.write(encodeJsonFrame(FrameType.RESIZE, size()));

		const finish = (reason: DetachReason) => {
			if (settled) return;
			settled = true;
			stdin.off("data", onInput);
			stdout.off("resize", onResize);
			stdin.pause();
			if (stdin.isTTY) stdin.setRawMode(wasRaw);
			stdout.write(TERMINAL_RESET + (alt ? ALT_OFF : ""));
			sock?.destroy();
			resolve(reason);
		};

		sock = connect(socketPath);
		sock.on("connect", () => {
			// the host greets, then sends its own copy of the screen (M21); a host from before
			// M14 sends neither, so the first data clears the screen (below)
			sock?.write(encodeJsonFrame(FrameType.HELLO, { role: "attach", ...size() }));
			if (stdin.isTTY) stdin.setRawMode(true);
			stdin.on("data", onInput);
			stdin.resume();
			stdout.on("resize", onResize);
		});
		sock.on("data", (chunk) => {
			let frames: Frame[];
			try {
				frames = decoder.push(chunk);
			} catch {
				return finish("error");
			}
			for (const frame of frames) {
				if (frame.type === FrameType.HELLO) greeted = true;
				else if (frame.type === FrameType.DATA) {
					if (greeted === undefined) {
						greeted = false;
						stdout.write("\x1b[2J\x1b[H");
					}
					alt = altScreenAfter(frame.payload.toString("latin1"), alt);
					stdout.write(frame.payload);
				} else if (frame.type === FrameType.DETACHED) {
					const { reason } = parseJsonPayload<{ reason: DetachReason }>(frame);
					return finish(reason);
				}
			}
		});
		sock.on("error", () => finish("error"));
		sock.on("close", () => finish("closed"));
	});
}
