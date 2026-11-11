import assert from "node:assert/strict";
import test from "node:test";
import { createSqueezeFetch, type FetchLike, type SqueezeRetryOptions } from "../src/retry-fetch.ts";

const baseOptions: SqueezeRetryOptions = {
	maxRetries: 5,
	baseDelayMs: 1,
	maxDelayMs: 1,
	retryStatuses: [429],
	random: () => 0,
	sleep: async () => {},
};

test("retries 429 and replays a string body", async () => {
	const calls: Array<{ url: string; body: unknown }> = [];
	const baseFetch: FetchLike = async (input, init) => {
		calls.push({ url: String(input), body: init?.body });
		return calls.length < 3
			? new Response("busy", { status: 429 })
			: new Response("ok", { status: 200 });
	};
	const fetchWithRetry = createSqueezeFetch(baseFetch, baseOptions);

	const response = await fetchWithRetry("https://relay.test/v1/responses", {
		method: "POST",
		body: JSON.stringify({ model: "gpt-5.5" }),
	});

	assert.equal(response.status, 200);
	assert.equal(calls.length, 3);
	for (const call of calls) assert.equal(call.body, JSON.stringify({ model: "gpt-5.5" }));
});

test("does not retry a terminal quota 429", async () => {
	let calls = 0;
	const baseFetch: FetchLike = async () => {
		calls++;
		return new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "no balance" } }), {
			status: 429,
			headers: { "content-type": "application/json" },
		});
	};
	const fetchWithRetry = createSqueezeFetch(baseFetch, baseOptions);

	const response = await fetchWithRetry("https://relay.test/v1/responses", { method: "POST" });
	assert.equal(response.status, 429);
	assert.equal(calls, 1);
	assert.match(await response.text(), /insufficient_quota/);
});

test("does not retry unrelated statuses", async () => {
	let calls = 0;
	const baseFetch: FetchLike = async () => {
		calls++;
		return new Response("bad request", { status: 400 });
	};
	const fetchWithRetry = createSqueezeFetch(baseFetch, baseOptions);
	await fetchWithRetry("https://relay.test/v1/responses", { method: "POST" });
	assert.equal(calls, 1);
});

test("stops after maxRetries and returns the last 429", async () => {
	let calls = 0;
	const baseFetch: FetchLike = async () => {
		calls++;
		return new Response("busy", { status: 429 });
	};
	const fetchWithRetry = createSqueezeFetch(baseFetch, { ...baseOptions, maxRetries: 2 });
	const response = await fetchWithRetry("https://relay.test/v1/responses", { method: "POST" });
	assert.equal(response.status, 429);
	assert.equal(calls, 3);
});

