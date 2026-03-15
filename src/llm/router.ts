import { OpenAICompatibleClient } from "./openai_compatible.js";
import type { ChatMessage, ChatOptions, ChatResponse } from "./types.js";
import { resolveProviderRuntimeConfig, resolveProviderSettings } from "./provider.js";

export async function chatOnce(
  messages: ChatMessage[],
  options?: ChatOptions,
): Promise<ChatResponse> {
  const client = new OpenAICompatibleClient(
    options?.providerConfig ??
      resolveProviderRuntimeConfig(resolveProviderSettings()),
  );
  return client.chat(messages, options);
}
