import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { SqueezeRetryInfo } from "../src/retry-fetch.ts";
import { createRetryStatusReporter, formatRetryNotice, RETRY_STATUS_KEY } from "../src/retry-status.ts";

function fakeUI() {
	const working: Array<string | undefined> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const ui = {
		setWorkingMessage(message?: string) {
			working.push(message);
		},
		setStatus(key: string, text: string | undefined) {
			statuses.push([key, text]);
		},
	} as unknown as ExtensionUIContext;
	return { ui, working, statuses };
}

function info(attempt: number, delayMs = 4000, maxRetries = 60): SqueezeRetryInfo {
	return { attempt, status: 429, url: "https://anyrouter.top/v1/responses", delayMs, maxRetries };
}

test("formats a compact retry notice", () => {
	assert.equal(formatRetryNotice(info(3, 4000)), "anyrouter 429 · retry 3/60 · 4s");
	assert.equal(formatRetryNotice(info(1, 1)), "anyrouter 429 · retry 1/60 · 1s");
});

test("shows the retry in the working line and footer, then restores both", () => {
	const { ui, working, statuses } = fakeUI();
	const reporter = createRetryStatusReporter(true);
	reporter.bind(ui);

	reporter.onRetry(info(1));
	assert.match(working[0] ?? "", /anyrouter 429 · retry 1\/60 · 4s/);
	assert.match(working[0] ?? "", /esc to interrupt/);
	assert.deepEqual(statuses[0], [RETRY_STATUS_KEY, "anyrouter 429 · retry 1/60 · 4s"]);

	reporter.onRetry(info(2));
	assert.equal(working.at(-1), "anyrouter 429 · retry 2/60 · 4s (esc to interrupt)");

	reporter.onRetrySettled({ retries: 2, outcome: "ok" });
	assert.equal(working.at(-1), undefined);
	assert.deepEqual(statuses.at(-1), [RETRY_STATUS_KEY, undefined]);
});

test("stays silent when disabled", () => {
	const { ui, working, statuses } = fakeUI();
	const reporter = createRetryStatusReporter(false);
	reporter.bind(ui);
	reporter.onRetry(info(1));
	reporter.onRetrySettled({ retries: 1, outcome: "ok" });
	assert.deepEqual(working, []);
	assert.deepEqual(statuses, []);
});

test("does nothing before a UI context is bound", () => {
	const reporter = createRetryStatusReporter(true);
	assert.doesNotThrow(() => reporter.onRetry(info(1)));
	assert.doesNotThrow(() => reporter.onRetrySettled({ retries: 1, outcome: "ok" }));
});

test("a concurrent sequence does not clear the other's notice", () => {
	const { ui, working } = fakeUI();
	const reporter = createRetryStatusReporter(true);
	reporter.bind(ui);

	reporter.onRetry(info(1));
	reporter.onRetry(info(1));
	reporter.onRetrySettled({ retries: 1, outcome: "ok" });
	assert.equal(working.at(-1), "anyrouter 429 · retry 1/60 · 4s (esc to interrupt)");

	reporter.onRetrySettled({ retries: 1, outcome: "ok" });
	assert.equal(working.at(-1), undefined);
});

test("rebinding to a new session clears the old one", () => {
	const first = fakeUI();
	const second = fakeUI();
	const reporter = createRetryStatusReporter(true);

	reporter.bind(first.ui);
	reporter.onRetry(info(1));
	assert.equal(first.working.at(-1), "anyrouter 429 · retry 1/60 · 4s (esc to interrupt)");

	reporter.bind(second.ui);
	assert.equal(first.working.at(-1), undefined);
	assert.deepEqual(second.working, []);
});
