export type EchMode = "auto" | "1" | "0";

export interface MistralResponsesConfig {
	/** OpenAI-compatible root the Responses API appends `/responses` to. */
	baseUrl: string;
	/** Model discovery endpoint. */
	modelsUrl: string;
	/** Seed IDs used when discovery returns nothing. */
	explicitModels: string[];
	ech: EchMode;
}

export const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";

type Env = Record<string, string | undefined>;

function readEnv(env: Env, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function readList(env: Env, name: string): string[] {
	const raw = readEnv(env, name);
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export function loadConfig(env: Env = process.env): MistralResponsesConfig {
	const baseUrl = (readEnv(env, "MISTRAL_RESPONSES_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const ech = readEnv(env, "MISTRAL_RESPONSES_ECH") ?? "auto";
	if (ech !== "auto" && ech !== "1" && ech !== "0") {
		throw new Error("MISTRAL_RESPONSES_ECH must be auto, 1, or 0");
	}
	return {
		baseUrl,
		modelsUrl: readEnv(env, "MISTRAL_RESPONSES_MODELS_URL") ?? `${baseUrl}/models`,
		explicitModels: readList(env, "MISTRAL_RESPONSES_MODELS"),
		ech,
	};
}
