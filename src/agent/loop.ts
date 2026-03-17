import { basename } from "node:path";
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
import type { ToolExecutionContext, UserInputResponse } from "../tools/types.js";
import { getPlatformShellCommand } from "../tools/shell.js";
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
// Long coding turns often need many read rounds before they can change code.
// Use a high emergency fuse, then only force a final answer when the loop has
// stalled for several consecutive rounds without enough new progress.
export const MAX_TOTAL_TOOL_CALL_ROUNDS = 128;
export const MAX_STALLED_TOOL_CALL_ROUNDS = 6;
const TOOL_LOOP_WARNING_AFTER_ROUND = 12;
const MAX_MODEL_REQUEST_TIMEOUT_RETRIES = 6;

type ToolLoopLimitReason = "stalled" | "safety";

export class AgentToolLoopLimitError extends Error {
  readonly maxRounds: number;
  readonly reason: ToolLoopLimitReason;
  readonly stalledRounds: number;

  constructor(
    maxRounds: number,
    reason: ToolLoopLimitReason,
    stalledRounds = 0,
  ) {
    super("Model exceeded the maximum tool call rounds.");
    this.name = "AgentToolLoopLimitError";
    this.maxRounds = maxRounds;
    this.reason = reason;
    this.stalledRounds = stalledRounds;
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

type RoundPromptGuidance = {
  canRequestUserInput: boolean;
  userInputDismissed: boolean;
};

type ClarificationReplyKind =
  | "clarifying_question"
  | "depends_on_user_input"
  | "other";

const PLAN_UPDATE_TOOL_NAME = "update_plan";
const PLAN_EXEMPT_TOOL_NAMES = new Set([PLAN_UPDATE_TOOL_NAME, "request_user_input"]);
const WORKSPACE_MUTATION_TOOL_NAMES = new Set([
  "write_file",
  "replace_lines",
  "insert_lines",
  "delete_file",
  "restore_deleted_file",
  "purge_deleted_file",
  "empty_delete_area",
  "trash",
]);

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
    {
      role: "system",
      content: buildRuntimeEnvironmentMessage(),
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
    buildRoundMessages(baseMessages, 0, {
      isFinalAnswerAttempt: false,
      stalledRounds: 0,
      exhaustedSafetyFuse: false,
    }, session.activePlan, {
      canRequestUserInput: Boolean(options?.toolContext?.userInput?.requestUserInput),
      userInputDismissed: false,
    }, new Map()),
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
  const turnContextEntries: TurnContextEntry[] = baseMessages.map((message) => ({
    message,
    stepId: null,
    compressed: false,
  }));
  const canRequestUserInput = Boolean(options?.toolContext?.userInput?.requestUserInput);
  const tools = getAgentToolDefinitions(session.mode, options?.toolContext);
  let lastUsage: ProviderUsage | undefined;
  let userInputDismissed = false;
  let timeoutRetryCount = 0;
  let stalledToolCallRounds = 0;
  const seenToolCallSignatures = new Set<string>();
  const stepActivities = new Map<string, StepContextActivity>();
  const compressedStepSummaries = new Map<string, string>();

  for (let round = 0; round < MAX_TOTAL_TOOL_CALL_ROUNDS; round += 1) {
    throwIfAborted(options?.abortSignal);
    const exhaustedSafetyFuse = round === MAX_TOTAL_TOOL_CALL_ROUNDS - 1;
    const isFinalAnswerAttempt =
      exhaustedSafetyFuse ||
      stalledToolCallRounds >= MAX_STALLED_TOOL_CALL_ROUNDS;
    let response;
    while (true) {
      options?.onModelRequestStateChange?.(true);
      try {
        response = await chatOnce(
          buildRoundMessages(
            materializeTurnContextMessages(turnContextEntries),
            round,
            {
              isFinalAnswerAttempt,
              stalledRounds: stalledToolCallRounds,
              exhaustedSafetyFuse,
            },
            session.activePlan,
            {
              canRequestUserInput,
              userInputDismissed,
            },
            compressedStepSummaries,
          ),
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
            // Only disable tools once the loop is clearly stalled or the
            // emergency fuse is exhausted. Long read-only investigation chains
            // should be allowed to continue while they still make progress.
            ...(isFinalAnswerAttempt ? {} : { tools }),
          },
        );
        timeoutRetryCount = 0;
        break;
      } catch (error) {
        if (!isProviderRequestTimeout(error) || timeoutRetryCount >= MAX_MODEL_REQUEST_TIMEOUT_RETRIES) {
          throw error;
        }

        timeoutRetryCount += 1;
        appendTurnContextEntry(
          turnContextEntries,
          {
            role: "system",
            content: buildModelTimeoutRetryMessage(timeoutRetryCount, error),
          },
        );
      } finally {
        options?.onModelRequestStateChange?.(false);
      }
    }
    throwIfAborted(options?.abortSignal);
    if (response.usage) {
      lastUsage = response.usage;
    }

    if (response.toolCalls.length === 0) {
      if (!response.content) {
        throw new Error("Model returned empty content.");
      }

      const clarificationReplyKind =
        session.activePlan && !isTaskPlanResolved(session.activePlan) &&
          (canRequestUserInput || userInputDismissed)
          ? await classifyClarificationReply(
              response.content,
              {
                canRequestUserInput,
                userInputDismissed,
              },
              options,
            )
          : "other";

      if (session.activePlan && !isTaskPlanResolved(session.activePlan)) {
        if (canRequestUserInput && clarificationReplyKind === "clarifying_question") {
          if (isFinalAnswerAttempt) {
            throw new Error(
              "Use request_user_input for clarifying questions while the task plan is incomplete.",
            );
          }

          appendTurnContextEntry(
            turnContextEntries,
            {
              role: "assistant",
              content: response.content,
            },
          );
          appendTurnContextEntry(
            turnContextEntries,
            {
              role: "system",
              content: buildClarificationToolReminder(session.activePlan),
            },
          );
          continue;
        }

        if (userInputDismissed && clarificationReplyKind === "depends_on_user_input") {
          if (isFinalAnswerAttempt) {
            throw new Error(
              "The user declined the clarification request. Continue with reasonable assumptions or further inspection instead of ending the turn.",
            );
          }

          appendTurnContextEntry(
            turnContextEntries,
            {
              role: "assistant",
              content: response.content,
            },
          );
          appendTurnContextEntry(
            turnContextEntries,
            {
              role: "system",
              content: buildDismissedUserInputReminder(session.activePlan),
            },
          );
          continue;
        }
      }

      if (session.activePlan && !isTaskPlanResolved(session.activePlan)) {
        if (doesAssistantReportBlockedOutcomeStrict(response.content)) {
          session.activePlan = markRemainingPlanStepsBlocked(session.activePlan);
        } else {
          if (isFinalAnswerAttempt) {
            throw new Error(
              "Task plan is still incomplete. Mark the remaining steps completed or blocked before finishing the turn.",
            );
          }

          appendTurnContextEntry(
            turnContextEntries,
            {
              role: "assistant",
              content: response.content,
            },
          );
          appendTurnContextEntry(
            turnContextEntries,
            {
              role: "system",
              content: buildIncompletePlanReminder(
                session.activePlan,
                {
                  canRequestUserInput,
                  userInputDismissed,
                },
                inferIncompletePlanRetryReason(response.content),
              ),
            },
          );
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
      throw new AgentToolLoopLimitError(
        exhaustedSafetyFuse ? MAX_TOTAL_TOOL_CALL_ROUNDS : MAX_STALLED_TOOL_CALL_ROUNDS,
        exhaustedSafetyFuse ? "safety" : "stalled",
        stalledToolCallRounds,
      );
    }

    const outlinedUrlsAtRoundStart = buildOutlinedUrlSnapshot(session.webpageFetchCache);

    appendTurnContextEntry(
      turnContextEntries,
      {
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
        ...(response.reasoningContent
          ? { reasoningContent: response.reasoningContent }
          : {}),
      },
    );
    if (response.content && options?.onChunk) {
      options.onChunk(ensureAssistantChunkSpacing(response.content));
    }

    let roundMadeProgress = false;
    for (const toolCall of response.toolCalls) {
      throwIfAborted(options?.abortSignal);
      const activeStepIdBefore = session.activePlan
        ? getInProgressTaskPlanStep(session.activePlan)?.id ?? null
        : null;
      const toolExecution = await executeToolCallForAgentRound(
        toolCall,
        session.mode,
        session.activePlan,
        session.webpageFetchCache,
        outlinedUrlsAtRoundStart,
        options?.toolContext,
      );
      recordStepActivity(stepActivities, activeStepIdBefore, toolCall, toolExecution);
      appendTurnContextEntry(
        turnContextEntries,
        {
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: toolExecution.toolResult,
        },
        activeStepIdBefore,
      );
      if (toolExecution.userInputResponseKind === "dismissed") {
        userInputDismissed = true;
      } else if (toolExecution.userInputResponseKind) {
        userInputDismissed = false;
      }

      if (toolExecution.policyMessage) {
        appendTurnContextEntry(
          turnContextEntries,
          {
            role: "system",
            content: toolExecution.policyMessage,
          },
          activeStepIdBefore,
        );
      }

      if (didToolCallMakeProgress(toolCall, toolExecution, seenToolCallSignatures)) {
        roundMadeProgress = true;
      }

      compressResolvedStepContext(
        session.activePlan,
        activeStepIdBefore,
        stepActivities,
        turnContextEntries,
        compressedStepSummaries,
      );
    }

    stalledToolCallRounds = roundMadeProgress
      ? 0
      : stalledToolCallRounds + 1;
  }

  throw new AgentToolLoopLimitError(MAX_TOTAL_TOOL_CALL_ROUNDS, "safety", stalledToolCallRounds);
}

type ToolExecutionOutcome = {
  toolResult: string;
  policyMessage?: string;
  userInputResponseKind?: UserInputResponse["kind"];
  madeProgress?: boolean;
};

type TurnContextEntry = {
  message: ChatMessage;
  stepId: string | null;
  compressed: boolean;
};

type StepContextActivity = {
  observations: string[];
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
      madeProgress: false,
    };
  }

  if (toolCall.name !== FETCH_WEBPAGE_TOOL_NAME) {
    const toolResult = await executeAgentTool(toolCall, mode, toolContext);
    if (toolCall.name === "request_user_input") {
      return buildUserInputToolOutcome(toolResult);
    }

    return {
      toolResult,
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
    madeProgress: true,
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
  loopState: {
    isFinalAnswerAttempt: boolean;
    stalledRounds: number;
    exhaustedSafetyFuse: boolean;
  },
  activePlan: TaskPlan | null,
  guidance: RoundPromptGuidance,
  compressedStepSummaries: ReadonlyMap<string, string>,
): ChatMessage[] {
  const planMessage = buildActivePlanSystemMessage(
    activePlan,
    guidance,
    compressedStepSummaries,
  );
  const warning = buildToolLoopWarning(round, loopState);
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

function materializeTurnContextMessages(
  entries: TurnContextEntry[],
): ChatMessage[] {
  const visible = entries
    .filter((entry) => !entry.compressed)
    .map((entry) => entry.message);

  // Collect tool_call_ids that still have a matching tool-result message
  // so we can strip orphaned toolCalls from assistant messages whose tool
  // results were compressed away (the API rejects orphaned tool_call_ids).
  const presentToolResultIds = new Set<string>();
  for (const message of visible) {
    if (message.role === "tool") {
      presentToolResultIds.add(message.toolCallId);
    }
  }

  return visible.map((message) => {
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      return message;
    }
    const kept = message.toolCalls.filter((tc) => presentToolResultIds.has(tc.id));
    if (kept.length === message.toolCalls.length) {
      return message; // nothing stripped — return original
    }
    // Shallow-copy so we don't mutate the TurnContextEntry's message.
    const { toolCalls: _dropped, ...rest } = message;
    return kept.length
      ? { ...rest, toolCalls: kept }
      : rest as ChatMessage;
  });
}

function appendTurnContextEntry(
  entries: TurnContextEntry[],
  message: ChatMessage,
  stepId: string | null = null,
): void {
  entries.push({
    message,
    stepId,
    compressed: false,
  });
}

function recordStepActivity(
  stepActivities: Map<string, StepContextActivity>,
  stepId: string | null,
  toolCall: ToolCall,
  toolExecution: ToolExecutionOutcome,
): void {
  if (!stepId || toolCall.name === PLAN_UPDATE_TOOL_NAME) {
    return;
  }

  const observation = buildToolContextObservation(toolCall, toolExecution);
  if (!observation) {
    return;
  }

  const current = stepActivities.get(stepId) ?? { observations: [] };
  if (!current.observations.includes(observation)) {
    current.observations.push(observation);
  }
  stepActivities.set(stepId, current);
}

function compressResolvedStepContext(
  activePlan: TaskPlan | null,
  stepId: string | null,
  stepActivities: Map<string, StepContextActivity>,
  turnContextEntries: TurnContextEntry[],
  compressedStepSummaries: Map<string, string>,
): void {
  if (!activePlan || !stepId || compressedStepSummaries.has(stepId)) {
    return;
  }

  const step = activePlan.steps.find((candidate) => candidate.id === stepId);
  if (!step || (step.status !== "completed" && step.status !== "blocked")) {
    return;
  }

  compressedStepSummaries.set(
    stepId,
    buildCompletedStepContextSummary(step, stepActivities.get(stepId)),
  );

  for (const entry of turnContextEntries) {
    if (entry.stepId !== stepId) {
      continue;
    }

    if (entry.message.role === "tool" || entry.message.role === "system") {
      entry.compressed = true;
    }
  }
}

function buildToolLoopWarning(
  round: number,
  loopState: {
    isFinalAnswerAttempt: boolean;
    stalledRounds: number;
    exhaustedSafetyFuse: boolean;
  },
): string | null {
  if (loopState.isFinalAnswerAttempt) {
    if (loopState.exhaustedSafetyFuse) {
      return `You have already used ${MAX_TOTAL_TOOL_CALL_ROUNDS} tool rounds on this turn. Do not call more tools. Respond with the best answer you can from the information already gathered, explain any remaining uncertainty, and ask for a narrower target instead of continuing an unbounded search.`;
    }

    return `The last ${loopState.stalledRounds} tool rounds did not add enough new progress. Do not call more tools. Respond with the best answer you can from the information already gathered. If the results were blocked, repetitive, or still insufficient, say that plainly and ask the user for a narrower target or a specific file.`;
  }

  if (round < TOOL_LOOP_WARNING_AFTER_ROUND && loopState.stalledRounds === 0) {
    return null;
  }

  const warnings = [
    `You have already used ${round} tool rounds on this turn.`,
  ];
  if (loopState.stalledRounds > 0) {
    warnings.push(`The last ${loopState.stalledRounds} round${loopState.stalledRounds === 1 ? "" : "s"} did not add enough new progress.`);
  }
  warnings.push(
    "Only call another tool if it reads a new target, updates the plan, asks a focused clarification, applies a change, or verifies the result.",
    "Avoid repeating the same scans or rereading the same target without a concrete reason.",
  );
  return warnings.join(" ");
}

function didToolCallMakeProgress(
  toolCall: ToolCall,
  toolExecution: ToolExecutionOutcome,
  seenToolCallSignatures: Set<string>,
): boolean {
  const signature = buildToolCallSignature(toolCall);
  const isNovelSignature = !seenToolCallSignatures.has(signature);
  seenToolCallSignatures.add(signature);

  if (toolExecution.madeProgress !== undefined) {
    return toolExecution.madeProgress;
  }

  if (toolExecution.policyMessage) {
    return false;
  }

  if (WORKSPACE_MUTATION_TOOL_NAMES.has(toolCall.name)) {
    return true;
  }

  return isNovelSignature;
}

function buildToolCallSignature(toolCall: ToolCall): string {
  return `${toolCall.name}:${normalizeToolCallArguments(toolCall.arguments)}`;
}

function normalizeToolCallArguments(argumentsText: string): string {
  const normalized = argumentsText.trim();
  if (!normalized) {
    return "";
  }

  try {
    return stableSerializeValue(JSON.parse(normalized));
  } catch {
    return normalized.replace(/\s+/g, " ");
  }
}

function stableSerializeValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerializeValue(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerializeValue(entryValue)}`);
  return `{${entries.join(",")}}`;
}

function buildCompletedStepContextSummary(
  step: TaskPlan["steps"][number],
  activity: StepContextActivity | undefined,
): string {
  const summarizedActions = summarizeStepContextObservations(activity?.observations ?? []);
  if (summarizedActions) {
    return truncateContextSummary(summarizedActions, 280);
  }

  if (step.note) {
    return truncateContextSummary(step.note, 280);
  }

  return truncateContextSummary(
    step.status === "blocked"
      ? "Step blocked; detailed tool output was compressed."
      : "Step completed; detailed tool output was compressed.",
    280,
  );
}

function summarizeStepContextObservations(observations: string[]): string {
  if (observations.length === 0) {
    return "";
  }

  const visibleObservations = observations.slice(0, 3);
  const suffix = observations.length > visibleObservations.length
    ? `; ${observations.length - visibleObservations.length} more action${observations.length - visibleObservations.length === 1 ? "" : "s"}`
    : "";
  return `Actions: ${visibleObservations.join("; ")}${suffix}.`;
}

function buildToolContextObservation(
  toolCall: ToolCall,
  toolExecution: ToolExecutionOutcome,
): string {
  const parsedArgs = tryParseJsonRecord(toolCall.arguments);
  const parsedResult = tryParseJsonRecord(toolExecution.toolResult);

  switch (toolCall.name) {
    case "read_file": {
      const path = getStringProperty(parsedResult, "path") ?? getStringProperty(parsedArgs, "path");
      const startLine = getNumberProperty(parsedResult, "startLine") ?? getNumberProperty(parsedArgs, "start_line");
      const endLine = getNumberProperty(parsedResult, "endLine") ?? getNumberProperty(parsedArgs, "end_line");
      const range = startLine !== null && endLine !== null
        ? ` lines ${startLine}-${endLine}`
        : "";
      return truncateContextSummary(`read ${path ?? "a file"}${range}`, 120);
    }
    case "search_workspace": {
      const pattern = getStringProperty(parsedArgs, "pattern");
      const path = getStringProperty(parsedResult, "path") ?? getStringProperty(parsedArgs, "path") ?? ".";
      const matchCount = getArrayLength(parsedResult, "matches");
      const matchSuffix = matchCount !== null ? ` (${matchCount} matches)` : "";
      return truncateContextSummary(
        `searched ${path} for ${quoteContextValue(pattern)}${matchSuffix}`,
        120,
      );
    }
    case "list_files": {
      const path = getStringProperty(parsedResult, "path") ?? getStringProperty(parsedArgs, "path") ?? ".";
      const depth = getNumberProperty(parsedResult, "depth") ?? getNumberProperty(parsedArgs, "depth");
      const entryCount = getArrayLength(parsedResult, "entries");
      const detail = [
        depth !== null ? `depth ${depth}` : null,
        entryCount !== null ? `${entryCount} entries` : null,
      ].filter(Boolean).join(", ");
      return truncateContextSummary(
        `listed ${path}${detail ? ` (${detail})` : ""}`,
        120,
      );
    }
    case "run_command": {
      const command = getStringProperty(parsedArgs, "command");
      const exitCode = getNumberProperty(parsedResult, "exitCode");
      const timedOut = getBooleanProperty(parsedResult, "timedOut");
      const outcome = timedOut
        ? "timed out"
        : exitCode !== null
          ? `exit ${exitCode}`
          : "ran";
      return truncateContextSummary(
        `ran ${quoteContextValue(command, 80)} (${outcome})`,
        120,
      );
    }
    case "fetch_webpage": {
      const url = getStringProperty(parsedArgs, "url");
      const mode = getStringProperty(parsedArgs, "mode") ?? "outline";
      return truncateContextSummary(
        `fetched ${mode} for ${quoteContextValue(url, 80)}`,
        120,
      );
    }
    case "request_user_input":
      return "asked a focused clarification question";
    default: {
      const argumentPreview = formatToolArgumentPreview(parsedArgs);
      return truncateContextSummary(
        argumentPreview
          ? `${toolCall.name} ${argumentPreview}`
          : toolCall.name,
        120,
      );
    }
  }
}

function formatToolArgumentPreview(
  value: Record<string, unknown> | null,
): string {
  if (!value) {
    return "";
  }

  const entries = Object.entries(value)
    .filter(([, entryValue]) =>
      typeof entryValue === "string" ||
      typeof entryValue === "number" ||
      typeof entryValue === "boolean"
    )
    .slice(0, 3)
    .map(([key, entryValue]) =>
      `${key}=${typeof entryValue === "string" ? quoteContextValue(entryValue, 48) : String(entryValue)}`
    );
  return entries.join(" ");
}

function truncateContextSummary(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(1, maxLength - 3))}...`;
}

function quoteContextValue(value: string | null | undefined, maxLength = 60): string {
  if (!value) {
    return '"?"';
  }

  return `"${truncateContextSummary(value, maxLength)}"`;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function getStringProperty(
  value: Record<string, unknown> | null,
  key: string,
): string | null {
  return value && typeof value[key] === "string"
    ? value[key] as string
    : null;
}

function getNumberProperty(
  value: Record<string, unknown> | null,
  key: string,
): number | null {
  return value && typeof value[key] === "number"
    ? value[key] as number
    : null;
}

function getBooleanProperty(
  value: Record<string, unknown> | null,
  key: string,
): boolean | null {
  return value && typeof value[key] === "boolean"
    ? value[key] as boolean
    : null;
}

function getArrayLength(
  value: Record<string, unknown> | null,
  key: string,
): number | null {
  return value && Array.isArray(value[key])
    ? (value[key] as unknown[]).length
    : null;
}

function buildActivePlanSystemMessage(
  activePlan: TaskPlan | null,
  guidance: RoundPromptGuidance,
  compressedStepSummaries: ReadonlyMap<string, string>,
): string | null {
  if (!activePlan) {
    return null;
  }

  const currentStep = getInProgressTaskPlanStep(activePlan);
  const lines = [
    `Active task plan: ${activePlan.title}`,
    "Before using any tool other than update_plan, mark exactly one relevant plan step as in_progress with update_plan.",
    "After finishing a step, mark it completed or blocked with update_plan.",
    "While the task plan is unresolved, do not reply with prose-only progress updates. Your next response must include the tool calls needed to advance the current step or resolve the plan.",
    "Do not claim that edits succeeded unless the workspace was actually changed and later verification passes.",
    `Current in-progress step: ${currentStep ? `${currentStep.id} ${currentStep.title}` : "none"}`,
    "Plan steps:",
    ...activePlan.steps.map((step) => {
      const stepDetails: string[] = [];
      if (step.note) {
        stepDetails.push(`note: ${step.note}`);
      }
      const compressedSummary = compressedStepSummaries.get(step.id);
      if (compressedSummary && compressedSummary !== step.note) {
        stepDetails.push(`summary: ${compressedSummary}`);
      }

      return `- ${step.id} [${step.status}] ${step.title}${stepDetails.length > 0 ? ` ${stepDetails.join(" ")}` : ""}`;
    }),
  ];

  if (guidance.canRequestUserInput) {
    lines.push(
      "If a material ambiguity blocks progress, call request_user_input instead of asking the user in plain text.",
      "Ask one focused clarification question per tool call and only ask follow-up questions when they are distinct and necessary.",
    );
  }

  if (guidance.userInputDismissed) {
    lines.push(
      "The user already declined a clarification request in this turn. Do not end or mark the task blocked solely because of that refusal.",
      "Continue with repository inspection, reasonable assumptions, or another narrow approach instead of repeating the same question.",
    );
  }

  return lines.join("\n");
}

function buildIncompletePlanReminder(
  activePlan: TaskPlan,
  guidance: RoundPromptGuidance,
  retryReason: string | null = null,
): string {
  const reminderParts = [
    "The task plan is still incomplete, so you may not finish this turn yet.",
    hasTaskPlanProgress(activePlan)
      ? "Call update_plan to keep the plan accurate, then continue the remaining work."
      : "No step is in progress yet. Call update_plan first to mark the relevant step as in_progress, then continue the work.",
    "Your next response must contain the tool calls needed to advance the plan, not a prose-only status update.",
  ];

  if (retryReason) {
    reminderParts.push(`Retry reason: ${retryReason}`);
  }

  if (guidance.canRequestUserInput) {
    reminderParts.push(
      "If you need clarification, call request_user_input instead of asking the user in plain text.",
    );
  }

  if (guidance.userInputDismissed) {
    reminderParts.push(
      "The user already declined a clarification request, so continue with reasonable assumptions or further inspection instead of ending here.",
    );
  }

  const remainingSteps = formatRemainingPlanSteps(activePlan);
  return [
    ...reminderParts,
    remainingSteps
      ? `Remaining steps: ${remainingSteps}`
      : "All remaining steps must be explicitly marked blocked before you finish.",
  ].join(" ");
}

function inferIncompletePlanRetryReason(content: string): string | null {
  const normalized = content.trim();
  if (!normalized) {
    return "The previous reply tried to finish the turn without resolving the remaining plan steps.";
  }

  if (/<function_calls\b|<invoke\b|<parameter\b/i.test(normalized)) {
    return "The previous reply wrote a tool call into plain text instead of emitting a real tool call.";
  }

  if (doesAssistantAskClarifyingQuestionStrict(normalized)) {
    return "The previous reply asked the user in plain text instead of using request_user_input.";
  }

  if (/tool call|run_command|read_file|search_workspace|update_plan/i.test(normalized)) {
    return "The previous reply described the next action in prose instead of actually calling the tool.";
  }

  return "The previous reply attempted to finish before the remaining plan steps were completed or blocked.";
}

function buildClarificationToolReminder(
  activePlan: TaskPlan,
): string {
  const remainingSteps = formatRemainingPlanSteps(activePlan);
  return [
    "The task plan is still incomplete.",
    "If you need clarification, call request_user_input instead of asking the user in plain text.",
    "Ask one focused question at a time with 2-3 concise options, then continue the work.",
    remainingSteps
      ? `Remaining steps: ${remainingSteps}.`
      : "Update the remaining steps explicitly before finishing.",
  ].join(" ");
}

function buildDismissedUserInputReminder(
  activePlan: TaskPlan,
): string {
  const remainingSteps = formatRemainingPlanSteps(activePlan);
  return [
    "The user declined that clarification request.",
    "Do not end or mark the task blocked solely because of that refusal.",
    "Continue with repository inspection, reasonable assumptions, or another narrow approach instead.",
    remainingSteps
      ? `Remaining steps: ${remainingSteps}.`
      : "Update the remaining steps explicitly before finishing.",
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

async function classifyClarificationReply(
  content: string,
  guidance: RoundPromptGuidance,
  options?: AgentTurnOptions,
): Promise<ClarificationReplyKind> {
  const normalized = content.trim();
  if (!normalized) {
    return "other";
  }

  const fallbackKind = inferClarificationReplyKindFallback(content, guidance);
  options?.onModelRequestStateChange?.(true);
  try {
    const response = await chatOnce(
      [
        {
          role: "system",
          content: [
            "You classify a draft assistant reply for an agent runtime.",
            'Return JSON only with this exact shape: {"kind":"clarifying_question"|"depends_on_user_input"|"other"}.',
            "Use clarifying_question when the draft directly asks the user to answer, identify, choose, confirm, or locate something and it should have used request_user_input instead of plain text.",
            "Use depends_on_user_input when the draft says it cannot continue or finish because the user did not answer or because more user input is needed.",
            "Use other for everything else.",
            "Do not explain your reasoning.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `request_user_input_available: ${guidance.canRequestUserInput ? "true" : "false"}`,
            `user_input_dismissed_this_turn: ${guidance.userInputDismissed ? "true" : "false"}`,
            "draft_reply:",
            normalized,
          ].join("\n"),
        },
      ],
      {
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.providerConfig
          ? { providerConfig: options.providerConfig }
          : {}),
        ...(options?.abortSignal
          ? { abortSignal: options.abortSignal }
          : {}),
        temperature: 0,
      },
    );
    return parseClarificationReplyKind(response.content) ?? fallbackKind;
  } catch {
    return fallbackKind;
  } finally {
    options?.onModelRequestStateChange?.(false);
  }
}

function parseClarificationReplyKind(content: string): ClarificationReplyKind | null {
  try {
    const normalized = content.trim();
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }

    const parsed = JSON.parse(normalized.slice(start, end + 1)) as { kind?: unknown };
    return parsed.kind === "clarifying_question" ||
        parsed.kind === "depends_on_user_input" ||
        parsed.kind === "other"
      ? parsed.kind
      : null;
  } catch {
    return null;
  }
}

function inferClarificationReplyKindFallback(
  content: string,
  guidance: RoundPromptGuidance,
): ClarificationReplyKind {
  if (guidance.canRequestUserInput && doesAssistantAskClarifyingQuestionStrict(content)) {
    return "clarifying_question";
  }

  if (guidance.userInputDismissed && doesAssistantDependOnUserInputStrict(content)) {
    return "depends_on_user_input";
  }

  return "other";
}

function doesAssistantAskClarifyingQuestionStrict(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) {
    return false;
  }

  const hasClarifyingLanguage =
    /(?:can you|could you|would you|do you want|should i|please tell me|help me find|what is the name|which file|which function|which command|where is|\u80fd\u5426|\u8bf7\u95ee|\u4f60\u80fd|\u60a8\u80fd|\u544a\u8bc9\u6211|\u5e2e\u6211\u786e\u8ba4|\u5e2e\u6211\u627e\u5230|\u4e3b\u51fd\u6570\u540d\u662f\u4ec0\u4e48|\u54ea\u4e2a\u6587\u4ef6|\u54ea\u4e2a\u51fd\u6570|\u54ea\u4e2a\u547d\u4ee4|\u5728\u54ea\u91cc)/i
      .test(normalized);
  const hasQuestionSignal =
    /[?\uFF1F]/.test(normalized) || /\b(?:which|what|where|when|who|why|how)\b/i.test(normalized);
  return hasClarifyingLanguage && hasQuestionSignal;
}

function doesAssistantDependOnUserInputStrict(content: string): boolean {
  return /(?:need(?:s)? (?:more )?(?:user|your) (?:input|answer|reply|response)|cannot continue without (?:user|your) (?:input|answer|reply|response)|can't continue without (?:user|your) (?:input|answer|reply|response)|requires clarification from you|\u9700\u8981(?:\u4f60\u7684)?(?:\u8f93\u5165|\u56de\u7b54|\u56de\u590d|\u786e\u8ba4)|\u6ca1\u6709(?:\u4f60\u7684)?(?:\u8f93\u5165|\u56de\u7b54|\u56de\u590d|\u786e\u8ba4)\u5c31\u65e0\u6cd5\u7ee7\u7eed|\u65e0\u6cd5\u5728\u6ca1\u6709(?:\u4f60\u7684)?(?:\u8f93\u5165|\u56de\u7b54|\u56de\u590d|\u786e\u8ba4)\u7684\u60c5\u51b5\u4e0b\u7ee7\u7eed)/i
    .test(content);
}

function doesAssistantReportBlockedOutcomeStrict(content: string): boolean {
  if (doesAssistantDependOnUserInputStrict(content)) {
    return false;
  }

  return /(?:pending interactive approval|requires approval|waiting for approval|permission denied|access denied|blocked by policy|command was blocked|workspace edit approval|sandbox denied|read-only environment|missing credentials|authentication required|\u9700\u8981\u5ba1\u6279|\u7b49\u5f85\u5ba1\u6279|\u6743\u9650\u4e0d\u8db3)/i
    .test(content);
}

function doesAssistantAskClarifyingQuestion(content: string): boolean {
  return doesAssistantAskClarifyingQuestionStrict(content);
}

function doesAssistantDependOnUserInput(content: string): boolean {
  return doesAssistantDependOnUserInputStrict(content);
}

function doesAssistantReportBlockedOutcome(content: string): boolean {
  return doesAssistantReportBlockedOutcomeStrict(content);
}

function buildUserInputToolOutcome(toolResult: string): ToolExecutionOutcome {
  const userInputResponseKind = parseUserInputResponseKind(toolResult);
  if (userInputResponseKind !== "dismissed") {
    return userInputResponseKind
      ? { toolResult, userInputResponseKind }
      : { toolResult };
  }

  return {
    toolResult,
    userInputResponseKind,
    policyMessage:
      "The user declined that clarification request. Continue with repository inspection, reasonable assumptions, or another narrow approach instead of ending the task solely because the user refused to answer.",
  };
}

function parseUserInputResponseKind(
  toolResult: string,
): UserInputResponse["kind"] | undefined {
  try {
    const parsed = JSON.parse(toolResult) as {
      ok?: boolean;
      response?: { kind?: unknown };
    };
    if (!parsed.ok) {
      return undefined;
    }

    const kind = parsed.response?.kind;
    return kind === "option" || kind === "custom" || kind === "dismissed"
      ? kind
      : undefined;
  } catch {
    return undefined;
  }
}

function formatRemainingPlanSteps(activePlan: TaskPlan): string {
  return activePlan.steps
    .filter((step) => step.status === "pending" || step.status === "in_progress")
    .map((step) => `${step.id} ${step.title}`)
    .join("; ");
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

function buildRuntimeEnvironmentMessage(): string {
  const shell = getPlatformShellCommand("__superrun_environment_probe__");
  const shellLabel = process.platform === "win32"
    ? "PowerShell"
    : basename(shell.file || "sh");
  const shellCommand = [shell.file, ...shell.args.slice(0, -1)].join(" ");
  const platformLabel = describePlatform(process.platform);
  const syntaxHint = process.platform === "win32"
    ? "Use Windows and PowerShell command syntax by default. Do not assume bash, grep, ls, find, or head are available unless you explicitly invoke a compatible shell."
    : "Use POSIX shell syntax by default unless you explicitly invoke a different shell.";

  return [
    "Runtime environment:",
    `- platform: ${platformLabel} (${process.platform})`,
    `- run_command shell: ${shellLabel} via ${shellCommand}`,
    `- workspace root: ${process.cwd()}`,
    `- guidance: ${syntaxHint}`,
  ].join("\n");
}

function describePlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

function isProviderRequestTimeout(error: unknown): error is Error {
  return error instanceof Error &&
    /Request timed out after \d+ms\./.test(error.message);
}

function buildModelTimeoutRetryMessage(
  retryCount: number,
  error: Error,
): string {
  return [
    `The previous provider request timed out (${error.message}).`,
    `Retry ${retryCount} of ${MAX_MODEL_REQUEST_TIMEOUT_RETRIES}: continue from the current conversation state instead of restarting the task.`,
    "Do not repeat finished work just because the previous request timed out.",
  ].join(" ");
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
