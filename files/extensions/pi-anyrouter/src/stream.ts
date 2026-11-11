import type { Api, ProviderStreams, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { AnyRouterConfig, OpenAICompatibleApi } from "./config.ts";
import { createSqueezeFetch, type FetchLike } from "./retry-fetch.ts";
import type { RetryStatusReporter } from "./retry-status.ts";

type ChatOptions = StreamOptions | SimpleStreamOptions;

function openAICompatibleApi(api: OpenAICompatibleApi): ProviderStreams {
	return api === "openai-completions" ? openAICompletionsApi() : openAIResponsesApi();
}

function hasAuthorization(headers: Record<string, string | null> | undefined): boolean {
	if (!headers) return false;
	return Object.keys(headers).some(
		(name) => name.toLowerCase() === "authorization" && (headers[name] ?? "").trim().length > 0,
	);
}

function anthropicHeaders(
	headers: Record<string, string | null> | undefined,
	apiKey: string | undefined,
	config: AnyRouterConfig,
): Record<string, string | null> | undefined {
	if (!apiKey || config.anthropicAuthMode === "x-api-key" || hasAuthorization(headers)) {
		return headers;
	}
	// Claude Code relays commonly expect ANTHROPIC_AUTH_TOKEN, which is sent as a
	// Bearer token. Keeping x-api-key as well covers standard Anthropic proxies.
	// The SDK only adds x-api-key after this merge, so both can be present.
	return { ...(headers ?? {}), Authorization: `Bearer ${apiKey}` };
}

function prepareOptions<T extends ChatOptions>(
	options: T | undefined,
	config: AnyRouterConfig,
	isAnthropic: boolean,
	retryStatus?: RetryStatusReporter,
): T {
	const apiKey = options?.apiKey;
	const headers = isAnthropic ? anthropicHeaders(options?.headers, apiKey, config) : options?.headers;
	const prepared = {
		...options,
		...(headers ? { headers } : {}),
		// Provider-scoped retry: statuses from ANYROUTER_RETRY_STATUSES (429 and
		// 5xx by default) are retried by the fetch wrapper below. Disable the API
		// implementation's slower provider retry so it cannot add a second,
		// global-looking backoff on top.
		maxRetries: 0,
		fetch: createSqueezeFetch(
			(options?.fetch ?? globalThis.fetch) as FetchLike,
			{
				...config.retry,
				onRetry: (info) => retryStatus?.onRetry(info),
				onRetrySettled: (info) => retryStatus?.onRetrySettled(info),
			},
			options?.signal,
		),
	};
	if (isAnthropic && config.anthropicAuthMode === "bearer") {
		// With Authorization-only auth, avoid also sending the Anthropic SDK's
		// x-api-key header.
		return { ...prepared, apiKey: undefined } as T;
	}
	return prepared as T;
}

function wrapApi(
	api: ProviderStreams,
	config: AnyRouterConfig,
	isAnthropic: boolean,
	retryStatus?: RetryStatusReporter,
): ProviderStreams {
	return {
		stream: (model, context, options) =>
			api.stream(model, context, prepareOptions(options, config, isAnthropic, retryStatus)),
		streamSimple: (model, context, options) =>
			api.streamSimple(model, context, prepareOptions(options, config, isAnthropic, retryStatus)),
	};
}

export function createStreams(
	config: AnyRouterConfig,
	retryStatus?: RetryStatusReporter,
): Partial<Record<Api, ProviderStreams>> {
	const streams: Partial<Record<Api, ProviderStreams>> = {};
	streams[config.openaiApi] = wrapApi(openAICompatibleApi(config.openaiApi), config, false, retryStatus);
	streams[config.claudeApi] = wrapApi(anthropicMessagesApi(), config, true, retryStatus);
	return streams;
}
