import assert from "node:assert/strict";
import test from "node:test";
import type { Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.ts";
import anyrouterProvider from "../src/index.ts";
import { buildModel } from "../src/models.ts";

function register(): Provider {
	let registered: Provider | undefined;
	anyrouterProvider({
		registerProvider(provider: Provider) {
			registered = provider;
		},
		on() {
			return () => {};
		},
	} as never);
	assert.ok(registered);
	return registered;
}

function resetEnv(): void {
	for (const name of [
		"ANYROUTER_MODELS",
		"ANYROUTER_OPENAI_MODELS",
		"ANYROUTER_CLAUDE_MODELS",
		"ANYROUTER_RETRY_BASE_DELAY_MS",
		"ANYROUTER_RETRY_MAX_DELAY_MS",
		"ANYROUTER_RETRY_MAX_RETRIES",
	]) {
		delete process.env[name];
	}
}

test("registers an anyrouter API-key provider", () => {
	resetEnv();
	const provider = register();
	assert.equal(provider.id, "anyrouter");
	assert.equal(provider.name, "AnyRouter");
	assert.equal(provider.baseUrl, "https://anyrouter.top");
	assert.equal(typeof provider.stream, "function");
	assert.equal(typeof provider.streamSimple, "function");
	assert.ok(provider.auth.apiKey);
	assert.deepEqual(provider.getModels(), []);
});

test("registers explicit model lists", () => {
	resetEnv();
	process.env.ANYROUTER_MODELS = "gpt-5.5,claude-sonnet-4-5";
	process.env.ANYROUTER_OPENAI_MODELS = "custom-gpt";
	process.env.ANYROUTER_CLAUDE_MODELS = "custom-claude";
	const provider = register();
	assert.deepEqual(
		provider.getModels().map((model) => [model.id, model.api]),
		[
			["gpt-5.5", "openai-responses"],
			["claude-sonnet-4-5", "anthropic-messages"],
			["custom-gpt", "openai-responses"],
			["custom-claude", "anthropic-messages"],
		],
	);
	resetEnv();
});

test("discovers models and retries a discovery 429", async () => {
	resetEnv();
	process.env.ANYROUTER_RETRY_BASE_DELAY_MS = "1";
	process.env.ANYROUTER_RETRY_MAX_DELAY_MS = "1";
	const provider = register();
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		assert.match(url, /\/v1\/models$/);
		calls++;
		if (calls < 3) return new Response("busy", { status: 429 });
		return Response.json({
			data: [{ id: "gpt-5.5" }, { id: "claude-sonnet-4-5" }, { id: "o3" }],
		});
	}) as typeof globalThis.fetch;

	try {
		const context: RefreshModelsContext = {
			credential: { type: "api_key", key: "sk-test" },
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		};
		await provider.refreshModels?.(context);
		assert.equal(calls, 3);
		assert.deepEqual(
			provider.getModels().map((model) => model.id),
			["gpt-5.5", "claude-sonnet-4-5"],
		);
	} finally {
		globalThis.fetch = originalFetch;
		resetEnv();
	}
});

test("restores the stored catalog offline without a credential", async () => {
	resetEnv();
	const provider = register();
	const stored = buildModel("gpt-5.5", "openai", loadConfig({}));
	let updateRan = false;

	await provider.refreshModels?.({
		allowNetwork: false,
		stored: { models: [stored] },
		signal: new AbortController().signal,
		publish: async (publication) => {
			publication.update?.();
			updateRan = true;
			return true;
		},
	});

	assert.equal(updateRan, true);
	assert.deepEqual(
		provider.getModels().map((model) => model.id),
		["gpt-5.5"],
	);
});

test("keeps the stored catalog when the models endpoint is missing", async () => {
	resetEnv();
	process.env.ANYROUTER_RETRY_BASE_DELAY_MS = "1";
	process.env.ANYROUTER_RETRY_MAX_DELAY_MS = "1";
	const provider = register();
	const stored = buildModel("claude-sonnet-4-5", "claude", loadConfig({}));
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return new Response("not found", { status: 404 });
	}) as typeof globalThis.fetch;

	try {
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "sk-test" },
			allowNetwork: true,
			stored: { models: [stored] },
			signal: new AbortController().signal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});
		assert.equal(calls, 1);
		assert.deepEqual(
			provider.getModels().map((model) => model.id),
			["claude-sonnet-4-5"],
		);
	} finally {
		globalThis.fetch = originalFetch;
		resetEnv();
	}
});
