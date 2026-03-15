import type { ChatMessage } from "../llm/types.js";
import type { ProviderUsage } from "../llm/provider.js";

const SAFE_CONTEXT_RATIO = 0.9;
const MIN_CONTEXT_TOKEN_OVERHEAD = 12;

export type ContextUsageSource = "response" | "estimate";

export type ContextBudgetSnapshot = {
  modelContextTokens: number | null;
  configuredContextLimitTokens: number | null;
  effectiveContextLimitTokens: number | null;
  lastPromptTokens: number | null;
  lastTotalTokens: number | null;
  estimatedPromptTokens: number | null;
  usageSource: ContextUsageSource | null;
};

export function createEmptyContextBudgetSnapshot(): ContextBudgetSnapshot {
  return {
    modelContextTokens: null,
    configuredContextLimitTokens: null,
    effectiveContextLimitTokens: null,
    lastPromptTokens: null,
    lastTotalTokens: null,
    estimatedPromptTokens: null,
    usageSource: null,
  };
}

export function estimateChatMessageTokens(messages: ChatMessage[]): number {
  let total = 0;

  for (const message of messages) {
    total += MIN_CONTEXT_TOKEN_OVERHEAD;
    total += estimateTextTokens(message.content);

    if (message.role === "assistant" && message.reasoningContent) {
      total += estimateTextTokens(message.reasoningContent);
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const toolCall of message.toolCalls) {
        total += estimateTextTokens(toolCall.name);
        total += estimateTextTokens(toolCall.arguments);
      }
    }

    if (message.role === "tool") {
      total += estimateTextTokens(message.toolName);
      total += estimateTextTokens(message.toolCallId);
    }
  }

  return Math.max(MIN_CONTEXT_TOKEN_OVERHEAD, total);
}

export function estimateTextTokens(value: string): number {
  if (!value.trim()) {
    return 0;
  }

  // Keep this lightweight and deterministic for UI and trim heuristics.
  return Math.ceil(value.length / 4);
}

export function resolveEffectiveContextLimitTokens(options: {
  configuredContextLimitTokens?: number | undefined;
  modelContextTokens?: number | null | undefined;
}): number | null {
  if (typeof options.configuredContextLimitTokens === "number") {
    return options.configuredContextLimitTokens;
  }

  return typeof options.modelContextTokens === "number"
    ? options.modelContextTokens
    : null;
}

export function getSafeContextBudgetTokens(
  effectiveContextLimitTokens: number | null,
): number | null {
  if (effectiveContextLimitTokens === null) {
    return null;
  }

  return Math.max(1, Math.floor(effectiveContextLimitTokens * SAFE_CONTEXT_RATIO));
}

export function buildContextBudgetSnapshot(options: {
  modelContextTokens?: number | null | undefined;
  configuredContextLimitTokens?: number | undefined;
  usage?: ProviderUsage | undefined;
  estimatedPromptTokens: number | null;
}): ContextBudgetSnapshot {
  const effectiveContextLimitTokens = resolveEffectiveContextLimitTokens(
    options.configuredContextLimitTokens !== undefined
      ? {
          configuredContextLimitTokens: options.configuredContextLimitTokens,
          modelContextTokens: options.modelContextTokens,
        }
      : {
          modelContextTokens: options.modelContextTokens,
        },
  );

  return {
    modelContextTokens: options.modelContextTokens ?? null,
    configuredContextLimitTokens: options.configuredContextLimitTokens ?? null,
    effectiveContextLimitTokens,
    lastPromptTokens: options.usage?.promptTokens ?? null,
    lastTotalTokens: options.usage?.totalTokens ?? null,
    estimatedPromptTokens: options.estimatedPromptTokens,
    usageSource: options.usage?.promptTokens !== null && options.usage?.promptTokens !== undefined
      ? options.usage.source
      : options.estimatedPromptTokens !== null
        ? "estimate"
        : null,
  };
}
