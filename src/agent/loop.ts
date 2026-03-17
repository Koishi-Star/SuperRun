import { chatOnce } from "../llm/router.js";
import type {
  ChatMessage,
  ChatOptions,
  ConversationMessage,
  ToolCall,
} from "../llm/types.js";
import {
  buildContextBudgetSnapshot,
  createEmptyContextBudgetSnapshot,
  estimateChatMessageTokens,
  getSafeContextBudgetTokens,
  type ContextBudgetSnapshot,
} from "./context-budget.js";
import {
  getInProgressTaskPlanStep,
  hasTaskPlanProgress,
  isTaskPlanResolved,
  type TaskPlan,
  type TaskPlanStepStatus,
} from "./plan.js";
import {
  resolveProviderRuntimeConfig,
  resolveProviderSettings,
  type ProviderUsage,
} from "../llm/provider.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  buildSessionSystemPrompt,
} from "../prompts/system.js";
import { parseAgentMode, type AgentMode } from "./mode.js";
import { executeAgentTool, getAgentToolDefinitions } from "../tools/index.js";
import type { ToolExecutionContext } from "../tools/types.js";
import {
  FETCH_WEBPAGE_TOOL_NAME,
  createFetchWebpageSessionCache,
  executeFetchWebpageToolCall,
  hasCachedFetchWebpageOutline,
  normalizeFetchWebpageUrl,
  parseFetchWebpageArgs,
  type FetchWebpageSessionCache,
} from "../tools/fetch_webpage.js";

export type AgentTurnOptions = ChatOptions & {
  toolContext?: ToolExecutionContext;
  onModelRequestStateChange?: (active: boolean) => void;
  commitHistory?: boolean;
  streamFinalResponse?: boolean;
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
  activePlan: TaskPlan | null;
  maxHistoryTurns: number;
  contextBudget: ContextBudgetSnapshot;
  webpageFetchCache: FetchWebpageSessionCache;
};

export type CreateAgentSessionOptions = {
  mode?: AgentMode;
  systemPrompt?: string;
  history?: ConversationMessage[];
  activePlan?: TaskPlan | null;
  maxHistoryTurns?: number;
  contextBudget?: ContextBudgetSnapshot;
};

export type AgentSessionStats = {
  historyTurnCount: number;
  historyMessageCount: number;
  historyCharCount: number;
  systemPromptCharCount: number;
  maxHistoryTurns: number;
  currentContextTokens: number | null;
  effectiveContextLimitTokens: number | null;
  contextUsageSource: ContextBudgetSnapshot["usageSource"];
};

export type AgentTurnResult = {
  reply: string;
  usage?: ProviderUsage;
  contextBudgetSnapshot: ContextBudgetSnapshot;
  trimmedTurns: number;
};

const PLAN_UPDATE_TOOL_NAME = "update_plan";
const PLAN_EXEMPT_TOOL_NAMES = new Set([PLAN_UPDATE_TOOL_NAME, "request_user_input"]);

export function createAgentSession(
  options?: CreateAgentSessionOptions,
): AgentSession {
  return {
    mode: parseAgentMode(options?.mode),
    systemPrompt: options?.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
    history: [...(options?.history ?? [])],
    activePlan: options?.activePlan ? { ...options.activePlan } : null,
    maxHistoryTurns: normalizeMaxHistoryTurns(options?.maxHistoryTurns),
    contextBudget: options?.contextBudget
      ? { ...options.contextBudget }
      : createEmptyContextBudgetSnapshot(),
    webpageFetchCache: createFetchWebpageSessionCache(),
  };
}

