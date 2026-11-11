import { describe, expect, it } from "vitest";
import { DetachScanner, isLocalDetach, keyLength, localDetachAt } from "../src/lib/attach.ts";

// Decision 11: the detach key is the caller's (xpi passes the user's app.suspend binding;
// its encodings are tested in xpi-coding-agent). Here: the input is cut into whole keys,
// each is asked about once, and a paste is text. M22: the key is found wherever it is.
const seen: string[] = [];
const ctrlZ = (key: string) => {
	seen.push(key);
	return key === "\x1a" || key === "\x1b[122;5u";
};

describe("local detach key", () => {
	it("is found alone and among other keys, as the caller's matcher says", () => {
		expect(isLocalDetach(Buffer.from("\x1a"), ctrlZ)).toBe(true);
		expect(isLocalDetach(Buffer.from("\x1b[122;5u"), ctrlZ)).toBe(true);
		expect(isLocalDetach(Buffer.from("a\x1a"), ctrlZ)).toBe(false);
		expect(localDetachAt("xyz\x1a", ctrlZ)).toMatchObject({ at: 3, end: 4 });
		expect(localDetachAt("ab\x1b[1;5Acd\x1b[122;5uef", ctrlZ)).toMatchObject({ at: 10, end: 18 });
		// no key of its own: another matcher, another key
		expect(localDetachAt("x\x1a\x04", (k) => k === "\x04")).toMatchObject({ at: 2, end: 3 });
		expect(localDetachAt("x\x1a", () => false).at).toBe(-1);
	});

	it("asks about whole keys: sequences, ESC and a character, UTF-8 characters", () => {
		seen.length = 0;
		// input arrives as bytes (latin1 here); a key is handed over decoded
		const bytes = Buffer.from("a\x1b[27;5;122~\x1bOP\x1bxé中\x1b]0;t\x07z", "utf8").toString("latin1");
		localDetachAt(bytes, ctrlZ);
		expect(seen).toEqual(["a", "\x1b[27;5;122~", "\x1bOP", "\x1bx", "é", "中", "\x1b]0;t\x07", "z"]);
		// a sequence cut off at the end is not a key yet (the next chunk finishes it)
		expect(keyLength("\x1b[122;", 0)).toBeUndefined();
		expect(keyLength("\x1b", 0)).toBeUndefined();
		seen.length = 0;
		expect(localDetachAt("a\x1b[122;5", ctrlZ).at).toBe(-1);
		expect(seen).toEqual(["a"]);
	});

	it("is text inside a paste, also across chunks", () => {
		expect(localDetachAt("\x1b[200~a\x1ab\x1b[201~", ctrlZ).at).toBe(-1);
		const first = localDetachAt("\x1b[200~abc", ctrlZ);
		expect(first).toMatchObject({ at: -1, pasting: true });
		expect(localDetachAt("d\x1ae", ctrlZ, first.pasting).at).toBe(-1);
		expect(localDetachAt("\x1b[201~\x1a", ctrlZ, true).at).toBe(6);
	});

	it("a key split over reads is held until whole, of every kind; a lone ESC goes at once", () => {
		const f1 = (k: string) => k === "\x1bOP";
		const sc = new DetachScanner(f1);
		// SS3 (F1) in two reads: nothing of it reaches the session
		expect(sc.push("a\x1bO", 0)).toEqual({ send: "a", detach: false, held: true });
		expect(sc.push("P", 1)).toEqual({ send: "", detach: true, held: false });
		// ESC alone: sent at once (no delay for the Escape key), and still read with what follows
		const esc = new DetachScanner(f1);
		expect(esc.push("\x1b", 0)).toEqual({ send: "\x1b", detach: false, held: false });
		expect(esc.push("OQ", 1)).toEqual({ send: "OQ", detach: false, held: false });
		expect(new DetachScanner(f1).push("\x1b", 0).send).toBe("\x1b");
		// a CSI, an OSC and a UTF-8 character cut off: held, then sent whole with their rest
		const other = new DetachScanner(ctrlZ);
		expect(other.push("x\x1b[122;", 0)).toEqual({ send: "x", detach: false, held: true });
		expect(other.push("5", 1)).toEqual({ send: "", detach: false, held: true });
		expect(other.push("u", 2)).toEqual({ send: "", detach: true, held: false });
		const osc = new DetachScanner(ctrlZ);
		expect(osc.push("\x1b]0;ti", 0).held).toBe(true);
		expect(osc.push("tle\x07", 1).send).toBe("\x1b]0;title\x07");
		const utf8 = Buffer.from("é", "utf8").toString("latin1");
		const u = new DetachScanner(ctrlZ);
		expect(u.push(utf8[0]!, 0)).toEqual({ send: "", detach: false, held: true });
		expect(u.push(utf8[1]!, 1).send).toBe(utf8);
		// a key that never finishes is flushed (by the attach loop's timer), and not sent twice
		const stray = new DetachScanner(ctrlZ);
		stray.push("\x1b[12", 0);
		expect(stray.flush()).toBe("\x1b[12");
		expect(stray.push("3~", 1)).toEqual({ send: "3~", detach: false, held: false });
		// an endless OSC is not held
		const long = new DetachScanner(ctrlZ);
		expect(long.push(`\x1b]0;${"x".repeat(100)}`, 0)).toMatchObject({ held: false });
	});

	it("a paste across reads keeps the key as text; one whose end was lost stops after a second", () => {
		const sc = new DetachScanner(ctrlZ);
		expect(sc.push("\x1b[200~ab", 0).detach).toBe(false);
		expect(sc.push("\x1a", 10).detach).toBe(false);
		expect(sc.push("\x1a", 2000)).toMatchObject({ send: "", detach: true });
	});
});
