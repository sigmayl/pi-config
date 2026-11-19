import type { Api } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMistralAuth } from "./api-key.ts";
import { loadConfig } from "./config.ts";
import { createEchTransport } from "./ech.ts";
import { baselineModels, discoverModels, PROVIDER_ID, PROVIDER_NAME } from "./models.ts";

/**
 * A second Mistral channel that speaks the OpenAI Responses protocol instead of
 * Mistral Conversations. The built-in `mistral` provider keeps its own models and
 * wire format; this one discovers its model list from `GET /v1/models`.
 */
export default function mistralResponsesProvider(pi: ExtensionAPI): void {
	const config = loadConfig();
	const ech = createEchTransport(config.ech);
	const responses = openAIResponsesApi();
	if (ech) pi.on("session_shutdown", () => ech.close());

	pi.registerProvider(
		createProvider<Api>({
			id: PROVIDER_ID,
			name: PROVIDER_NAME,
			baseUrl: config.baseUrl,
			auth: { apiKey: createMistralAuth() },
			models: baselineModels(config.baseUrl),
			api: ech
				? {
						...responses,
						stream: (model, context, options) =>
							responses.stream(model, context, { ...options, fetch: ech.wrapFetch(options?.fetch) }),
						streamSimple: (model, context, options) =>
							responses.streamSimple(model, context, { ...options, fetch: ech.wrapFetch(options?.fetch) }),
					}
				: responses,
			fetchModels: (context) => discoverModels(context, config, ech?.wrapFetch()),
		}),
	);
}