export function buildTurnMessages(
  session: AgentSession,
  userPrompt: string,
): ChatMessage[] {
  return [
    {
      role: "system",
      content: getEffectiveSystemPrompt(session),
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
): Promise<AgentTurnResult> {
  const trimmedPrompt = userPrompt.trim();

  if (!trimmedPrompt) {
    throw new Error("User prompt must not be empty.");
  }
  throwIfAborted(options?.abortSignal);

  const providerConfig = options?.providerConfig ??
    resolveProviderRuntimeConfig(resolveProviderSettings());
  const trimmedTurns = trimSessionHistory(session, trimmedPrompt);
  const baseMessages = buildTurnMessages(session, trimmedPrompt);
  const estimatedPromptTokens = estimateChatMessageTokens(
    buildRoundMessages(baseMessages, 0, false, session.activePlan),
  );
  const response = await resolveAgentReply(
    baseMessages,
    session,
    options,
  );
  const contextBudgetSnapshot = buildContextBudgetSnapshot({
    modelContextTokens: providerConfig.modelContextTokens,
    configuredContextLimitTokens: providerConfig.contextLimitTokens,
    usage: response.usage,
    estimatedPromptTokens,
  });

  if (options?.commitHistory !== false) {
    commitAgentTurnHistory(session, trimmedPrompt, response.content);
  }
  session.contextBudget = contextBudgetSnapshot;

  return {
    reply: response.content,
    ...(response.usage ? { usage: response.usage } : {}),
    contextBudgetSnapshot,
    trimmedTurns,
  };
}

export async function runAgentLoop(
  userPrompt: string,
  options?: AgentTurnOptions,
): Promise<string> {
  const session = createAgentSession();
  const result = await runAgentTurn(session, userPrompt, options);
  return result.reply;
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
    currentContextTokens: session.contextBudget.lastPromptTokens ??
      session.contextBudget.estimatedPromptTokens,
    effectiveContextLimitTokens: session.contextBudget.effectiveContextLimitTokens,
    contextUsageSource: session.contextBudget.usageSource,
  };
}

function trimSessionHistory(
  session: AgentSession,
  upcomingUserPrompt = "",
): number {
  const trimmed = trimConversationHistory(
    session.history,
    session.maxHistoryTurns,
    getEffectiveSystemPrompt(session),
    session.contextBudget.effectiveContextLimitTokens,
    upcomingUserPrompt,
  );
  session.history = trimmed.history;
  return trimmed.trimmedTurns;
}

export function commitAgentTurnHistory(
  session: AgentSession,
  userPrompt: string,
  assistantReply: string,
): void {
  session.history.push(
    {
      role: "user",
      content: userPrompt,
    },
    {
      role: "assistant",
      content: assistantReply,
    },
  );
  trimSessionHistory(session);
}

async function resolveAgentReply(
  baseMessages: ChatMessage[],
  session: AgentSession,
  options?: AgentTurnOptions,
): Promise<{ content: string; usage?: ProviderUsage }> {
  const messages = [...baseMessages];
  const tools = getAgentToolDefinitions(session.mode);
  let lastUsage: ProviderUsage | undefined;

  for (let round = 0; round <= MAX_TOOL_CALL_ROUNDS; round += 1) {
    throwIfAborted(options?.abortSignal);
    const isFinalAnswerAttempt = round === MAX_TOOL_CALL_ROUNDS;
    options?.onModelRequestStateChange?.(true);
    const response = await chatOnce(
      buildRoundMessages(messages, round, isFinalAnswerAttempt, session.activePlan),
      {
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(options?.providerConfig
          ? { providerConfig: options.providerConfig }
          : {}),
        ...(options?.abortSignal
          ? { abortSignal: options.abortSignal }
          : {}),
        // The last pass disables tools so the model has to summarize or explain
        // the limit instead of looping forever through more reads or commands.
        ...(isFinalAnswerAttempt ? {} : { tools }),
      },
    ).finally(() => {
      options?.onModelRequestStateChange?.(false);
    });
    throwIfAborted(options?.abortSignal);
    if (response.usage) {
      lastUsage = response.usage;
    }

    if (response.toolCalls.length === 0) {
      if (!response.content) {
        throw new Error("Model returned empty content.");
      }

      if (session.activePlan && hasTaskPlanProgress(session.activePlan) && !isTaskPlanResolved(session.activePlan)) {
        if (doesAssistantReportBlockedOutcome(response.content)) {
          session.activePlan = markRemainingPlanStepsBlocked(session.activePlan);
        } else {
          if (response.content && options?.onChunk) {
            options.onChunk(ensureAssistantChunkSpacing(response.content));
          }

          if (isFinalAnswerAttempt) {
            throw new Error(
              "Task plan is still incomplete. Mark the remaining steps completed or blocked before finishing the turn.",
            );
          }

          messages.push({
            role: "assistant",
            content: response.content,
          });
          messages.push({
            role: "system",
            content: buildIncompletePlanReminder(session.activePlan),
          });
          continue;
        }
      }

      if (options?.onChunk && options?.streamFinalResponse !== false) {
        options.onChunk(response.content);
      }

      const usage = response.usage ?? lastUsage;
      return usage
        ? {
            content: response.content,
            usage,
          }
        : {
            content: response.content,
          };
    }

    if (isFinalAnswerAttempt) {
      throw new AgentToolLoopLimitError(MAX_TOOL_CALL_ROUNDS);
    }

    const outlinedUrlsAtRoundStart = buildOutlinedUrlSnapshot(session.webpageFetchCache);

    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
      ...(response.reasoningContent
        ? { reasoningContent: response.reasoningContent }
        : {}),
    });
    if (response.content && options?.onChunk) {
      options.onChunk(ensureAssistantChunkSpacing(response.content));
    }

    for (const toolCall of response.toolCalls) {
      throwIfAborted(options?.abortSignal);
      const toolExecution = await executeToolCallForAgentRound(
        toolCall,
        session.mode,
        session.activePlan,
        session.webpageFetchCache,
        outlinedUrlsAtRoundStart,
        options?.toolContext,
      );
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: toolExecution.toolResult,
      });

      if (toolExecution.policyMessage) {
        messages.push({
          role: "system",
          content: toolExecution.policyMessage,
        });
      }
    }
  }

  throw new AgentToolLoopLimitError(MAX_TOOL_CALL_ROUNDS);
}

