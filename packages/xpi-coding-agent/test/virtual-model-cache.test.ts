import { describe, expect, it } from "vitest";
import { fauxProvider, InMemoryModelsStore } from "xpi-ai";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { ModelRoute } from "../src/core/virtual-models.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

async function runtimeWith(cache: unknown) {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(fauxProvider({ models: [{ id: "large" }] }).provider);
	runtime.registerVirtualModel({
		provider: "router",
		id: "auto",
		name: "Auto",
		route: (): ModelRoute => ({
			model: runtime.getModel("faux", "large")!,
			thinkingLevel: "off",
			cache: cache as ModelRoute["cache"],
		}),
	});
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

const resolve = async (cache: unknown, reason: "user" | "direct" = "user") => {
	const runtime = await runtimeWith(cache);
	return runtime.resolveModel(runtime.getModel("router", "auto")!, [], { reason, thinkingLevel: "off" });
};

describe("ModelRoute.cache", () => {
	it("carries a valid label through resolveModel", async () => {
		expect((await resolve({ key: "lead" })).cache).toEqual({ key: "lead" });
		expect((await resolve({ key: "worker", holdPrefix: "lead" })).cache).toEqual({
			key: "worker",
			holdPrefix: "lead",
		});
		expect((await resolve(undefined)).cache).toBeUndefined();
	});

	it("rejects a bad label, naming the virtual model", async () => {
		for (const bad of [
			"lead",
			null,
			{},
			{ key: "" },
			{ key: 3 },
			{ key: "a", holdPrefix: "" },
			{ key: "a", holdPrefix: 4 },
			{ key: "a", holdPrefix: "a" },
		]) {
			await expect(resolve(bad)).rejects.toThrow(/Virtual model router\/auto returned cache/);
		}
	});

	it("ignores the label for direct requests, even a bad one", async () => {
		expect((await resolve({ key: "lead" }, "direct")).cache).toBeUndefined();
		expect((await resolve({ key: "a", holdPrefix: "a" }, "direct")).cache).toBeUndefined();
	});
});

describe("cache_warming_decision with a key", () => {
	it("passes the key to handlers and lets them override", async () => {
		const runtime = createExtensionRuntime();
		const seen: Array<string | undefined> = [];
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.on("cache_warming_decision", (event) => {
					seen.push(event.key);
					return { action: "stop" };
				});
			},
			process.cwd(),
			createEventBus(),
			runtime,
		);
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), registry);
		const action = await runner.emitCacheWarmingDecision({
			type: "cache_warming_decision",
			key: "lead",
			warmCost: 0.01,
			missCost: 0.1,
			continuationProbability: 1,
			action: "warm",
		});
		expect(action).toBe("stop");
		expect(seen).toEqual(["lead"]);
	});
});
