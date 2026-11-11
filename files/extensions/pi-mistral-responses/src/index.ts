import type { Api } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMistralAuth } from "./api-key.ts";
import { loadConfig } from "./config.ts";
import { baselineModels, discoverModels, PROVIDER_ID, PROVIDER_NAME } from "./models.ts";

/**
 * A second Mistral channel that speaks the OpenAI Responses protocol instead of
 * Mistral Conversations. The built-in `mistral` provider keeps its own models and
 * wire format; this one discovers its model list from `GET /v1/models`.
 */
export default function mistralResponsesProvider(pi: ExtensionAPI): void {
	const config = loadConfig();

	pi.registerProvider(
		createProvider<Api>({
			id: PROVIDER_ID,
			name: PROVIDER_NAME,
			baseUrl: config.baseUrl,
			auth: { apiKey: createMistralAuth() },
			models: baselineModels(config.baseUrl),
			api: openAIResponsesApi(),
			fetchModels: (context) => discoverModels(context, config),
		}),
	);
}