type ToolExecutionOutcome = {
  toolResult: string;
  policyMessage?: string;
};

async function executeToolCallForAgentRound(
  toolCall: ToolCall,
  mode: AgentMode,
  activePlan: TaskPlan | null,
  webpageFetchCache: FetchWebpageSessionCache,
  outlinedUrlsAtRoundStart: ReadonlySet<string>,
  toolContext?: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  const planGate = buildPlanToolGate(toolCall, activePlan);
  if (planGate) {
    return {
      toolResult: JSON.stringify({
        ok: false,
        error: planGate.toolError,
      }),
      policyMessage: planGate.policyMessage,
    };
  }

  if (toolCall.name !== FETCH_WEBPAGE_TOOL_NAME) {
    return {
      toolResult: await executeAgentTool(toolCall, mode, toolContext),
    };
  }

  const parsedArgs = parseFetchWebpageArgs(toolCall.arguments);
  const requestedMode = parsedArgs.mode ?? "outline";
  if (requestedMode !== "article") {
    return {
      toolResult: await executeFetchWebpageToolCall(toolCall.arguments, {
        cache: webpageFetchCache,
        context: toolContext,
      }),
    };
  }

  const normalizedUrl = normalizeFetchWebpageUrl(parsedArgs.url);
  if (outlinedUrlsAtRoundStart.has(normalizedUrl)) {
    return {
      toolResult: await executeFetchWebpageToolCall(toolCall.arguments, {
        cache: webpageFetchCache,
        context: toolContext,
      }),
    };
  }

  const note =
    "Agent retrieval policy deferred the article read until an outline has been reviewed. Use this outline result first, then request article mode in a later round only if more detail is still necessary.";
  return {
    toolResult: await executeFetchWebpageToolCall(toolCall.arguments, {
      cache: webpageFetchCache,
      requestedModeOverride: "outline",
      policyApplied: "outline_before_article",
      note,
      context: toolContext,
    }),
    policyMessage:
      `The agent enforced outline-before-article retrieval for ${normalizedUrl}. The prior fetch_webpage call returned outline mode instead of article mode. Review that outline first and only call article mode in a later round if it is still necessary.`,
  };
}

function buildOutlinedUrlSnapshot(
  webpageFetchCache: FetchWebpageSessionCache,
): ReadonlySet<string> {
  const outlinedUrls = new Set<string>();

  for (const url of webpageFetchCache.keys()) {
    if (hasCachedFetchWebpageOutline(webpageFetchCache, url)) {
      outlinedUrls.add(url);
    }
  }

  return outlinedUrls;
}

