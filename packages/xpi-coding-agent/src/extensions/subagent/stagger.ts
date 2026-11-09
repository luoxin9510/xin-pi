// Opt-in staggered start (`subagent.staggerStart`). Siblings that start in the same moment each pay to write the same
// prompt prefix (tools, system head) to the provider's cache: none can read an entry another is still writing. Behind
// this gate the first child with a prefix key leads and the later ones wait until a response to that prefix has begun
// (the entry is then readable), or STAGGER_TIMEOUT_MS have passed; then they all go. Process-wide, like the
// concurrency limit.

export const STAGGER_TIMEOUT_MS = 5_000;
// A cached prefix stays readable for the provider's 5 minutes after its last use. For this long after a response
// nobody has anything to wait for.
export const WARM_MS = 4 * 60_000;

const gates = new Map<string, { opened: Promise<void>; open: () => void }>(); // prefix key -> its leader's gate
const warm = new Map<string, number>(); // prefix key -> when a response to it last began

// A child with this key got the start of a response: the prefix is in the cache.
export function responded(key: string): void {
	warm.set(key, Date.now());
	gates.get(key)?.open();
}

// Resolves when a child with this key may start. The leader gets the function that opens its gate and must call it
// when its run ends, however it ends; a follower gets undefined. Rejects "aborted" when the signal fires in the wait.
export async function stagger(key: string, signal: AbortSignal | undefined): Promise<(() => void) | undefined> {
	const leading = gates.get(key);
	if (leading) {
		await new Promise<void>((resolve, reject) => {
			if (signal?.aborted) return reject(new Error("aborted"));
			const cancel = () => reject(new Error("aborted"));
			signal?.addEventListener("abort", cancel, { once: true });
			void leading.opened.then(() => {
				signal?.removeEventListener("abort", cancel);
				resolve();
			});
		});
		return undefined;
	}
	if (Date.now() - (warm.get(key) ?? Number.NEGATIVE_INFINITY) < WARM_MS) return undefined;

	let resolve!: () => void;
	const opened = new Promise<void>((r) => {
		resolve = r;
	});
	const gate = {
		opened,
		open: () => {
			clearTimeout(timer);
			if (gates.get(key) === gate) gates.delete(key); // a later leader may have its own gate by now
			resolve();
		},
	};
	const timer = setTimeout(gate.open, STAGGER_TIMEOUT_MS);
	gates.set(key, gate);
	return gate.open;
}
