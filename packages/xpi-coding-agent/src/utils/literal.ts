// A JSON-like literal as a person writes it in JS: quotes of any kind, bare keys, trailing commas, `//` and `/* */`
// comments. It is parsed, never run, so a file that holds one cannot execute code by being read: a template with
// `${}` is refused. Saved workflows read their `meta` with it, graph files their whole definition.

export class LiteralParser {
	private pos = 0;
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}

	get end(): number {
		return this.pos;
	}

	private fail(what: string): never {
		throw new Error(`${what} at offset ${this.pos}`);
	}

	private skip(): void {
		for (;;) {
			const rest = this.text.slice(this.pos);
			const ws = /^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest);
			if (!ws) return;
			this.pos += ws[0].length;
		}
	}

	value(): unknown {
		this.skip();
		const c = this.text[this.pos];
		if (c === "{") return this.object();
		if (c === "[") return this.array();
		if (c === '"' || c === "'" || c === "`") return this.string();
		const word = /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)/.exec(this.text.slice(this.pos));
		if (!word) this.fail("expected a plain value (string, number, boolean, null, array or object)");
		this.pos += word[0].length;
		return word[1] === "true" ? true : word[1] === "false" ? false : word[1] === "null" ? null : Number(word[0]);
	}

	private string(): string {
		const quote = this.text[this.pos++];
		let out = "";
		while (this.pos < this.text.length) {
			const c = this.text[this.pos++];
			if (c === quote) return out;
			if (quote === "`" && c === "$" && this.text[this.pos] === "{")
				this.fail("template expressions are not allowed");
			if (c === "\\") {
				const e = this.text[this.pos++];
				out += e === "n" ? "\n" : e === "t" ? "\t" : e;
			} else out += c;
		}
		return this.fail("unterminated string");
	}

	private array(): unknown[] {
		this.pos++;
		const out: unknown[] = [];
		for (;;) {
			this.skip();
			if (this.text[this.pos] === "]") {
				this.pos++;
				return out;
			}
			out.push(this.value());
			this.skip();
			if (this.text[this.pos] === ",") this.pos++;
			else if (this.text[this.pos] !== "]") this.fail("expected , or ]");
		}
	}

	private object(): Record<string, unknown> {
		this.pos++;
		const out: Record<string, unknown> = {};
		for (;;) {
			this.skip();
			if (this.text[this.pos] === "}") {
				this.pos++;
				return out;
			}
			const c = this.text[this.pos];
			let key: string;
			if (c === '"' || c === "'") key = this.string();
			else {
				const id = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.pos));
				if (!id) this.fail("expected a property name");
				key = id[0];
				this.pos += key.length;
			}
			this.skip();
			if (this.text[this.pos++] !== ":") this.fail("expected :");
			out[key] = this.value();
			this.skip();
			if (this.text[this.pos] === ",") this.pos++;
			else if (this.text[this.pos] !== "}") this.fail("expected , or }");
		}
	}
}
