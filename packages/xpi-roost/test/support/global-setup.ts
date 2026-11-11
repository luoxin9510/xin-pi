import { sweepOrphans } from "../../src/lib/orphans.ts";

const log = (l: string) => console.log(`[roost tests] ${l}`);

// M78: processes an earlier killed run left behind go before this one starts, and what this
// run left (a host killed mid-start leaves node-pty's helper waiting) goes after it.
export default function setup(): () => void {
	sweepOrphans(log);
	return () => {
		sweepOrphans(log);
	};
}
