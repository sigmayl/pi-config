import type { Api, Model, ModelCost } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { AnyRouterConfig } from "./config.ts";

export const PROVIDER_ID = "anyrouter";
export const PROVIDER_NAME = "AnyRouter";

export type ModelKind = "openai" | "claude";

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

interface BuiltinCatalog {
	openai: Map<string, Model<Api>>;
	anthropic: Map<string, Model<Api>>;
}

let builtinCatalog: BuiltinCatalog | undefined;

function getBuiltinCatalog(): BuiltinCatalog {
	if (builtinCatalog) return builtinCatalog;
	const toMap = (models: readonly Model<Api>[]) => new Map(models.map((model) => [model.id, model]));
	builtinCatalog = {
		openai: toMap(getBuiltinModels("openai")),
		anthropic: toMap(getBuiltinModels("anthropic")),
	};
	return builtinCatalog;
}

function idLookupCandidates(id: string): string[] {
	const candidates = new Set<string>();
	const add = (value: string) => {
		const trimmed = value.trim();
		if (trimmed) candidates.add(trimmed);
	};
	add(id);
	let current = id;
	for (let i = 0; i < 3; i++) {
		const withoutVariant = current
			.replace(/-thinking$/i, "")
			.replace(/\[1m\]$/i, "")
			.replace(/:thinking$/i, "")
			.replace(/-latest$/i, "");
		add(withoutVariant);
		const withoutDate = withoutVariant
			.replace(/-\d{8}$/, "")
			.replace(/-\d{4}-\d{2}-\d{2}$/, "");
		add(withoutDate);
		if (withoutDate === current) break;
		current = withoutDate;
	}
	return [...candidates];
}

function findBuiltinModel(kind: ModelKind, id: string): Model<Api> | undefined {
	const catalog = getBuiltinCatalog();
	const models = kind === "claude" ? catalog.anthropic : catalog.openai;
	for (const candidate of idLookupCandidates(id)) {
		const model = models.get(candidate);
		if (model) return model;
	}
	return undefined;
}

function capitalize(value: string): string {
	if (value.length === 0) return value;
	return value[0].toUpperCase() + value.slice(1).toLowerCase();
}

function titleizeWords(value: string): string {
	return value
		.split("-")
		.filter(Boolean)
		.map(capitalize)
		.join(" ");
}

/**
 * Display names are best-effort. IDs, not names, are sent to the relay.
 */
export function displayName(id: string): string {
	const clean = id
		.replace(/-latest$/i, "")
		.replace(/-\d{8}$/, "")
		.replace(/-\d{4}-\d{2}-\d{2}$/, "");

	const claude = clean.match(/^claude-(?:(\d+)-(\d+)-)?(opus|sonnet|haiku|fable)(?:-(\d+)-(\d+))?(?:-.*)?$/i);
	if (claude) {
		const [, majorBefore, minorBefore, family, majorAfter, minorAfter] = claude;
		const major = majorAfter ?? majorBefore;
		const minor = minorAfter ?? minorBefore;
		const version = major ? `${major}${minor ? `.${minor}` : ""}` : "";
		return `Claude ${capitalize(family)}${version ? ` ${version}` : ""}`;
	}

	const legacyClaude = clean.match(/^claude-(\d+)-(opus|sonnet|haiku|fable)$/i);
	if (legacyClaude) {
		return `Claude ${capitalize(legacyClaude[2])} ${legacyClaude[1]}`;
	}

	const gpt = clean.match(/^gpt-([0-9]+(?:\.[0-9]+)?[a-z]?)(.*)$/i);
	if (gpt) {
		const suffix = titleizeWords(gpt[2].replace(/^-/, ""));
		return `GPT-${gpt[1]}${suffix ? ` ${suffix}` : ""}`;
	}

	if (/^o\d/i.test(clean)) {
		return clean
			.split("-")
			.filter(Boolean)
			.map((part) => (part.length <= 2 ? part.toUpperCase() : capitalize(part)))
			.join(" ");
	}

	return titleizeWords(clean) || id;
}

function inferReasoning(id: string, kind: ModelKind): boolean {
	if (kind === "claude") return true;
	return /gpt-5|gpt-6|codex|^o[1-9]/i.test(id);
}

function inferContextWindow(id: string, kind: ModelKind): number {
	if (/1m/i.test(id)) return 1_000_000;
	if (kind === "claude") return 200_000;
	if (/gpt-4o|gpt-4(?!\.1)/i.test(id)) return 128_000;
	return 200_000;
}