function buildRoundMessages(
  messages: ChatMessage[],
  round: number,
  isFinalAnswerAttempt: boolean,
  activePlan: TaskPlan | null,
): ChatMessage[] {
  const planMessage = buildActivePlanSystemMessage(activePlan);
  const warning = buildToolLoopWarning(round, isFinalAnswerAttempt);
  return [
    ...messages,
    ...(planMessage
      ? [{
          role: "system" as const,
          content: planMessage,
        }]
      : []),
    ...(warning
      ? [{
          role: "system" as const,
          content: warning,
        }]
      : []),
  ];
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

function buildActivePlanSystemMessage(
  activePlan: TaskPlan | null,
): string | null {
  if (!activePlan) {
    return null;
  }

  const currentStep = getInProgressTaskPlanStep(activePlan);
  return [
    `Active task plan: ${activePlan.title}`,
    "Before using any tool other than update_plan, mark exactly one relevant plan step as in_progress with update_plan.",
    "After finishing a step, mark it completed or blocked with update_plan.",
    "Do not claim that edits succeeded unless the workspace was actually changed and later verification passes.",
    `Current in-progress step: ${currentStep ? `${currentStep.id} ${currentStep.title}` : "none"}`,
    "Plan steps:",
    ...activePlan.steps.map((step) =>
      `- ${step.id} [${step.status}] ${step.title}${step.note ? ` note: ${step.note}` : ""}`,
    ),
  ].join("\n");
}

function buildIncompletePlanReminder(
  activePlan: TaskPlan,
): string {
  const remainingSteps = activePlan.steps
    .filter((step) => step.status === "pending" || step.status === "in_progress")
    .map((step) => `${step.id} ${step.title}`);
  return [
    "The task plan is still incomplete, so you may not finish this turn yet.",
    "Call update_plan to keep the plan accurate, then continue the remaining work.",
    remainingSteps.length > 0
      ? `Remaining steps: ${remainingSteps.join("; ")}`
      : "All remaining steps must be explicitly marked blocked before you finish.",
  ].join(" ");
}

function buildPlanToolGate(
  toolCall: ToolCall,
  activePlan: TaskPlan | null,
): { toolError: string; policyMessage: string } | null {
  if (!activePlan || PLAN_EXEMPT_TOOL_NAMES.has(toolCall.name)) {
    return null;
  }

  if (isTaskPlanResolved(activePlan)) {
    return {
      toolError:
        `The task plan is already resolved. Do not call ${toolCall.name} after every step is completed or blocked.`,
      policyMessage:
        "The agent blocked a tool call because the task plan is already resolved. Only use update_plan if you need to reopen or clarify the plan state.",
    };
  }

  const activeStep = getInProgressTaskPlanStep(activePlan);
  if (activeStep) {
    return null;
  }

  const availableSteps = activePlan.steps
    .filter((step) => step.status === "pending")
    .map((step) => `${step.id} ${step.title}`)
    .join("; ");
  return {
    toolError:
      `Call update_plan first to mark the relevant step as in_progress before using ${toolCall.name}. Available steps: ${availableSteps || "none"}.`,
    policyMessage:
      `The agent blocked ${toolCall.name} because the active task plan had no in-progress step. Call update_plan first, then retry the tool.`,
  };
}

function ensureAssistantChunkSpacing(content: string): string {
  return content.endsWith("\n")
    ? `${content}\n`
    : `${content}\n\n`;
}

function doesAssistantReportBlockedOutcome(content: string): boolean {
  return /(?:blocked|pending interactive approval|requires approval|waiting for approval|cannot continue|needs user input|被阻止|需要审批|等待审批|无法继续)/i
    .test(content);
}

function markRemainingPlanStepsBlocked(
  activePlan: TaskPlan,
): TaskPlan {
  const timestamp = new Date().toISOString();
  return {
    ...activePlan,
    updatedAt: timestamp,
    steps: activePlan.steps.map((step) =>
      step.status === "completed"
        ? { ...step }
        : {
            ...step,
            status: "blocked" as TaskPlanStepStatus,
            ...(step.note
              ? {}
              : {
                  note: "Stopped because the task is blocked and cannot continue in this turn.",
                }),
          }
    ),
  };
}

function trimConversationHistory(
  history: ConversationMessage[],
  maxHistoryTurns: number,
  systemPrompt: string,
  effectiveContextLimitTokens: number | null,
  upcomingUserPrompt: string,
): { history: ConversationMessage[]; trimmedTurns: number } {
  const safeContextBudgetTokens = getSafeContextBudgetTokens(
    effectiveContextLimitTokens,
  );
  if (safeContextBudgetTokens !== null) {
    const nextHistory = [...history];
    let trimmedTurns = 0;

    while (nextHistory.length > 0) {
      const estimatedTokens = estimateChatMessageTokens([
        {
          role: "system",
          content: systemPrompt,
        },
        ...nextHistory,
        ...(upcomingUserPrompt
          ? [{
              role: "user" as const,
              content: upcomingUserPrompt,
            }]
          : []),
      ]);
      if (estimatedTokens <= safeContextBudgetTokens) {
        return {
          history: nextHistory,
          trimmedTurns,
        };
      }

      const nextTrimmed = trimOldestConversationTurn(nextHistory);
      if (nextTrimmed.history.length === nextHistory.length) {
        break;
      }

      trimmedTurns += nextTrimmed.trimmedTurns;
      nextHistory.splice(0, nextHistory.length, ...nextTrimmed.history);
    }

    return {
      history: nextHistory,
      trimmedTurns,
    };
  }

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
      return {
        history: history.slice(sliceStart),
        trimmedTurns: 1,
      };
    }
  }

  return {
    history: [...history],
    trimmedTurns: 0,
  };
}

function getEffectiveSystemPrompt(session: AgentSession): string {
  return buildSessionSystemPrompt(session.systemPrompt, session.mode);
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

function trimOldestConversationTurn(
  history: ConversationMessage[],
): { history: ConversationMessage[]; trimmedTurns: number } {
  const firstUserIndex = history.findIndex((message) => message.role === "user");
  if (firstUserIndex === -1) {
    return {
      history: [...history],
      trimmedTurns: 0,
    };
  }

  let sliceStart = firstUserIndex + 1;
  if (history[sliceStart]?.role === "assistant") {
    sliceStart += 1;
  }

  return {
    history: history.slice(sliceStart),
    trimmedTurns: 1,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }

  throw new Error(
    typeof reason === "string" && reason.trim()
      ? reason
      : "Cancelled the active AI request.",
  );
}
