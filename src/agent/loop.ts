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
// Coding-oriented models often need several inspect/edit/verify rounds before
// they can finish naturally, so keep a guardrail without forcing tiny loops.
const MAX_TOOL_CALL_ROUNDS = 8;
const TOOL_LOOP_WARNING_AFTER_ROUND = 4;
const MAX_MODEL_REQUEST_TIMEOUT_RETRIES = 6;

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
    buildRoundMessages(baseMessages, 0, false, session.activePlan, {
      canRequestUserInput: Boolean(options?.toolContext?.userInput?.requestUserInput),
      userInputDismissed: false,
    }),
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
  const canRequestUserInput = Boolean(options?.toolContext?.userInput?.requestUserInput);
  const tools = getAgentToolDefinitions(session.mode, options?.toolContext);
  let lastUsage: ProviderUsage | undefined;
  let userInputDismissed = false;
  let timeoutRetryCount = 0;

  for (let round = 0; round <= MAX_TOOL_CALL_ROUNDS; round += 1) {
    throwIfAborted(options?.abortSignal);
    const isFinalAnswerAttempt = round === MAX_TOOL_CALL_ROUNDS;
    let response;
    while (true) {
      options?.onModelRequestStateChange?.(true);
      try {
        response = await chatOnce(
          buildRoundMessages(messages, round, isFinalAnswerAttempt, session.activePlan, {
            canRequestUserInput,
            userInputDismissed,
          }),
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
        );
        timeoutRetryCount = 0;
        break;
      } catch (error) {
        if (!isProviderRequestTimeout(error) || timeoutRetryCount >= MAX_MODEL_REQUEST_TIMEOUT_RETRIES) {
          throw error;
        }

        timeoutRetryCount += 1;
        messages.push({
          role: "system",
          content: buildModelTimeoutRetryMessage(timeoutRetryCount, error),
        });
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

          messages.push({
            role: "assistant",
            content: response.content,
          });
          messages.push({
            role: "system",
            content: buildClarificationToolReminder(session.activePlan),
          });
          continue;
        }

        if (userInputDismissed && clarificationReplyKind === "depends_on_user_input") {
          if (isFinalAnswerAttempt) {
            throw new Error(
              "The user declined the clarification request. Continue with reasonable assumptions or further inspection instead of ending the turn.",
            );
          }

          messages.push({
            role: "assistant",
            content: response.content,
          });
          messages.push({
            role: "system",
            content: buildDismissedUserInputReminder(session.activePlan),
          });
          continue;
        }
      }

      if (session.activePlan && hasTaskPlanProgress(session.activePlan) && !isTaskPlanResolved(session.activePlan)) {
        if (doesAssistantReportBlockedOutcomeStrict(response.content)) {
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
            content: buildIncompletePlanReminder(session.activePlan, {
              canRequestUserInput,
              userInputDismissed,
            }),
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
      if (toolExecution.userInputResponseKind === "dismissed") {
        userInputDismissed = true;
      } else if (toolExecution.userInputResponseKind) {
        userInputDismissed = false;
      }

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
  userInputResponseKind?: UserInputResponse["kind"];
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
  guidance: RoundPromptGuidance,
): ChatMessage[] {
  const planMessage = buildActivePlanSystemMessage(activePlan, guidance);
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
  guidance: RoundPromptGuidance,
): string | null {
  if (!activePlan) {
    return null;
  }

  const currentStep = getInProgressTaskPlanStep(activePlan);
  const lines = [
    `Active task plan: ${activePlan.title}`,
    "Before using any tool other than update_plan, mark exactly one relevant plan step as in_progress with update_plan.",
    "After finishing a step, mark it completed or blocked with update_plan.",
    "Do not claim that edits succeeded unless the workspace was actually changed and later verification passes.",
    `Current in-progress step: ${currentStep ? `${currentStep.id} ${currentStep.title}` : "none"}`,
    "Plan steps:",
    ...activePlan.steps.map((step) =>
      `- ${step.id} [${step.status}] ${step.title}${step.note ? ` note: ${step.note}` : ""}`,
    ),
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
): string {
  const reminderParts = [
    "The task plan is still incomplete, so you may not finish this turn yet.",
    "Call update_plan to keep the plan accurate, then continue the remaining work.",
  ];

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