function inferMaxTokens(id: string, kind: ModelKind): number {
	if (kind === "claude") return 32_000;
	if (/gpt-4o|gpt-4(?!\.1)/i.test(id)) return 16_384;
	return 32_000;
}

function withoutFallbackModels(compat: unknown): Record<string, unknown> | undefined {
	if (!compat || typeof compat !== "object") return undefined;
	const copy = { ...(compat as Record<string, unknown>) };
	delete copy.allowedFallbackModels;
	return copy;
}

export function buildModel(id: string, kind: ModelKind, config: AnyRouterConfig): Model<Api> {
	const builtin = findBuiltinModel(kind, id);
	const api = kind === "claude" ? config.claudeApi : config.openaiApi;
	const baseUrl = kind === "claude" ? config.anthropicBaseUrl : config.openaiBaseUrl;
	const compat = withoutFallbackModels(builtin?.compat);

	return {
		id,
		name: builtin?.name ?? displayName(id),
		api,
		provider: PROVIDER_ID,
		baseUrl,
		reasoning: builtin?.reasoning ?? inferReasoning(id, kind),
		input: builtin?.input ?? ["text", "image"],
		...(builtin?.inputLimits ? { inputLimits: builtin.inputLimits } : {}),
		cost: { ...ZERO_COST },
		...(builtin?.thinkingLevelMap ? { thinkingLevelMap: builtin.thinkingLevelMap } : {}),
		...(builtin?.promptCache ? { promptCache: builtin.promptCache } : {}),
		contextWindow: config.contextWindowOverride ?? builtin?.contextWindow ?? inferContextWindow(id, kind),
		maxTokens: config.maxTokensOverride ?? builtin?.maxTokens ?? inferMaxTokens(id, kind),
		...(compat ? { compat: compat as Model<Api>["compat"] } : {}),
	};
}

export function classifyModelId(id: string, config: AnyRouterConfig): ModelKind | undefined {
	const lower = id.toLowerCase();
	if (config.claudeKeywords.some((keyword) => lower.includes(keyword))) return "claude";
	if (config.openaiKeywords.some((keyword) => lower.includes(keyword))) return "openai";
	return undefined;
}

function collectModelIds(value: unknown, ids: Set<string>, depth: number): void {
	if (value === null || value === undefined || depth > 4) return;
	if (typeof value === "string") {
		const id = value.trim();
		if (id) ids.add(id);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectModelIds(item, ids, depth + 1);
		return;
	}
	if (typeof value !== "object") return;

	const record = value as Record<string, unknown>;
	const direct =
		typeof record.id === "string"
			? record.id
			: typeof record.model === "string"
				? record.model
				: typeof record.name === "string"
					? record.name
					: undefined;
	if (direct?.trim()) ids.add(direct.trim());

	for (const key of ["data", "models", "result", "items", "list"]) {
		if (key in record) collectModelIds(record[key], ids, depth + 1);
	}
}

/**
 * Accepts the common /v1/models shapes: OpenAI `{data:[{id}]}`, Anthropic
 * `{data:[{id}]}`, `{models:[...]}`, or a bare array.
 */
export function parseModelIds(payload: unknown): string[] {
	const ids = new Set<string>();
	collectModelIds(payload, ids, 0);
	return [...ids];
}

export function modelsFromIds(ids: readonly string[], config: AnyRouterConfig): Model<Api>[] {
	const seen = new Set<string>();
	const models: Model<Api>[] = [];
	for (const rawId of ids) {
		const id = rawId.trim();
		if (!id || seen.has(id)) continue;
		const kind = classifyModelId(id, config);
		if (!kind) continue;
		seen.add(id);
		models.push(buildModel(id, kind, config));
	}
	return models;
}

export function configModels(config: AnyRouterConfig): Model<Api>[] {
	const models: Model<Api>[] = [];
	const seen = new Set<string>();
	const add = (rawId: string, kind: ModelKind) => {
		const id = rawId.trim();
		if (!id || seen.has(id)) return;
		seen.add(id);
		models.push(buildModel(id, kind, config));
	};

	for (const id of config.explicitModels) {
		const kind = classifyModelId(id, config);
		if (kind) add(id, kind);
	}
	for (const id of config.explicitOpenAIModels) add(id, "openai");
	for (const id of config.explicitClaudeModels) add(id, "claude");

	return models;
}
