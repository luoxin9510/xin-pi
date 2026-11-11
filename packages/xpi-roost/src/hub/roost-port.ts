// M71: the hub's one port to the daemon: every call the hub makes, as a typed method grouped by
// area. `roostPort(client)` is the adapter over `DaemonClient`; each method is one request and
// returns its result as it came. Tests use `test/support/roost-port.ts`. Phase 1: the sessions
// and the event feed (no task board, concierge or schedules: decision 6).
import { type DaemonClient, requestOnce } from "../lib/client.ts";
import type { ArgsOf, Event, ResultOf } from "../lib/protocol.ts";

type Once = { timeoutMs?: number; tag?: string };

export interface RoostPort {
	/** Pushed events: subscribe on the daemon and hand each event to `onEvent`. */
	subscribe(onEvent: (e: Event) => void): Promise<void>;
	/** Pushed events, without subscribing; returns the way off. */
	listen(onEvent: (e: Event) => void): () => void;
	/** The place in the stream of the line being handled now. */
	position(): number;

	jobs: {
		list(args: ArgsOf<"list">): Promise<ResultOf<"list">>;
		/** The list and where its reply was in the stream (events with a higher `position()` came after). */
		listAt(args: ArgsOf<"list">): Promise<{ result: ResultOf<"list">; at: number }>;
		stop(id: string): Promise<ResultOf<"stop">>;
		rm(id: string): Promise<ResultOf<"rm">>;
		pin(id: string, pinned: boolean): Promise<ResultOf<"pin">>;
		rename(id: string, name: string): Promise<ResultOf<"rename">>;
		reorder(ids: string[], key: string): Promise<ResultOf<"reorder">>;
		respawn(id: string): Promise<ResultOf<"respawn">>;
		/** M51: sent with a request id, again on the new connection while the daemon restarts. */
		reply(args: ArgsOf<"reply">, opts?: Once): Promise<ResultOf<"reply">>;
		dispatch(args: ArgsOf<"dispatch">, opts?: Once): Promise<ResultOf<"dispatch">>;
	};

	events: {
		/** The event feed (what happened). */
		list(args: ArgsOf<"events">): Promise<ResultOf<"events">>;
	};
}

/** The sends that wait through a reconnect: they hold no connection, `via` gives one at each try (M51). */
export type Sends = Pick<RoostPort["jobs"], "reply" | "dispatch">;
export function sends(via: (deadline: number) => Promise<DaemonClient>): Sends {
	return {
		reply: (args, opts) => requestOnce(via, "reply", args, opts),
		dispatch: (args, opts) => requestOnce(via, "dispatch", args, opts),
	};
}

/**
 * The adapter. `via(deadline)` gives the connection for `reply` and `dispatch` (M51: the hub's
 * hands the one made again after a restart); by default, this client.
 */
export function roostPort(
	client: DaemonClient,
	via: (deadline: number) => Promise<DaemonClient> = async () => client,
): RoostPort {
	const once = sends(via);
	return {
		subscribe: async (onEvent) => {
			client.onEvent(onEvent);
			await client.request("subscribe", {});
		},
		listen: (onEvent) => client.onEvent(onEvent),
		position: () => client.position(),

		jobs: {
			list: (args) => client.request("list", args),
			listAt: (args) => client.requestAt("list", args),
			stop: (id) => client.request("stop", { id }),
			rm: (id) => client.request("rm", { id }),
			pin: (id, pinned) => client.request("pin", { id, pinned }),
			rename: (id, name) => client.request("rename", { id, name }),
			reorder: (ids, key) => client.request("reorder", { ids, key }),
			respawn: (id) => client.request("respawn", { id }),
			reply: once.reply,
			dispatch: once.dispatch,
		},

		events: { list: (args) => client.request("events", args) },
	};
}
