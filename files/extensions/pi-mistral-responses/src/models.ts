import type { AnyModel, Api, Model, ModelCost, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { MistralResponsesConfig } from "./config.ts";

export const PROVIDER_ID = "mistral-responses";
export const PROVIDER_NAME = "Mistral (Responses)";
export const API: Api = "openai-responses";

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 32_768;

/** What `/v1/models` tells us about one model. */
interface LiveModel {
	id: string;
	contextWindow?: number;
	reasoning?: boolean;
	vision?: boolean;
}

let builtinCatalog: Map<string, Model<Api>> | undefined;

/**
 * Pi's bundled Mistral catalog supplies the metadata the discovery endpoint does
 * not expose: prices, output limits, thinking-level mapping, image limits.
 */
function builtinModel(id: string): Model<Api> | undefined {
	if (!builtinCatalog) {
		builtinCatalog = new Map(getBuiltinModels("mistral").map((model) => [model.id, model]));
	}
	const direct = builtinCatalog.get(id);
	if (direct) return direct;
	// The live list carries both a pinned id and its `-latest` alias, while the
	// bundled catalog may only have one of the two.
	if (id.endsWith("-latest")) return builtinCatalog.get(id.slice(0, -"-latest".length));
	return builtinCatalog.get(`${id}-latest`);
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function readLiveModel(value: unknown): LiveModel | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!id) return undefined;
	const capabilities = (record.capabilities ?? {}) as Record<string, unknown>;
	// The endpoint also lists embeddings, OCR, TTS, and transcription models.
	if (capabilities.completion_chat !== true) return undefined;
	// Deprecated models stay reachable by id but should not clutter the picker.
	if (record.deprecation !== null && record.deprecation !== undefined) return undefined;
	return {
		id,
		contextWindow: asPositiveInteger(record.max_context_length),
		reasoning: asBoolean(capabilities.reasoning),
		vision: asBoolean(capabilities.vision),
	};
}

/** Accepts `{ data: [...] }` (Mistral and OpenAI) or a bare array. */
export function parseLiveModels(payload: unknown): LiveModel[] {
	const list = Array.isArray(payload)
		? payload
		: payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
			? ((payload as { data: unknown[] }).data as unknown[])
			: [];
	const seen = new Set<string>();
	const models: LiveModel[] = [];
	for (const entry of list) {
		const model = readLiveModel(entry);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

export function toModel(live: LiveModel, baseUrl: string): Model<Api> {
	const builtin = builtinModel(live.id);
	const contextWindow = live.contextWindow ?? builtin?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
	const vision = live.vision ?? builtin?.input.includes("image") ?? false;
	return {
		id: live.id,
		name: builtin?.name ?? live.id,
		api: API,
		provider: PROVIDER_ID,
		baseUrl,
		reasoning: live.reasoning ?? builtin?.reasoning ?? false,
		input: vision ? ["text", "image"] : ["text"],
		...(builtin?.inputLimits ? { inputLimits: builtin.inputLimits } : {}),
		cost: builtin ? { ...builtin.cost } : { ...ZERO_COST },
		...(builtin?.promptCache ? { promptCache: builtin.promptCache } : {}),
		...(builtin?.thinkingLevelMap ? { thinkingLevelMap: builtin.thinkingLevelMap } : {}),
		contextWindow,
		maxTokens: builtin?.maxTokens ?? Math.min(contextWindow, FALLBACK_MAX_TOKENS),
	};
}

/**
 * Static baseline: the bundled Mistral catalog re-pointed at the Responses API.
 * Keeps the channel usable before the first discovery, without a key, and with
 * `--offline`.
 */
export function baselineModels(baseUrl: string): Model<Api>[] {
	return getBuiltinModels("mistral").map((model) => ({
		...model,
		api: API,
		provider: PROVIDER_ID,
		baseUrl,
		cost: { ...model.cost },
	}));
}

function isChatModel(model: AnyModel): model is Model<Api> {
	return model.type === undefined || model.type === "chat";
}

function storedModels(context: RefreshModelsContext): Model<Api>[] {
	const stored = context.stored?.models ?? [];
	return stored.filter((model) => model.provider === PROVIDER_ID && isChatModel(model));
}

/**
 * `createProvider` calls this during a model refresh: once offline to restore the
 * persisted catalog, then with the resolved credential. Whatever we return is
 * persisted, so a failed request must return the previous list, never an empty one.
 */
export async function discoverModels(
	context: RefreshModelsContext,
	config: MistralResponsesConfig,
): Promise<Model<Api>[]> {
	const stored = storedModels(context);
	const apiKey = context.credential?.type === "api_key" ? context.credential.key?.trim() : undefined;
	if (!apiKey) return stored;

	let live: LiveModel[];
	try {
		const response = await fetch(config.modelsUrl, {
			method: "GET",
			headers: { accept: "application/json", Authorization: `Bearer ${apiKey}` },
			signal: context.signal,
		});
		if (!response.ok) return stored;
		live = parseLiveModels(await response.json());
	} catch {
		// Offline or a transient failure: keep the last good list.
		return stored;
	}

	if (live.length === 0) {
		const seeded = config.explicitModels.map((id) => toModel({ id }, config.baseUrl));
		return seeded.length > 0 ? seeded : stored;
	}
	return live.map((model) => toModel(model, config.baseUrl));
}
