import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryModelsStore } from "xpi-ai";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager, type UsageEntry } from "../../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../../src/core/settings-manager.ts";
import relayExtension, { RELAY_MODEL, RELAY_PROVIDER } from "../../src/extensions/relay/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

/** Wait in real time (the clock is faked) until `condition` holds; the handover does real work before the worker starts. */
async function until(condition: () => boolean): Promise<void> {
	const deadline = performance.now() + 5_000;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error("condition not reached");
		await new Promise((resolve) => setImmediate(resolve));
	}
}

const PRICES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

describe("relay holds the lead's prefix through the real session wiring", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "xpi-relay-warm-"));
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function setup(relay: Record<string, unknown> = {}) {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({
			models: [
				{ id: "small", contextWindow: 50_000, cost: PRICES, promptCache: { short: 300 } },
				{ id: "large", contextWindow: 1_000_000, maxTokens: 4000, cost: PRICES, promptCache: { short: 300 } },
			],
		});
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });
		const extensionsResult = await createTestExtensionsResult([relayExtension], tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(tempDir),
			settingsManager: SettingsManager.inMemory({
				cacheWarming: "streaming",
				relay: { lead: "faux/large", worker: "faux/small", ...relay },
			} as Partial<Settings>),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		await session.bindExtensions({});
		await session.setModel(runtime.getModel(RELAY_PROVIDER, RELAY_MODEL)!);
		return { session, faux, dispose: () => session.dispose() };
	}

	const warmEntries = (session: { sessionManager: SessionManager }) =>
		session.sessionManager
			.getEntries()
			.filter((entry): entry is UsageEntry => entry.type === "usage" && entry.kind === "cache_warm");

	it("refreshes the lead's prefix during a long worker phase and puts it on the branch", async () => {
		const { session, faux, dispose } = await setup();
		try {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const seen: { model: string; user: string; maxTokens?: number }[] = [];
			const lastUser = (context: { messages: { role: string; content: unknown }[] }) => {
				const message = context.messages.filter((m) => m.role === "user").at(-1);
				return typeof message?.content === "string" ? message.content : "";
			};
			faux.setResponses([
				(context, options, _state, model) => {
					seen.push({ model: model.id, user: lastUser(context as never), maxTokens: options?.maxTokens });
					return fauxAssistantMessage(fauxToolCall("handover", { plan: "do it", acceptance: ["true"] }), {
						stopReason: "toolUse",
					});
				},
				async (context, options, _state, model) => {
					seen.push({ model: model.id, user: lastUser(context as never), maxTokens: options?.maxTokens });
					await gate;
					return fauxAssistantMessage(fauxToolCall("handback", { status: "done", report: "done" }), {
						stopReason: "toolUse",
					});
				},
				// The refresh is a request of its own; it takes this response.
				(context, options, _state, model) => {
					seen.push({ model: model.id, user: lastUser(context as never), maxTokens: options?.maxTokens });
					return fauxAssistantMessage("");
				},
				(context, options, _state, model) => {
					seen.push({ model: model.id, user: lastUser(context as never), maxTokens: options?.maxTokens });
					return fauxAssistantMessage("fine");
				},
			]);
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const prompt = session.prompt("start");
			// The worker's request waits at the gate while the lead's cache entry would expire.
			await until(() => seen.length === 2);
			await vi.advanceTimersByTimeAsync(1);
			expect(session.heldPrefixStatus).toMatchObject({ key: "lead", refreshes: 0 });
			await vi.advanceTimersByTimeAsync(270_000);
			release();
			await vi.advanceTimersByTimeAsync(1_000);
			await prompt;

			const refresh = seen.filter((request) => request.maxTokens === 1);
			expect(refresh).toHaveLength(1);
			expect(refresh[0]).toMatchObject({ model: "large", user: "." });
			const entries = warmEntries(session);
			expect(entries).toHaveLength(1);
			expect(entries[0].note).toBe("held prefix: lead");
			// The hold ends with the run.
			expect(session.heldPrefixStatus).toBeUndefined();
		} finally {
			dispose();
		}
	});

	it("sends no refresh when warmLead is false", async () => {
		const { session, faux, dispose } = await setup({ warmLead: false });
		try {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("handover", { plan: "do it", acceptance: ["true"] }), {
					stopReason: "toolUse",
				}),
				async () => {
					await gate;
					return fauxAssistantMessage(fauxToolCall("handback", { status: "done", report: "done" }), {
						stopReason: "toolUse",
					});
				},
				fauxAssistantMessage("fine"),
			]);
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const prompt = session.prompt("start");
			await until(() => session.messages.some((m) => m.role === "toolResult"));
			await vi.advanceTimersByTimeAsync(1_000);
			expect(session.heldPrefixStatus).toBeUndefined();
			await vi.advanceTimersByTimeAsync(600_000);
			release();
			await vi.advanceTimersByTimeAsync(1_000);
			await prompt;
			expect(warmEntries(session)).toHaveLength(0);
		} finally {
			dispose();
		}
	});
});
