import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("uses anyrouter.top defaults", () => {
	const config = loadConfig({});
	assert.equal(config.rootBaseUrl, "https://anyrouter.top");
	assert.equal(config.openaiBaseUrl, "https://anyrouter.top/v1");
	assert.equal(config.anthropicBaseUrl, "https://anyrouter.top");
	assert.equal(config.modelsUrl, "https://anyrouter.top/v1/models");
	assert.equal(config.openaiApi, "openai-responses");
	assert.equal(config.claudeApi, "anthropic-messages");
	assert.deepEqual(config.openaiKeywords, ["gpt"]);
	assert.deepEqual(config.claudeKeywords, ["claude"]);
	assert.equal(config.anthropicAuthMode, "both");
	assert.equal(config.retry.maxRetries, 60);
	assert.deepEqual(config.retry.retryStatuses, [429, 500, 502, 503, 504]);
});

test("normalizes a /v1 root for both protocols", () => {
	const config = loadConfig({ ANYROUTER_BASE_URL: "https://relay.example/v1" });
	assert.equal(config.rootBaseUrl, "https://relay.example");
	assert.equal(config.openaiBaseUrl, "https://relay.example/v1");
	assert.equal(config.anthropicBaseUrl, "https://relay.example");
	assert.equal(config.modelsUrl, "https://relay.example/v1/models");
});

test("reads protocol, filter, auth, and retry overrides", () => {
	const config = loadConfig({
		ANYROUTER_OPENAI_API: "completions",
		ANYROUTER_OPENAI_FILTER: "gpt,o3",
		ANYROUTER_CLAUDE_FILTER: "claude",
		ANYROUTER_ANTHROPIC_AUTH: "bearer",
		ANYROUTER_RETRY_MAX_RETRIES: "120",
		ANYROUTER_RETRY_BASE_DELAY_MS: "50",
		ANYROUTER_RETRY_MAX_DELAY_MS: "500",
		ANYROUTER_RETRY_STATUSES: "429,503",
	});
	assert.equal(config.openaiApi, "openai-completions");
	assert.deepEqual(config.openaiKeywords, ["gpt", "o3"]);
	assert.equal(config.anthropicAuthMode, "bearer");
	assert.equal(config.retry.maxRetries, 120);
	assert.equal(config.retry.baseDelayMs, 50);
	assert.equal(config.retry.maxDelayMs, 500);
	assert.deepEqual(config.retry.retryStatuses, [429, 503]);
});

test("parses explicit model lists", () => {
	const config = loadConfig({
		ANYROUTER_MODELS: "gpt-5.5, claude-sonnet-4-5, unknown-model",
		ANYROUTER_OPENAI_MODELS: "gpt-5-codex",
		ANYROUTER_CLAUDE_MODELS: "claude-opus-4-5",
	});
	assert.deepEqual(config.explicitModels, ["gpt-5.5", "claude-sonnet-4-5", "unknown-model"]);
	assert.deepEqual(config.explicitOpenAIModels, ["gpt-5-codex"]);
	assert.deepEqual(config.explicitClaudeModels, ["claude-opus-4-5"]);
});