test("caps a server retry-after delay at maxDelayMs", async () => {
	const sleeps: number[] = [];
	const baseFetch: FetchLike = async (_input, _init) =>
		new Response("busy", { status: 429, headers: { "retry-after": "30" } });
	const fetchWithRetry = createSqueezeFetch(baseFetch, {
		...baseOptions,
		maxRetries: 1,
		maxDelayMs: 250,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	await fetchWithRetry("https://relay.test/v1/responses", { method: "POST" });
	assert.deepEqual(sleeps, [250]);
});

test("keeps jittered backoff when retry-after is 0", async () => {
	const sleeps: number[] = [];
	const baseFetch: FetchLike = async () =>
		new Response("busy", { status: 429, headers: { "retry-after": "0" } });
	const fetchWithRetry = createSqueezeFetch(baseFetch, {
		...baseOptions,
		maxRetries: 3,
		baseDelayMs: 400,
		maxDelayMs: 1600,
		random: () => 1,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	await fetchWithRetry("https://relay.test/v1/responses", { method: "POST" });
	assert.deepEqual(sleeps, [400, 800, 1600]);
});

test("default delays: 1-2s, 2-4s, then 4-8s", async () => {
	const { loadConfig } = await import("../src/config.ts");
	const { retry } = loadConfig({});
	for (const [random, expected] of [
		[0, [1000, 2000, 4000, 4000]],
		[1, [2000, 4000, 8000, 8000]],
	] as const) {
		const sleeps: number[] = [];
		const fetchWithRetry = createSqueezeFetch(async () => new Response("busy", { status: 500 }), {
			...retry,
			maxRetries: 4,
			random: () => random,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		await fetchWithRetry("https://relay.test/v1/responses", { method: "POST" });
		assert.deepEqual(sleeps, expected);
	}
});

test("replays a Request body across retries", async () => {
	const bodies: string[] = [];
	const baseFetch: FetchLike = async (input) => {
		assert.ok(input instanceof Request);
		bodies.push(await input.text());
		return bodies.length < 2 ? new Response("busy", { status: 429 }) : new Response("ok", { status: 200 });
	};
	const fetchWithRetry = createSqueezeFetch(baseFetch, baseOptions);
	const response = await fetchWithRetry(
		new Request("https://relay.test/v1/responses", { method: "POST", body: "payload" }),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(bodies, ["payload", "payload"]);
});

test("reports each retry with its backoff, then settles once on success", async () => {
	const retries: Array<{ attempt: number; status: number; delayMs: number; maxRetries: number }> = [];
	const settled: Array<{ retries: number; outcome: string }> = [];
	let calls = 0;
	const baseFetch: FetchLike = async () =>
		++calls < 3 ? new Response("busy", { status: 429 }) : new Response("ok", { status: 200 });
	const fetchWithRetry = createSqueezeFetch(baseFetch, {
		...baseOptions,
		maxRetries: 4,
		baseDelayMs: 400,
		maxDelayMs: 1600,
		random: () => 1,
		onRetry: (info) => retries.push(info),
		onRetrySettled: (info) => settled.push(info),
	});

	const response = await fetchWithRetry("https://relay.test/v1/responses", { method: "POST" });
	assert.equal(response.status, 200);
	assert.deepEqual(
		retries.map(({ attempt, status, delayMs, maxRetries }) => ({ attempt, status, delayMs, maxRetries })),
		[
			{ attempt: 1, status: 429, delayMs: 400, maxRetries: 4 },
			{ attempt: 2, status: 429, delayMs: 800, maxRetries: 4 },
		],
	);
	assert.deepEqual(settled, [{ retries: 2, outcome: "ok" }]);
});

test("settles with the final failure after exhausting retries", async () => {
	const settled: Array<{ retries: number; outcome: string }> = [];
	const fetchWithRetry = createSqueezeFetch(async () => new Response("busy", { status: 429 }), {
		...baseOptions,
		maxRetries: 2,
		onRetrySettled: (info) => settled.push(info),
	});
	const response = await fetchWithRetry("https://relay.test/v1/responses", { method: "POST" });
	assert.equal(response.status, 429);
	assert.deepEqual(settled, [{ retries: 2, outcome: "failed" }]);
});

test("settles as aborted when the signal fires during backoff", async () => {
	const controller = new AbortController();
	const settled: Array<{ retries: number; outcome: string }> = [];
	const fetchWithRetry = createSqueezeFetch(async () => new Response("busy", { status: 429 }), {
		...baseOptions,
		maxRetries: 5,
		sleep: async () => {
			controller.abort();
			throw Object.assign(new Error("Aborted"), { name: "AbortError" });
		},
		onRetrySettled: (info) => settled.push(info),
	});
	await assert.rejects(
		fetchWithRetry("https://relay.test/v1/responses", { method: "POST", signal: controller.signal }),
		/abort/i,
	);
	assert.deepEqual(settled, [{ retries: 1, outcome: "aborted" }]);
});

test("does not settle when the first response is not retried", async () => {
	let settled = 0;
	const fetchWithRetry = createSqueezeFetch(async () => new Response("ok", { status: 200 }), {
		...baseOptions,
		onRetrySettled: () => {
			settled++;
		},
	});
	await fetchWithRetry("https://relay.test/v1/responses", { method: "POST" });
	assert.equal(settled, 0);
});

test("a throwing retry hook cannot break the request", async () => {
	const fetchWithRetry = createSqueezeFetch(
		async () => new Response("ok", { status: 200 }),
		{
			...baseOptions,
			onRetry: () => {
				throw new Error("ui exploded");
			},
		},
	);
	const response = await fetchWithRetry("https://relay.test/v1/responses", { method: "POST" });
	assert.equal(response.status, 200);
});

test("honors an aborted request signal", async () => {
	const controller = new AbortController();
	const baseFetch: FetchLike = async (_input, init) => {
		controller.abort();
		assert.ok(init?.signal?.aborted);
		return new Response("busy", { status: 429 });
	};
	const fetchWithRetry = createSqueezeFetch(baseFetch, baseOptions);
	await assert.rejects(
		fetchWithRetry("https://relay.test/v1/responses", { method: "POST", signal: controller.signal }),
		/abort/i,
	);
});
