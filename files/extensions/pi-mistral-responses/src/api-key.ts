import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApiKeyAuth, AuthContext } from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "./models.ts";

/**
 * The Responses channel is an alternative wire protocol for the same account, so
 * it resolves credentials in this order:
 *
 * 1. its own stored credential (`/login mistral-responses`)
 * 2. `MISTRAL_API_KEY`
 * 3. the `mistral` provider's stored key in `auth.json`
 *
 * Step 3 keeps a single source of truth: rotating the key with `/login mistral`
 * also rotates this channel, with no second copy to forget.
 */
const FALLBACK_PROVIDER_ID = "mistral";
const ENV_VARS = ["MISTRAL_API_KEY"] as const;

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

async function storedFallbackKey(): Promise<string | undefined> {
	try {
		const raw = await readFile(join(agentDir(), "auth.json"), "utf8");
		const parsed = JSON.parse(raw) as Record<string, { key?: unknown } | undefined>;
		const key = parsed[FALLBACK_PROVIDER_ID]?.key;
		return typeof key === "string" && key.trim() ? key.trim() : undefined;
	} catch {
		// Missing or unreadable auth.json is not an error: the channel is simply unconfigured.
		return undefined;
	}
}

/** Resolve the Mistral key from the environment or the `mistral` credential. */
export async function resolveMistralKey(
	ctx: AuthContext,
): Promise<{ key: string; source: string } | undefined> {
	for (const name of ENV_VARS) {
		const value = await ctx.env(name);
		if (value?.trim()) return { key: value.trim(), source: name };
	}
	const key = await storedFallbackKey();
	return key ? { key, source: `${FALLBACK_PROVIDER_ID} credential` } : undefined;
}

export function createMistralAuth(): ApiKeyAuth {
	return {
		name: "Mistral API key",
		async login(interaction) {
			const key = await interaction.prompt({ type: "secret", message: "Mistral API key" });
			return { type: "api_key", key };
		},
		async resolve({ ctx, credential }) {
			const stored = credential?.key?.trim();
			if (stored) return { auth: { apiKey: stored }, source: `stored credential for ${PROVIDER_ID}` };
			const resolved = await resolveMistralKey(ctx);
			return resolved ? { auth: { apiKey: resolved.key }, source: resolved.source } : undefined;
		},
	};
}
