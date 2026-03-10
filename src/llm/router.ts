import { OpenAICompatibleClient } from "./openai_compatible.js";
import type { ChatMessage, ChatOptions } from "./types.js";

export async function chatOnce(
  messages: ChatMessage[],
  options?: ChatOptions,
): Promise<string> {
  const client = new OpenAICompatibleClient();
  return client.chat(messages, options);
}
