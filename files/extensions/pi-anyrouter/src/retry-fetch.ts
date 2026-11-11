export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SqueezeRetryInfo {
	/** 1-based retry number about to be scheduled. */
	attempt: number;
	status: number;
	url: string;
	/** Backoff about to be slept before the next attempt, in milliseconds. */
	delayMs: number;
	/** Total retries allowed after the first response. */
	maxRetries: number;
}

/** Why a retry sequence stopped. */
export type SqueezeRetryOutcome = "ok" | "failed" | "aborted" | "error";

export interface SqueezeRetrySettledInfo {
	/** Retries actually performed before the sequence stopped. */
	retries: number;
	outcome: SqueezeRetryOutcome;
}

export interface SqueezeRetryOptions {
	/** Additional attempts after the first response. 0 disables the retry loop. */
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	retryStatuses: readonly number[];
	random?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Called before each backoff sleep, so a UI can show the retry in progress. */
	onRetry?: (info: SqueezeRetryInfo) => void;
	/** Called once per request that retried at least once, when the sequence ends. */
	onRetrySettled?: (info: SqueezeRetrySettledInfo) => void;
}

/**
 * Real quota/billing failures also arrive as 429. Retrying those just delays the
 * error the user must act on, so keep them out of the "squeeze" loop.
 */
const TERMINAL_RATE_LIMIT_PATTERN =
	/insufficient[_\s-]?quota|quota\s+(?:exceeded|exhausted)|out\s+of\s+budget|billing|usage\s+limit|available\s+balance|subscription_sharing|GoUsageLimitError|FreeUsageLimitError|Monthly\s+usage\s+limit\s+reached|余额不足|余额已用尽|额度不足|额度已用尽|欠费|请充值|账户余额/i;

function abortError(): Error {
	const error = new Error("Aborted");
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/**
 * Retry reporting is best-effort: a broken UI hook must never fail the request it
 * is only supposed to describe.
 */
function notify(listener: (() => void) | undefined): void {
	try {
		listener?.();
	} catch {
		// ignored
	}
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	if (!signal) {
		return new Promise((resolve) => {
			setTimeout(resolve, Math.max(0, ms));
		});
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, Math.max(0, ms));
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function parseRetryAfter(headers: Headers): number | undefined {
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(value)) return Math.max(0, value);
	}
	const retryAfter = headers.get("retry-after");
	if (!retryAfter) return undefined;
	const seconds = Number.parseFloat(retryAfter);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(retryAfter);
	if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
	return undefined;
}

function retryDelayMs(response: Response, attempt: number, options: SqueezeRetryOptions, random: () => number): number {
	const exponential = Math.min(options.baseDelayMs * 2 ** Math.min(attempt, 10), options.maxDelayMs);
	const jittered = exponential * (0.5 + random() * 0.5);
	// Retry-After acts as a floor (capped at maxDelayMs), never as a replacement
	// for jitter: a relay answering "retry-after: 0" must not make every client
	// hammer it in lockstep.
	const requested = parseRetryAfter(response.headers);
	const delay = requested === undefined ? jittered : Math.max(jittered, Math.min(requested, options.maxDelayMs));
	return Math.max(0, Math.min(delay, options.maxDelayMs));
}

async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The response body is disposable; the retry request is the source of truth.
	}
}

async function hasTerminalRateLimitBody(response: Response): Promise<boolean> {
	try {
		const text = await response.clone().text();
		return TERMINAL_RATE_LIMIT_PATTERN.test(text);
	} catch {
		return false;
	}
}

async function makeReplayableBody(body: BodyInit | null | undefined): Promise<BodyInit | null | undefined> {
	if (body === null || body === undefined || typeof body === "string") return body;
	if (typeof ArrayBuffer !== "undefined" && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) return body;
	if (typeof Blob !== "undefined" && body instanceof Blob) return body;
	if (typeof FormData !== "undefined" && body instanceof FormData) return body;
	if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body;
	// A ReadableStream/async iterable can only be consumed once. Buffer it so every
	// retry sends the same request body.
	return new Response(body as BodyInit).arrayBuffer();
}

function withBody(init: RequestInit | undefined, body: BodyInit | null | undefined): RequestInit | undefined {
	if (!init) return undefined;
	if (init.body === undefined) return init;
	return { ...init, body };
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

/**
 * Wrap fetch with the provider-specific "squeeze" behavior: retry capacity 429/5xx
 * quickly and repeatedly, without changing Pi's global retry settings for any
 * other provider.
 *
 * Request bodies are replayed across attempts. A non-replayable stream body is
 * buffered once before the first request.
 */
export function createSqueezeFetch(
	baseFetch: FetchLike,
	options: SqueezeRetryOptions,
	requestSignal?: AbortSignal,
): FetchLike {
	const random = options.random ?? Math.random;
	const sleep = options.sleep ?? abortableSleep;
	const retryStatuses = new Set(options.retryStatuses);

	return async (input, init) => {
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? requestSignal;
		signal?.throwIfAborted();

		// Keep one unconsumed Request clone so each attempt gets a fresh body.
		const requestTemplate = input instanceof Request ? input.clone() : undefined;
		const originalBody = init?.body;
		const replayableBody = await makeReplayableBody(originalBody);

		let retries = 0;
		const settle = (outcome: SqueezeRetryOutcome) => {
			if (retries === 0) return;
			const performed = retries;
			retries = 0;
			notify(() => options.onRetrySettled?.({ retries: performed, outcome }));
		};

		try {
			for (let attempt = 0; ; attempt++) {
				signal?.throwIfAborted();
				const response = await baseFetch(
					requestTemplate ? requestTemplate.clone() : input,
					withBody(init, replayableBody),
				);

				const retryable = retryStatuses.has(response.status) && attempt < options.maxRetries;
				if (!retryable || (await hasTerminalRateLimitBody(response))) {
					settle(response.ok ? "ok" : "failed");
					return response;
				}

				const delayMs = retryDelayMs(response, attempt, options, random);
				retries = attempt + 1;
				const info: SqueezeRetryInfo = {
					attempt: retries,
					status: response.status,
					url: requestUrl(input),
					delayMs,
					maxRetries: options.maxRetries,
				};
				notify(() => options.onRetry?.(info));
				await cancelResponseBody(response);
				await sleep(delayMs, signal);
			}
		} catch (error) {
			settle(isAbortError(error) ? "aborted" : "error");
			throw error;
		}
	};
}
