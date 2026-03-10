import { OpenAICompatibleClient } from "./openai_compatible.js";
import type { ChatMessage } from "./types.js";

export async function chatOnce(messages: ChatMessage[]): Promise<string> {
  const client = new OpenAICompatibleClient();
  return client.chat(messages);
}
