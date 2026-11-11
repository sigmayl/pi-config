import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type AnyRouterConfig } from "./config.ts";
import { configModels, modelsFromIds, parseModelIds, PROVIDER_ID, PROVIDER_NAME } from "./models.ts";
import { createSqueezeFetch, type FetchLike } from "./retry-fetch.ts";
import { createRetryStatusReporter } from "./retry-status.ts";
import { createStreams } from "./stream.ts";

function storedModels(context: RefreshModelsContext, config: AnyRouterConfig): Model<Api>[] {
	const ids =
		context.stored?.models
			.filter((model) => model.provider === PROVIDER_ID && (model.type === undefined || model.type === "chat"))
			.map((model) => model.id) ?? [];
	return modelsFromIds(ids, config);
}

function resolveModelsUrl(config: AnyRouterConfig, context: RefreshModelsContext): string {
	if (process.env.ANYROUTER_MODELS_URL?.trim()) return config.modelsUrl;
	const base = context.baseUrl?.trim().replace(/\/+$/, "");
	if (!base || base === config.rootBaseUrl) return config.modelsUrl;
	return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
}

function discoveryHeaders(apiKey: string): Record<string, string> {
	return {
		accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
		"x-api-key": apiKey,
	};
}

async function discoverModels(context: RefreshModelsContext, config: AnyRouterConfig): Promise<Model<Api>[]> {
	// Pi calls refreshModels twice: first with allowNetwork=false to restore the
	// persisted catalog before auth resolution, then with the resolved credential.
	// The offline phase must never require a key.
	if (!context.allowNetwork) return storedModels(context, config);

	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!apiKey) {
		throw new Error(
			`AnyRouter API key is not configured. Run /login ${PROVIDER_ID} or set ANYROUTER_API_KEY.`,
		);
	}

	// Model discovery hits the same limited-capacity service as chat requests, so
	// use the same fast capacity retry policy.
	const fetchModels = createSqueezeFetch(globalThis.fetch as FetchLike, config.retry, context.signal);
	const response = await fetchModels(resolveModelsUrl(config, context), {
		method: "GET",
		headers: discoveryHeaders(apiKey),
		signal: context.signal,
	});

	// A relay without an OpenAI-style model list endpoint still works when the
	// user seeds model IDs with ANYROUTER_MODELS.
	if (response.status === 404 || response.status === 405) return storedModels(context, config);
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`AnyRouter model discovery failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
		);
	}

	const ids = parseModelIds(await response.json());
	const models = modelsFromIds(ids, config);
	return models.length > 0 ? models : storedModels(context, config);
}

export default function anyrouterProvider(pi: ExtensionAPI): void {
	const config = loadConfig();
	const retryStatus = createRetryStatusReporter(config.retryNotice);

	// The squeeze retry runs inside the provider fetch, where Pi's own retry
	// indicator cannot see it. Grab the live UI context from Pi's events so the
	// reporter can reuse the working line and footer, and refresh it on every
	// request so session switches and reloads keep working.
	pi.on("session_start", (_event, ctx) => retryStatus.bind(ctx.ui));
	pi.on("before_provider_request", (_event, ctx) => {
		retryStatus.bind(ctx.ui);
	});

	pi.registerProvider(
		createProvider<Api>({
			id: PROVIDER_ID,
			name: PROVIDER_NAME,
			baseUrl: config.rootBaseUrl,
			auth: {
				apiKey: envApiKeyAuth("AnyRouter API key", ["ANYROUTER_API_KEY", "ANYROUTER_KEY"]),
			},
			models: configModels(config),
			api: createStreams(config, retryStatus),
			fetchModels: (context) => discoverModels(context, config),
		}),
	);
}
