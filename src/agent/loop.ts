import { chatOnce } from "../llm/router.js";
import type { ChatMessage, ChatOptions, ConversationMessage } from "../llm/types.js";
import { DEFAULT_SYSTEM_PROMPT } from "../prompts/system.js";

export type AgentTurnOptions = ChatOptions;

export type AgentSession = {
  systemPrompt: string;
  history: ConversationMessage[];
};

export type CreateAgentSessionOptions = {
  systemPrompt?: string;
  history?: ConversationMessage[];
};

export function createAgentSession(
  options?: CreateAgentSessionOptions,
): AgentSession {
  return {
    systemPrompt: options?.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
    history: [...(options?.history ?? [])],
  };
}

export function buildTurnMessages(
  session: AgentSession,
  userPrompt: string,
): ChatMessage[] {
  return [
    {
      role: "system",
      content: session.systemPrompt,
    },
    ...session.history,
    {
      role: "user",
      content: userPrompt,
    },
  ];
}

export async function runAgentTurn(
  session: AgentSession,
  userPrompt: string,
  options?: AgentTurnOptions,
): Promise<string> {
  const trimmedPrompt = userPrompt.trim();

  if (!trimmedPrompt) {
    throw new Error("User prompt must not be empty.");
  }

  const reply = await chatOnce(buildTurnMessages(session, trimmedPrompt), options);

  session.history.push(
    {
      role: "user",
      content: trimmedPrompt,
    },
    {
      role: "assistant",
      content: reply,
    },
  );

  return reply;
}

export async function runAgentLoop(
  userPrompt: string,
  options?: AgentTurnOptions,
): Promise<string> {
  const session = createAgentSession();
  return runAgentTurn(session, userPrompt, options);
}
