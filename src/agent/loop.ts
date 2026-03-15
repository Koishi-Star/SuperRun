import { chatOnce } from "../llm/router.js";
import type { ChatMessage, ChatOptions, ConversationMessage } from "../llm/types.js";
import { DEFAULT_SYSTEM_PROMPT } from "../prompts/system.js";
import { parseAgentMode, type AgentMode } from "./mode.js";
import { executeAgentTool, getAgentToolDefinitions } from "../tools/index.js";
import type { ToolExecutionContext } from "../tools/types.js";

export type AgentTurnOptions = ChatOptions & {
  toolContext?: ToolExecutionContext;
};
export const DEFAULT_MAX_HISTORY_TURNS = 10;
// Coding-oriented models often need several inspect/edit/verify rounds before
// they can finish naturally, so keep a guardrail without forcing tiny loops.
const MAX_TOOL_CALL_ROUNDS = 8;
const TOOL_LOOP_WARNING_AFTER_ROUND = 4;

export class AgentToolLoopLimitError extends Error {
  readonly maxRounds: number;

  constructor(maxRounds: number) {
    super("Model exceeded the maximum tool call rounds.");
    this.name = "AgentToolLoopLimitError";
    this.maxRounds = maxRounds;
  }
}

export type AgentSession = {
  mode: AgentMode;
  systemPrompt: string;
  history: ConversationMessage[];
  maxHistoryTurns: number;
};

export type CreateAgentSessionOptions = {
  mode?: AgentMode;
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
    mode: parseAgentMode(options?.mode),
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
  const reply = await resolveAgentReply(
    buildTurnMessages(session, trimmedPrompt),
    session.mode,
    options,
  );

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

async function resolveAgentReply(
  baseMessages: ChatMessage[],
  mode: AgentMode,
  options?: AgentTurnOptions,
): Promise<string> {
  const messages = [...baseMessages];
  const tools = getAgentToolDefinitions(mode);

  for (let round = 0; round <= MAX_TOOL_CALL_ROUNDS; round += 1) {
    const isFinalAnswerAttempt = round === MAX_TOOL_CALL_ROUNDS;
    const response = await chatOnce(
      buildRoundMessages(messages, round, isFinalAnswerAttempt),
      {
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        // The last pass disables tools so the model has to summarize or explain
        // the limit instead of looping forever through more reads or commands.
        ...(isFinalAnswerAttempt ? {} : { tools }),
      },
    );

    if (response.toolCalls.length === 0) {
      if (!response.content) {
        throw new Error("Model returned empty content.");
      }

      if (options?.onChunk) {
        // Tool routing currently resolves non-streaming first, then flushes the
        // final assistant reply through the existing chunk callback.
        options.onChunk(response.content);
      }

      return response.content;
    }

    if (isFinalAnswerAttempt) {
      throw new AgentToolLoopLimitError(MAX_TOOL_CALL_ROUNDS);
    }

    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
      ...(response.reasoningContent
        ? { reasoningContent: response.reasoningContent }
        : {}),
    });

    for (const toolCall of response.toolCalls) {
      const toolResult = await executeAgentTool(
        toolCall,
        mode,
        options?.toolContext,
      );
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: toolResult,
      });
    }
  }

  throw new AgentToolLoopLimitError(MAX_TOOL_CALL_ROUNDS);
}

function buildRoundMessages(
  messages: ChatMessage[],
  round: number,
  isFinalAnswerAttempt: boolean,
): ChatMessage[] {
  const warning = buildToolLoopWarning(round, isFinalAnswerAttempt);
  return warning
    ? [
        ...messages,
        {
          role: "system",
          content: warning,
        },
      ]
    : messages;
}

function buildToolLoopWarning(
  round: number,
  isFinalAnswerAttempt: boolean,
): string | null {
  if (isFinalAnswerAttempt) {
    return `You have already used ${MAX_TOOL_CALL_ROUNDS} tool rounds on this turn. Do not call more tools. Respond with the best answer you can from the information already gathered. If the results were blocked, redacted, repetitive, or insufficient, say that plainly, summarize the relevant findings, and ask the user for a narrower target instead of continuing a broad search.`;
  }

  if (round < TOOL_LOOP_WARNING_AFTER_ROUND) {
    return null;
  }

  return `You have already used ${round} tool rounds on this turn. Avoid repeating broad scans or reading the same kind of files again. Only call another tool if it directly narrows the answer or applies the requested change. If results are blocked, redacted, repetitive, or insufficient, stop and explain the limit instead.`;
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
