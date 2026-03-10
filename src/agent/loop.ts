import { chatOnce } from "../llm/router.js";
import type { ChatMessage } from "../llm/types.js";

export type RunAgentLoopOptions = {
  onChunk?: (chunk: string) => void;
};

export async function runAgentLoop(
  userPrompt: string,
  options?: RunAgentLoopOptions,
): Promise<string> {
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

  return chatOnce(
    messages,
    options?.onChunk ? { onChunk: options.onChunk } : undefined,
  );
}
