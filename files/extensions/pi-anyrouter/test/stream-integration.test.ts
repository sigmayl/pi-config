import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import anyrouterProvider from "../src/index.ts";
import { loadConfig } from "../src/config.ts";
import { buildModel } from "../src/models.ts";
import type { FetchLike } from "../src/retry-fetch.ts";

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: string;
}

function headerValue(headers: RequestInit["headers"] | undefined, name: string): string | null {
	return new Headers(headers).get(name);
}

function bodyText(body: RequestInit["body"] | undefined): string {
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return toString(body);
	return body === null || body === undefined ? "" : String(body);
}

function toString(value: Uint8Array): string {
	return new TextDecoder().decode(value);
}

function fakeRelay(
	sse: string,
	failures: number,
	failure: () => Response = () =>
		new Response('{"error":"busy"}', {
			status: 429,
			headers: { "content-type": "application/json", "retry-after": "0" },
		}),
): { fetch: FetchLike; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const request: CapturedRequest = {
			url: String(input),
			headers: new Headers(init?.headers),
			body: bodyText(init?.body),
		};
		requests.push(request);
		if (requests.length <= failures) return failure();
		return new Response(sse, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	return { fetch: fetchImpl, requests };
}

interface FakeUI {
	workingMessages: Array<string | undefined>;
	statuses: Array<[string, string | undefined]>;
	setWorkingMessage(message?: string): void;
	setStatus(key: string, text: string | undefined): void;
}

function fakeUI(): FakeUI {
	const ui: FakeUI = {
		workingMessages: [],
		statuses: [],
		setWorkingMessage(message) {
			ui.workingMessages.push(message);
		},
		setStatus(key, text) {
			ui.statuses.push([key, text]);
		},
	};
	return ui;
}

function fakePi(ui?: FakeUI): {
	provider: Provider;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
} {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let provider: Provider | undefined;
	anyrouterProvider({
		registerProvider(value: Provider) {
			provider = value;
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
	} as never);
	assert.ok(provider);
	if (ui) handlers.get("before_provider_request")?.({ type: "before_provider_request" }, { ui });
	return { provider, handlers };
}

function register(): Provider {
	return fakePi().provider;
}

function userContext(text: string) {
	return { messages: [{ role: "user" as const, content: text, timestamp: Date.now() }] };
}

const OPENAI_SSE = [
	'data: {"type":"response.created","response":{"id":"resp_1"}}',
	'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[],"status":"in_progress"}}',
	'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"hello"}',
	'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}],"status":"completed"}}',
	'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}',
	"",
].join("\n\n");

const CLAUDE_SSE = [
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":1}}}',
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
	'event: message_stop\ndata: {"type":"message_stop"}',
	"",
].join("\n\n");

async function runStream(
	provider: Provider,
	model: ReturnType<typeof buildModel>,
	fetchImpl: FetchLike,
	context: unknown = userContext("hi"),
) {
	const stream = provider.streamSimple(model, context as never, {
		apiKey: "sk-test",
		maxTokens: 16,
		fetch: fetchImpl as typeof globalThis.fetch,
	});
	return await stream.result();
}

test("OpenAI Responses retries 429 and reaches the fake relay", async () => {
	process.env.ANYROUTER_RETRY_BASE_DELAY_MS = "1";
	process.env.ANYROUTER_RETRY_MAX_DELAY_MS = "1";
	const provider = register();
	const relay = fakeRelay(OPENAI_SSE, 2);
	try {
		const model = buildModel("gpt-5.5", "openai", loadConfig(process.env));
		const message = await runStream(provider, model, relay.fetch);
		assert.equal(message.stopReason, "stop");
		assert.equal(message.content[0]?.type, "text");
		assert.equal((message.content[0] as { text: string }).text, "hello");
		assert.equal(relay.requests.length, 3);
		assert.match(relay.requests[0]?.url ?? "", /\/v1\/responses$/);
		assert.equal(relay.requests[0]?.headers.get("authorization"), "Bearer sk-test");
	} finally {
		delete process.env.ANYROUTER_RETRY_BASE_DELAY_MS;
		delete process.env.ANYROUTER_RETRY_MAX_DELAY_MS;
	}
});

test("OpenAI Responses retries AnyRouter capacity 500s (empty and get_channel_failed)", async () => {
	process.env.ANYROUTER_RETRY_BASE_DELAY_MS = "1";
	process.env.ANYROUTER_RETRY_MAX_DELAY_MS = "1";
	const provider = register();
	let n = 0;
	const relay = fakeRelay(OPENAI_SSE, 2, () =>
		++n === 1
			? new Response(null, { status: 500 })
			: new Response(
					JSON.stringify({
						error: { message: "当前模型 gpt-5.5 负载已经达到上限，请稍后重试", code: "get_channel_failed" },
					}),
					{ status: 500, headers: { "content-type": "application/json" } },
				),
	);
	try {
		const model = buildModel("gpt-5.5", "openai", loadConfig(process.env));
		const message = await runStream(provider, model, relay.fetch);
		assert.equal(message.stopReason, "stop");
		assert.equal((message.content[0] as { text: string }).text, "hello");
		assert.equal(relay.requests.length, 3);
	} finally {
		delete process.env.ANYROUTER_RETRY_BASE_DELAY_MS;
		delete process.env.ANYROUTER_RETRY_MAX_DELAY_MS;
	}
});

test("Claude Messages retries 429 and sends Claude Code auth", async () => {
	process.env.ANYROUTER_RETRY_BASE_DELAY_MS = "1";
	process.env.ANYROUTER_RETRY_MAX_DELAY_MS = "1";
	const provider = register();
	const relay = fakeRelay(CLAUDE_SSE, 1);
	try {
		const model = buildModel("claude-sonnet-4-5", "claude", loadConfig(process.env));
		const message = await runStream(provider, model, relay.fetch);
		assert.equal(message.stopReason, "stop");
		assert.equal((message.content[0] as { text: string }).text, "hello");
		assert.equal(relay.requests.length, 2);
		assert.match(relay.requests[0]?.url ?? "", /\/v1\/messages(?:\?|$)/);
		assert.equal(relay.requests[0]?.headers.get("x-api-key"), "sk-test");
		assert.equal(relay.requests[0]?.headers.get("authorization"), "Bearer sk-test");
	} finally {
		delete process.env.ANYROUTER_RETRY_BASE_DELAY_MS;
		delete process.env.ANYROUTER_RETRY_MAX_DELAY_MS;
	}
});

test("Claude can use Authorization-only auth", async () => {
	process.env.ANYROUTER_ANTHROPIC_AUTH = "bearer";
	process.env.ANYROUTER_RETRY_BASE_DELAY_MS = "1";
	process.env.ANYROUTER_RETRY_MAX_DELAY_MS = "1";
	const provider = register();
	const relay = fakeRelay(CLAUDE_SSE, 0);
	try {
		const model = buildModel("claude-sonnet-4-5", "claude", loadConfig(process.env));
		const message = await runStream(provider, model, relay.fetch);
		assert.equal(message.stopReason, "stop");
		assert.equal(relay.requests[0]?.headers.get("authorization"), "Bearer sk-test");
		assert.equal(relay.requests[0]?.headers.get("x-api-key"), null);
	} finally {
		delete process.env.ANYROUTER_ANTHROPIC_AUTH;
		delete process.env.ANYROUTER_RETRY_BASE_DELAY_MS;
		delete process.env.ANYROUTER_RETRY_MAX_DELAY_MS;
	}
});

test("shows squeeze retries in the working line and footer, then clears them", async () => {
	process.env.ANYROUTER_RETRY_BASE_DELAY_MS = "1";
	process.env.ANYROUTER_RETRY_MAX_DELAY_MS = "1";
	const ui = fakeUI();
	const { provider } = fakePi(ui);
	const relay = fakeRelay(OPENAI_SSE, 2);
	try {
		const model = buildModel("gpt-5.5", "openai", loadConfig(process.env));
		const message = await runStream(provider, model, relay.fetch);
		assert.equal(message.stopReason, "stop");
		assert.equal(relay.requests.length, 3);

		assert.equal(ui.workingMessages.length, 3);
		assert.match(ui.workingMessages[0] ?? "", /anyrouter 429 · retry 1\/60 · 1s/);
		assert.match(ui.workingMessages[1] ?? "", /anyrouter 429 · retry 2\/60/);
		assert.equal(ui.workingMessages.at(-1), undefined);

		assert.deepEqual(ui.statuses[0]?.[0], "anyrouter-retry");
		assert.match(ui.statuses[0]?.[1] ?? "", /retry 1\/60/);
		assert.deepEqual(ui.statuses.at(-1), ["anyrouter-retry", undefined]);
	} finally {
		delete process.env.ANYROUTER_RETRY_BASE_DELAY_MS;
		delete process.env.ANYROUTER_RETRY_MAX_DELAY_MS;
	}
});

test("ANYROUTER_RETRY_NOTICE=off keeps retries silent", async () => {
	process.env.ANYROUTER_RETRY_BASE_DELAY_MS = "1";
	process.env.ANYROUTER_RETRY_MAX_DELAY_MS = "1";
	process.env.ANYROUTER_RETRY_NOTICE = "off";
	const ui = fakeUI();
	const { provider } = fakePi(ui);
	const relay = fakeRelay(OPENAI_SSE, 1);
	try {
		const model = buildModel("gpt-5.5", "openai", loadConfig(process.env));
		const message = await runStream(provider, model, relay.fetch);
		assert.equal(message.stopReason, "stop");
		assert.equal(relay.requests.length, 2);
		assert.deepEqual(ui.workingMessages, []);
		assert.deepEqual(ui.statuses, []);
	} finally {
		delete process.env.ANYROUTER_RETRY_BASE_DELAY_MS;
		delete process.env.ANYROUTER_RETRY_MAX_DELAY_MS;
		delete process.env.ANYROUTER_RETRY_NOTICE;
	}
});

const OPENAI_TOOL_CALL_SSE = [
	'data: {"type":"response.created","response":{"id":"resp_tool"}}',
	'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"read","arguments":"{}"}}',
	'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"read","arguments":"{}"}}',
	'data: {"type":"response.completed","response":{"id":"resp_tool","status":"completed","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}',
	"",
].join("\n\n");

test("OpenAI Responses replays a tool call and its result", async () => {
	const provider = register();
	const firstRelay = fakeRelay(OPENAI_TOOL_CALL_SSE, 0);
	const model = buildModel("gpt-5.5", "openai", loadConfig(process.env));
	const first = await runStream(provider, model, firstRelay.fetch);
	assert.equal(first.stopReason, "toolUse");
	const toolCall = first.content.find((block) => block.type === "toolCall");
	assert.ok(toolCall && toolCall.type === "toolCall");
	assert.equal(toolCall.id, "call_1|fc_1");

	const secondRelay = fakeRelay(OPENAI_SSE, 0);
	const context = {
		messages: [
			{ role: "user", content: "read a file", timestamp: Date.now() },
			first,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
	};
	const second = await runStream(provider, model, secondRelay.fetch, context);
	assert.equal(second.stopReason, "stop");

	const body = JSON.parse(secondRelay.requests[0]?.body ?? "{}") as {
		input?: Array<Record<string, unknown>>;
	};
	const functionCall = body.input?.find((item) => item.type === "function_call");
	const functionOutput = body.input?.find((item) => item.type === "function_call_output");
	assert.equal(functionCall?.call_id, "call_1");
	assert.equal(functionOutput?.call_id, "call_1");
	assert.equal(functionOutput?.output, "file contents");
});

const CHAT_COMPLETIONS_SSE = [
	'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"gpt-5.5","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
	'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"gpt-5.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
	"data: [DONE]",
	"",
].join("\n\n");

test("OpenAI can use the Chat Completions fallback", async () => {
	process.env.ANYROUTER_OPENAI_API = "openai-completions";
	const provider = register();
	const relay = fakeRelay(CHAT_COMPLETIONS_SSE, 0);
	try {
		const model = buildModel("gpt-5.5", "openai", loadConfig(process.env));
		const message = await runStream(provider, model, relay.fetch);
		assert.equal(message.stopReason, "stop");
		assert.equal((message.content[0] as { text: string }).text, "hello");
		assert.match(relay.requests[0]?.url ?? "", /\/v1\/chat\/completions$/);
	} finally {
		delete process.env.ANYROUTER_OPENAI_API;
	}
});
