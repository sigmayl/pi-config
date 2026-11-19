import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CacheKeyStore, defaultCacheKeyFile } from "./cache-key.ts";
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

function formatCacheKeyState(state: { key: string; updatedAt: number } | undefined): string {
	if (!state) return "using Pi's session id (no AnyRouter override)";
	return `${state.key} (rotated ${new Date(state.updatedAt).toLocaleString()})`;
}

export default function anyrouterProvider(pi: ExtensionAPI): void {
	const config = loadConfig();
	const retryStatus = createRetryStatusReporter(config.retryNotice);
	const cacheKeys = new CacheKeyStore({ file: config.cacheKeyFile ?? defaultCacheKeyFile() });

	// The squeeze retry runs inside the provider fetch, where Pi's own retry
	// indicator cannot see it. Grab the live UI context from Pi's events so the
	// reporter can reuse the working line and footer, and refresh it on every
	// request so session switches and reloads keep working.
	pi.on("session_start", async (_event, ctx) => {
		retryStatus.bind(ctx.ui);
		// Load (or create) the persisted prompt-cache key before the first request.
		try {
			await cacheKeys.activate(ctx.sessionManager.getSessionId());
		} catch {
			// A read-only agent dir must not break the provider; requests fall back
			// to Pi's own session id when the key cannot be persisted.
		}
	});
	pi.on("before_provider_request", (_event, ctx) => {
		retryStatus.bind(ctx.ui);
		// Keep the active session in sync even if a request arrives before the
		// session_start handler finished loading the persisted keys.
		if (ctx.model?.provider === PROVIDER_ID) {
			void cacheKeys.activate(ctx.sessionManager.getSessionId()).catch(() => {});
		}
	});

	// Rotate the provider-level session id / prompt_cache_key without starting a
	// new Pi session. AnyRouter keys its prompt cache and channel affinity on
	// this value, so a rotation forces a fresh cache namespace.
	pi.registerCommand("ar-change-cache-key", {
		description: "Rotate the AnyRouter prompt-cache key (provider session id) for this session",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "status", label: "status", description: "Show the current cache key" },
				{ value: "reset", label: "reset", description: "Fall back to Pi's session id" },
			];
			const matches = options.filter((option) => option.value.startsWith(prefix));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const argument = args.trim();
			if (argument === "status") {
				ctx.ui.notify(
					`AnyRouter cache key: ${formatCacheKeyState(cacheKeys.state(sessionId))}`,
					"info",
				);
				return;
			}
			if (argument === "reset") {
				await cacheKeys.reset(sessionId);
				ctx.ui.notify("AnyRouter cache key reset: using Pi's session id", "info");
				return;
			}
			// Do not rotate in the middle of a request: the next request should be
			// the first one in the new cache namespace.
			await ctx.waitForIdle();
			try {
				const state = await cacheKeys.rotate(sessionId, argument || undefined);
				ctx.ui.notify(`AnyRouter cache key rotated: ${formatCacheKeyState(state)}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`AnyRouter cache key rotation failed: ${message}`, "error");
			}
		},
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
			api: createStreams(config, retryStatus, cacheKeys),
			fetchModels: (context) => discoverModels(context, config),
		}),
	);
}
