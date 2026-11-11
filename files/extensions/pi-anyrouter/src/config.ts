export type OpenAICompatibleApi = "openai-responses" | "openai-completions";
export type ClaudeApi = "anthropic-messages";
export type AnthropicAuthMode = "both" | "bearer" | "x-api-key";

export interface RetryConfig {
	/** Additional attempts after the first retryable response. 0 disables provider-level retries. */
	maxRetries: number;
	/** Initial backoff in milliseconds. */
	baseDelayMs: number;
	/** Upper bound for one backoff sleep in milliseconds. */
	maxDelayMs: number;
	/** HTTP statuses that trigger the provider-specific "squeeze" retry. */
	retryStatuses: number[];
}

export interface AnyRouterConfig {
	rootBaseUrl: string;
	openaiBaseUrl: string;
	anthropicBaseUrl: string;
	modelsUrl: string;
	openaiApi: OpenAICompatibleApi;
	claudeApi: ClaudeApi;
	openaiKeywords: string[];
	claudeKeywords: string[];
	anthropicAuthMode: AnthropicAuthMode;
	retry: RetryConfig;
	/** Show squeeze retries in Pi's working line and footer instead of retrying silently. */
	retryNotice: boolean;
	contextWindowOverride?: number;
	maxTokensOverride?: number;
	explicitModels: string[];
	explicitOpenAIModels: string[];
	explicitClaudeModels: string[];
}

const DEFAULT_ROOT = "https://anyrouter.top";

/**
 * AnyRouter signals "no capacity slot" with 429 on the Claude side, but the
 * Responses (GPT) side returns 500 — often with an empty body, or
 * `get_channel_failed` / "负载已经达到上限". Gateway 5xx are retried as well.
 */
export const DEFAULT_RETRY_STATUSES: readonly number[] = [429, 500, 502, 503, 504];

type Env = Record<string, string | undefined>;

function readEnv(env: Env, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function readInteger(env: Env, name: string, fallback: number, minimum = 0): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function readBoolean(env: Env, name: string, fallback: boolean): boolean {
	const raw = env[name]?.trim().toLowerCase();
	if (!raw) return fallback;
	if (["0", "false", "off", "no", "none", "disabled"].includes(raw)) return false;
	if (["1", "true", "on", "yes", "auto", "enabled"].includes(raw)) return true;
	return fallback;
}

function splitList(value: string | undefined, fallback: string[]): string[] {
	if (!value) return fallback;
	const items = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length > 0 ? items : fallback;
}

function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

function isV1Root(url: string): boolean {
	return /\/v1$/i.test(url);
}

export function loadConfig(env: Env = process.env): AnyRouterConfig {
	const rawRoot = normalizeBaseUrl(readEnv(env, "ANYROUTER_BASE_URL") ?? DEFAULT_ROOT);
	const rootBaseUrl = isV1Root(rawRoot) ? normalizeBaseUrl(rawRoot.replace(/\/v1$/i, "")) : rawRoot;
	const defaultOpenAIBaseUrl = isV1Root(rawRoot) ? rawRoot : `${rootBaseUrl}/v1`;
	const defaultAnthropicBaseUrl = rootBaseUrl;

	const openaiApiRaw = (readEnv(env, "ANYROUTER_OPENAI_API") ?? "openai-responses").toLowerCase();
	const openaiApi: OpenAICompatibleApi =
		openaiApiRaw === "completions" || openaiApiRaw === "openai-completions"
			? "openai-completions"
			: "openai-responses";

	const anthropicAuthRaw = (readEnv(env, "ANYROUTER_ANTHROPIC_AUTH") ?? "both").toLowerCase();
	const anthropicAuthMode: AnthropicAuthMode =
		anthropicAuthRaw === "bearer" || anthropicAuthRaw === "authorization"
			? "bearer"
			: anthropicAuthRaw === "x-api-key" || anthropicAuthRaw === "api-key"
				? "x-api-key"
				: "both";

	const contextWindow = readInteger(env, "ANYROUTER_CONTEXT_WINDOW", 0, 1);
	const maxTokens = readInteger(env, "ANYROUTER_MAX_TOKENS", 0, 1);
	const retryStatuses = splitList(env.ANYROUTER_RETRY_STATUSES, DEFAULT_RETRY_STATUSES.map(String))
		.map((status) => Number.parseInt(status, 10))
		.filter((status) => Number.isFinite(status) && status >= 100 && status <= 599);

	return {
		rootBaseUrl,
		openaiBaseUrl: normalizeBaseUrl(readEnv(env, "ANYROUTER_OPENAI_BASE_URL") ?? defaultOpenAIBaseUrl),
		anthropicBaseUrl: normalizeBaseUrl(readEnv(env, "ANYROUTER_ANTHROPIC_BASE_URL") ?? defaultAnthropicBaseUrl),
		modelsUrl: normalizeBaseUrl(readEnv(env, "ANYROUTER_MODELS_URL") ?? `${defaultOpenAIBaseUrl}/models`),
		openaiApi,
		claudeApi: "anthropic-messages",
		openaiKeywords: splitList(env.ANYROUTER_OPENAI_FILTER, ["gpt"]).map((keyword) => keyword.toLowerCase()),
		claudeKeywords: splitList(env.ANYROUTER_CLAUDE_FILTER, ["claude"]).map((keyword) => keyword.toLowerCase()),
		anthropicAuthMode,
		retry: {
			maxRetries: readInteger(env, "ANYROUTER_RETRY_MAX_RETRIES", 60),
			baseDelayMs: readInteger(env, "ANYROUTER_RETRY_BASE_DELAY_MS", 2000),
			maxDelayMs: readInteger(env, "ANYROUTER_RETRY_MAX_DELAY_MS", 8000),
			retryStatuses: retryStatuses.length > 0 ? retryStatuses : [...DEFAULT_RETRY_STATUSES],
		},
		retryNotice: readBoolean(env, "ANYROUTER_RETRY_NOTICE", true),
		...(contextWindow > 0 ? { contextWindowOverride: contextWindow } : {}),
		...(maxTokens > 0 ? { maxTokensOverride: maxTokens } : {}),
		explicitModels: splitList(env.ANYROUTER_MODELS, []),
		explicitOpenAIModels: splitList(env.ANYROUTER_OPENAI_MODELS, []),
		explicitClaudeModels: splitList(env.ANYROUTER_CLAUDE_MODELS, []),
	};
}
