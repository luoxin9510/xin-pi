import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, ImageContent } from "xpi-ai";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	interruptedRun: ReturnType<typeof vi.fn>;
	continueRun: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		interruptedRun: vi.fn(() => undefined),
		continueRun: vi.fn(async () => ({ ran: false, reason: "finished" })),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	// #10799
	it("warns on stderr and returns non-zero when the response was truncated", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ stopReason: "length" }));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalled();
	});

	// .scratch/xpi-durable: `/continue` runs through continueRun(); when it does not run, print mode says why and exits
	// 0, even when the last message is an aborted reply (roost would otherwise read the exit as a crash).
	it("says why /continue did not run and exits 0, whatever the last reply", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ stopReason: "aborted" }));
		runtimeHost.session.continueRun.mockResolvedValue({ ran: false, reason: "stopped" });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "/continue",
		});

		expect(exitCode).toBe(0);
		expect(runtimeHost.session.prompt).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith("Nothing to continue: the last run was stopped.");
	});

	it("checks the reply of a /continue that ran, and tells about a cut-off run at open", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "went on" }));
		runtimeHost.session.interruptedRun.mockReturnValue({ startedAt: 1, danglingToolCalls: [] });
		runtimeHost.session.continueRun.mockResolvedValue({ ran: true });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: " /continue ",
		});

		expect(exitCode).toBe(0);
		expect(runtimeHost.session.continueRun).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("The last run stopped before it finished"));
	});

	it("refuses /continue with arguments", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "/continue now",
		});

		expect(exitCode).toBe(1);
		expect(runtimeHost.session.continueRun).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith("/continue takes no arguments.");
	});

	// A signal during the final disposal used to hit no handler and kill pi mid-dispose.
	it("waits for the final disposal when SIGTERM arrives during it, and exits on a repeated SIGTERM", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		let finishDispose = () => {};
		runtimeHost.dispose.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishDispose = resolve;
				}),
		);
		const listenersBefore = process.listenerCount("SIGTERM");

		const run = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
		});
		await vi.waitFor(() => expect(runtimeHost.dispose).toHaveBeenCalledTimes(1));
		expect(process.listenerCount("SIGTERM")).toBe(listenersBefore + 1);

		process.emit("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(exitSpy).not.toHaveBeenCalled();
		expect(runtimeHost.dispose).toHaveBeenCalledTimes(1);

		process.emit("SIGTERM");
		expect(exitSpy).toHaveBeenCalledWith(143);

		finishDispose();
		await run;
		expect(process.listenerCount("SIGTERM")).toBe(listenersBefore);
	});
});
