import { chatOnce } from "../llm/router.js";
import type { ChatMessage, ChatOptions, ConversationMessage } from "../llm/types.js";
import { DEFAULT_SYSTEM_PROMPT } from "../prompts/system.js";

export type AgentTurnOptions = ChatOptions;
export const DEFAULT_MAX_HISTORY_TURNS = 10;

export type AgentSession = {
  systemPrompt: string;
  history: ConversationMessage[];
  maxHistoryTurns: number;
};

export type CreateAgentSessionOptions = {
  systemPrompt?: string;
  history?: ConversationMessage[];
  maxHistoryTurns?: number;
};

export type AgentSessionStats = {
  historyTurnCount: number;
  historyMessageCount: number;
  historyCharCount: number;
  systemPromptCharCount: number;
  maxHistoryTurns: number;
};

export function createAgentSession(
  options?: CreateAgentSessionOptions,
): AgentSession {
  return {
    systemPrompt: options?.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
    history: [...(options?.history ?? [])],
    maxHistoryTurns: normalizeMaxHistoryTurns(options?.maxHistoryTurns),
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

  trimSessionHistory(session);
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
  trimSessionHistory(session);

  return reply;
}

export async function runAgentLoop(
  userPrompt: string,
  options?: AgentTurnOptions,
): Promise<string> {
  const session = createAgentSession();
  return runAgentTurn(session, userPrompt, options);
}

export function getAgentSessionStats(session: AgentSession): AgentSessionStats {
  return {
    historyTurnCount: countHistoryTurns(session.history),
    historyMessageCount: session.history.length,
    historyCharCount: session.history.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
    systemPromptCharCount: session.systemPrompt.length,
    maxHistoryTurns: session.maxHistoryTurns,
  };
}

function trimSessionHistory(session: AgentSession): void {
  session.history = trimConversationHistory(session.history, session.maxHistoryTurns);
}

function trimConversationHistory(
  history: ConversationMessage[],
  maxHistoryTurns: number,
): ConversationMessage[] {
  let turnCount = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role !== "user") {
      continue;
    }

    turnCount += 1;
    if (turnCount > maxHistoryTurns) {
      const nextIndex = index + 1;
      const sliceStart =
        history[nextIndex]?.role === "assistant" ? nextIndex + 1 : nextIndex;
      return history.slice(sliceStart);
    }
  }

  return [...history];
}

function countHistoryTurns(history: ConversationMessage[]): number {
  return history.filter((message) => message.role === "user").length;
}

function normalizeMaxHistoryTurns(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_HISTORY_TURNS;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxHistoryTurns must be a positive integer when set.");
  }

  return value;
}
