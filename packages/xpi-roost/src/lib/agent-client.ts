/**
 * The session side of the protocol (docs/protocol.md): a job's identity from its
 * environment, and reports (a full snapshot each time, coalesced, resent after a daemon
 * restart), with replies delivered on the reporting connection and acked by seq. The xpi
 * worker is built on it.
 */
import { DaemonClient } from "./client.ts";
import { readJobEnv } from "./identity.ts";
import type { Event, HelloArgs, HelloResult, WorkerReport } from "./protocol.ts";
import { sameUsage } from "./usage.ts";
import { SUMMARY_INTERVAL_MS, sameContext, stateChanged } from "./worker-state.ts";

/** A delivered reply. */
export type DeliverItem = Pick<Extract<Event, { event: "deliver" }>, "seq" | "text" | "mode">;

export interface JobIdentity {
	id: string;
	token: string;
	socket: string;
}

const SAVED = Symbol.for("xpi-roost.jobIdentity");

/**
 * Set in a worker's environment by the PTY host. The token is removed from the
 * environment once read (M9), so a /reload finds the identity kept in this process.
 */
export function jobIdentity(env: NodeJS.ProcessEnv = process.env): JobIdentity | undefined {
	const id = readJobEnv(env, "id");
	const token = readJobEnv(env, "token");
	const socket = readJobEnv(env, "socket");
	const g = globalThis as { [SAVED]?: JobIdentity };
	if (id && token && socket) {
		if (env === process.env) g[SAVED] = { id, token, socket };
		return { id, token, socket };
	}
	return env === process.env && g[SAVED]?.id === id ? g[SAVED] : undefined;
}

const REQUEST_TIMEOUT_MS = 4000;
const FINAL_FLUSH_MS = 500;

/**
 * Sends the latest report, one request at a time, reconnecting after daemon
 * restarts; never throws. State changes go out at once, row text at most
 * every SUMMARY_INTERVAL_MS.
 */
export class Reporter {
	private client: DaemonClient | undefined;
	private latest: WorkerReport | undefined;
	private sent: WorkerReport | undefined;
	private sentAt = 0;
	private urgentPending = false;
	private timer: NodeJS.Timeout | undefined;
	private dueAt = Number.POSITIVE_INFINITY;
	private inflight: Promise<void> | undefined;
	private retryMs = 500;
	/** M22: after a failed request nothing goes out before this (not even a state change). */
	private backoffUntil = 0;
	private closed = false;
	private job: JobIdentity;
	private onDeliver: (item: DeliverItem) => void;

	/** Row text and context use alone go out at most this often (tests shorten it). */
	private intervalMs: number;

	/** M31: said on every new connection before the first report. */
	private hello: HelloArgs | undefined;
	/** M31: what the daemon answered (undefined: no answer yet, or a daemon from before M31). */
	daemonHello: HelloResult | undefined;

	constructor(
		job: JobIdentity,
		onDeliver: (item: DeliverItem) => void = () => {},
		intervalMs = SUMMARY_INTERVAL_MS,
		hello?: HelloArgs,
	) {
		this.job = job;
		this.onDeliver = onDeliver;
		this.intervalMs = intervalMs;
		this.hello = hello;
	}

	/** `urgent`: send now even when only the row text changed (a model summary). */
	update(report: WorkerReport, urgent = false): void {
		this.latest = report;
		if (urgent) this.urgentPending = true;
		this.schedule();
	}

	/** Send what is pending (bounded wait), then disconnect. */
	async close(): Promise<void> {
		if (this.closed) return;
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.latest && this.latest !== this.sent) {
			await Promise.race([this.drain(), new Promise((r) => setTimeout(r, FINAL_FLUSH_MS))]);
		}
		this.closed = true;
		clearTimeout(this.timer);
		this.client?.close();
		this.client = undefined;
	}

	private async drain(): Promise<void> {
		while (!this.closed && this.latest && this.latest !== this.sent) {
			await (this.inflight ?? this.send());
			if (this.latest !== this.sent) await new Promise((r) => setTimeout(r, 50));
		}
	}

	private schedule(): void {
		if (this.closed || this.inflight || !this.latest || this.latest === this.sent) return;
		const urgent = this.urgentPending || stateChanged(this.sent, this.latest);
		if (
			!urgent &&
			this.latest.summary === this.sent?.summary &&
			sameContext(this.latest.context, this.sent?.context) &&
			sameUsage(this.latest.usage, this.sent?.usage)
		)
			return;
		const due = Math.max(
			urgent ? Date.now() : Math.max(Date.now(), this.sentAt + this.intervalMs),
			this.backoffUntil,
		);
		if (this.timer && due >= this.dueAt) return;
		clearTimeout(this.timer);
		this.dueAt = due;
		this.timer = setTimeout(() => void this.send(), due - Date.now());
		this.timer.unref?.();
	}

	private send(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.dueAt = Number.POSITIVE_INFINITY;
		const report = this.latest;
		if (!report || this.closed) return Promise.resolve();
		this.urgentPending = false;
		this.inflight = this.request(report).finally(() => {
			this.inflight = undefined;
		});
		return this.inflight.then(() => this.schedule());
	}

	/** Tell the daemon a reply reached the session; best effort, a lost ack means a resend that is deduplicated. */
	ack(seq: number): void {
		this.client?.request("ack", { id: this.job.id, token: this.job.token, seq }).catch(() => {});
	}

	private async request(report: WorkerReport): Promise<void> {
		try {
			if (!this.client) {
				const fresh = await DaemonClient.connect(this.job.socket);
				// Replies come back on the connection this worker reports on.
				fresh.onEvent((e) => {
					if (e.event === "deliver" && e.id === this.job.id) this.onDeliver(e);
				});
				// A daemon restart drops the connection: report again at once so replies
				// can reach an idle worker that has nothing new to say.
				fresh.onClose(() => {
					if (this.client !== fresh) return;
					this.client = undefined;
					this.sent = undefined;
					this.schedule();
				});
				this.client = fresh;
				// M31: a daemon from before the protocol does not know hello: it reports all the same
				if (this.hello) {
					this.daemonHello = await Promise.race([
						fresh.request("hello", this.hello),
						new Promise<undefined>((r) => setTimeout(() => r(undefined), REQUEST_TIMEOUT_MS).unref?.()),
					]).catch(() => undefined);
				}
			}
			const client = this.client;
			await Promise.race([
				client.request("report", { id: this.job.id, token: this.job.token, report }),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("report timed out")), REQUEST_TIMEOUT_MS).unref?.(),
				),
			]);
			this.sent = report;
			this.sentAt = Date.now();
			this.retryMs = 500;
			this.backoffUntil = 0;
		} catch {
			const dead = this.client;
			this.client = undefined;
			dead?.close();
			if (this.closed) return;
			// The daemon may be restarting: try again with the newest report later.
			clearTimeout(this.timer);
			this.dueAt = Date.now() + this.retryMs;
			this.backoffUntil = this.dueAt;
			this.timer = setTimeout(() => void this.send(), this.retryMs);
			this.timer.unref?.();
			this.retryMs = Math.min(this.retryMs * 2, 5000);
		}
	}
}
