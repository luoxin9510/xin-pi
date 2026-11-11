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

/**
 * A key a read ended inside waits this long for the rest before it goes to the session as it
 * is (a terminal sends a key in one write; this is for one that never ends). A lone ESC is not
 * held: it is sent at once, as pi-roost did, so the Escape key has no delay.
 */
const HOLD_MS = 100;
/** More than this unfinished (an OSC string without its end) is sent on, not held. */
const HOLD_MAX = 64;
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
		return n <= s.length - i ? n : undefined;
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
 * `pasting` carries a paste across chunks. `done` is where the whole keys end (the rest is
 * a key the input ends inside). Offsets are bytes (latin1).
 */
export function localDetachAt(
	s: string,
	isDetachKey: DetachKeyMatcher,
	pasting = false,
): { at: number; end: number; pasting: boolean; done: number } {
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
		if (n === undefined) return { at: -1, end: -1, pasting, done: i };
		if (!pasting && isDetachKey(Buffer.from(s.slice(i, i + n), "latin1").toString("utf8")))
			return { at: i, end: i + n, pasting, done: i + n };
		i += n;
	}
	return { at: -1, end: -1, pasting, done: s.length };
}

/**
 * The input of an attached terminal, read by read (bytes as latin1): what goes to the
 * session now, and whether the detach key came. A key that a read ends inside (an escape
 * sequence of any kind, a UTF-8 character) is held until it is whole, so the first half of
 * the detach key never reaches the session; `flush` sends a held key that never finished.
 * A lone ESC is sent at once and still read again with what follows.
 */
export class DetachScanner {
	/** The unfinished key; its first `sent` bytes went to the session already. */
	private carry = "";
	private sent = 0;
	private pasting = false;
	private lastInput = 0;
	private readonly isDetachKey: DetachKeyMatcher;

	constructor(isDetachKey: DetachKeyMatcher) {
		this.isDetachKey = isDetachKey;
	}

	push(text: string, now: number): { send: string; detach: boolean; held: boolean } {
		// a paste whose end marker was lost does not swallow the detach key for ever
		if (this.pasting && now - this.lastInput > PASTE_IDLE_MS) this.pasting = false;
		this.lastInput = now;
		const scan = this.carry + text;
		const r = localDetachAt(scan, this.isDetachKey, this.pasting);
		this.pasting = r.pasting;
		if (r.at !== -1) {
			// what was typed before it still goes; what follows it is the view's
			const send = r.at > this.sent ? scan.slice(this.sent, r.at) : "";
			this.carry = "";
			this.sent = 0;
			return { send, detach: true, held: false };
		}
		let send = r.done > this.sent ? scan.slice(this.sent, r.done) : "";
		this.carry = scan.slice(r.done);
		this.sent = Math.max(0, this.sent - r.done);
		if (this.carry === "\x1b" && this.sent === 0) {
			send += this.carry;
			this.sent = 1;
		} else if (this.carry.length > HOLD_MAX) {
			send += this.carry.slice(this.sent);
			this.carry = "";
			this.sent = 0;
		}
		return { send, detach: false, held: this.carry.length > this.sent };
	}

	/** The held bytes, now sent (still read again with the next input). */
	flush(): string {
		const out = this.carry.slice(this.sent);
		this.sent = this.carry.length;
		return out;
	}
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
		const scanner = new DetachScanner(opts.isDetachKey);
		let holdTimer: NodeJS.Timeout | undefined;
		const send = (bytes: string) => {
			if (bytes) sock?.write(encodeFrame(FrameType.DATA, Buffer.from(bytes, "latin1")));
		};
		const onInput = (chunk: Buffer | string) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
			clearTimeout(holdTimer);
			const r = scanner.push(buf.toString("latin1"), Date.now());
			send(r.send);
			if (r.detach) return finish("local");
			if (r.held) holdTimer = setTimeout(() => send(scanner.flush()), HOLD_MS);
		};
		const onResize = () => sock?.write(encodeJsonFrame(FrameType.RESIZE, size()));

		const finish = (reason: DetachReason) => {
			if (settled) return;
			settled = true;
			clearTimeout(holdTimer);
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
