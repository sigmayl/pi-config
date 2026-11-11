import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import {
	buildModel,
	classifyModelId,
	configModels,
	displayName,
	modelsFromIds,
	parseModelIds,
	PROVIDER_ID,
} from "../src/models.ts";

const config = loadConfig({});

test("classifies by keyword", () => {
	assert.equal(classifyModelId("gpt-5.5", config), "openai");
	assert.equal(classifyModelId("claude-sonnet-4-5", config), "claude");
	assert.equal(classifyModelId("o3", config), undefined);
	assert.equal(classifyModelId("claude-gpt-hybrid", config), "claude");
});

test("formats display names", () => {
	assert.equal(displayName("gpt-5.5-2026-04-23"), "GPT-5.5");
	assert.equal(displayName("gpt-5-codex"), "GPT-5 Codex");
	assert.equal(displayName("gpt-4o-mini"), "GPT-4o Mini");
	assert.equal(displayName("claude-sonnet-4-5-20250929"), "Claude Sonnet 4.5");
	assert.equal(displayName("claude-3-7-sonnet-20250219"), "Claude Sonnet 3.7");
	assert.equal(displayName("claude-3-opus-20240229"), "Claude Opus 3");
	assert.equal(displayName("o3-mini"), "O3 Mini");
});

test("parses common model list shapes", () => {
	assert.deepEqual(parseIds({ data: [{ id: "gpt-5" }, { id: "claude-sonnet-4-5" }] }), [
		"gpt-5",
		"claude-sonnet-4-5",
	]);
	assert.deepEqual(parseIds({ models: ["a", "b"] }), ["a", "b"]);
	assert.deepEqual(parseIds(["a", { model: "b" }, { name: "c" }]), ["a", "b", "c"]);
	assert.deepEqual(parseIds({ result: { items: [{ id: "d" }] } }), ["d"]);
});

function parseIds(payload: unknown): string[] {
	return parseModelIds(payload);
}

test("uses built-in metadata for known models", () => {
	const claude = buildModel("claude-sonnet-4-5", "claude", config);
	assert.equal(claude.provider, PROVIDER_ID);
	assert.equal(claude.api, "anthropic-messages");
	assert.equal(claude.baseUrl, "https://anyrouter.top");
	assert.equal(claude.contextWindow, 200_000);
	assert.equal(claude.maxTokens, 64_000);
	assert.equal(claude.reasoning, true);
	assert.equal(claude.cost.input, 0);

	const gpt = buildModel("gpt-5.5-2026-04-23", "openai", config);
	assert.equal(gpt.api, "openai-responses");
	assert.equal(gpt.baseUrl, "https://anyrouter.top/v1");
	assert.equal(gpt.contextWindow, 272_000);
	assert.equal(gpt.maxTokens, 128_000);
	assert.equal(gpt.reasoning, true);
	assert.equal(gpt.name, "GPT-5.5");
});

test("falls back to heuristics for unknown models", () => {
	const model = buildModel("gpt-5-codex", "openai", config);
	assert.equal(model.contextWindow, 200_000);
	assert.equal(model.maxTokens, 32_000);
	assert.equal(model.reasoning, true);
});

test("filters discovered IDs by keyword and deduplicates", () => {
	const models = modelsFromIds(["gpt-5.5", "claude-sonnet-4-5", "o3", "gpt-5.5"], config);
	assert.deepEqual(
		models.map((model) => model.id),
		["gpt-5.5", "claude-sonnet-4-5"],
	);
});

test("builds explicit model lists with their declared kind", () => {
	const models = configModels(
		loadConfig({
			ANYROUTER_OPENAI_MODELS: "custom-openai-model",
			ANYROUTER_CLAUDE_MODELS: "custom-claude-model",
			ANYROUTER_MODELS: "gpt-5.5,ignored",
		}),
	);
	assert.deepEqual(
		models.map((model) => [model.id, model.api]),
		[
			["gpt-5.5", "openai-responses"],
			["custom-openai-model", "openai-responses"],
			["custom-claude-model", "anthropic-messages"],
		],
	);
});
