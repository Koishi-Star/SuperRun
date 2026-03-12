import { OpenAICompatibleClient } from "./openai_compatible.js";
import type { ChatMessage, ChatOptions, ChatResponse } from "./types.js";

export async function chatOnce(
  messages: ChatMessage[],
  options?: ChatOptions,
): Promise<ChatResponse> {
  const client = new OpenAICompatibleClient();
  return client.chat(messages, options);
}
