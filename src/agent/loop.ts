import { chatOnce } from "../llm/router.js";
import type { ChatMessage } from "../llm/types.js";

export async function runAgentLoop(userPrompt: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a helpful coding assistant. Be accurate, concise, and practical.",
    },
    {
      role: "user",
      content: userPrompt,
    },
  ];

  return chatOnce(messages);
}
