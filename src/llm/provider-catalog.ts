import { buildProviderDispatcher } from "./http.js";
import type { ProviderId, ProviderRuntimeConfig } from "./provider.js";

export type ProviderCatalogModel = {
  id: string;
  contextTokens: number | null;
  contextSource: "response" | "registry" | "unknown";
};

export type ProviderCatalogEntry = {
  status: "idle" | "ready" | "error";
  models: ProviderCatalogModel[];
  errorMessage: string | null;
  fetchedAt: string | null;
};

export type ProviderCatalogState = Record<ProviderId, ProviderCatalogEntry>;

export type ProviderCatalogRefreshFeedback = {
  level: "info" | "warning";
  message: string;
};

type ModelListResponse = {
  data?: unknown;
  error?: {
    message?: string;
  };
};

const EMPTY_ENTRY: ProviderCatalogEntry = {
  status: "idle",
  models: [],
  errorMessage: null,
  fetchedAt: null,
};

const KIMI_MODEL_CONTEXT_REGISTRY = new Map<string, number>([
  ["kimi-latest", 256_000],
  ["kimi-thinking-preview", 256_000],
  ["kimi-k2-0711-preview", 256_000],
  ["kimi-k2-turbo-preview", 256_000],
  ["moonshot-v1-8k", 8_192],
  ["moonshot-v1-32k", 32_768],
  ["moonshot-v1-128k", 131_072],
]);

export function createProviderCatalogState(): ProviderCatalogState {
  return {
    openai_compatible: { ...EMPTY_ENTRY },
    kimi: { ...EMPTY_ENTRY },
  };
}

export async function refreshProviderCatalog(
  provider: ProviderRuntimeConfig,
): Promise<ProviderCatalogEntry> {
  if (provider.id !== "kimi") {
    return { ...EMPTY_ENTRY };
  }

  if (!provider.apiKey) {
    return {
      status: "error",
      models: [],
      errorMessage: `Missing API key for ${provider.label}.`,
      fetchedAt: new Date().toISOString(),
    };
  }

  const url = new URL("models", `${provider.baseURL}/`);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${provider.timeoutMs}ms.`));
  }, provider.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      // @ts-expect-error undici dispatcher is not in the standard fetch types
      dispatcher: buildProviderDispatcher(),
    });
    const body = await response.text();

    let payload: ModelListResponse;
    try {
      payload = JSON.parse(body) as ModelListResponse;
    } catch {
      return {
        status: "error",
        models: [],
        errorMessage: "Provider returned a non-JSON model list response.",
        fetchedAt: new Date().toISOString(),
      };
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        status: "error",
        models: [],
        errorMessage:
          payload.error?.message ||
          `Model list request failed with status ${response.status}.`,
        fetchedAt: new Date().toISOString(),
      };
    }

    const models = parseProviderCatalogModels(payload.data);
    return {
      status: "ready",
      models,
      errorMessage: null,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      models: [],
      errorMessage: `Failed to load models: ${message}`,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function attachProviderCatalogMetadata(
  provider: ProviderRuntimeConfig,
  catalog: ProviderCatalogState,
): ProviderRuntimeConfig {
  if (provider.id !== "kimi") {
    return provider;
  }

  const matchingModel = catalog.kimi.models.find((model) => model.id === provider.model);
  if (matchingModel) {
    return {
      ...provider,
      modelContextTokens: matchingModel.contextTokens,
      modelContextSource:
        matchingModel.contextSource === "response"
          ? "catalog"
          : matchingModel.contextSource,
    };
  }

  const registryContextTokens = getKimiRegistryContextTokens(provider.model);
  return {
    ...provider,
    modelContextTokens: registryContextTokens,
    modelContextSource: registryContextTokens === null ? "unknown" : "registry",
  };
}

export function describeProviderCatalogStatus(
  provider: ProviderRuntimeConfig,
  catalog: ProviderCatalogState,
): string {
  if (provider.id !== "kimi") {
    return "model catalog unavailable for this provider";
  }

  const entry = catalog.kimi;
  if (entry.status === "ready") {
    return `${entry.models.length} model${entry.models.length === 1 ? "" : "s"} loaded`;
  }

  if (entry.status === "error") {
    return entry.errorMessage ?? "catalog unavailable";
  }

  return "catalog not loaded yet";
}

export function summarizeProviderCatalogRefresh(
  provider: ProviderRuntimeConfig,
  entry: ProviderCatalogEntry,
): ProviderCatalogRefreshFeedback | null {
  if (provider.id !== "kimi") {
    return null;
  }

  if (entry.status === "error") {
    return {
      level: "warning",
      message:
        `Failed to load the Kimi model catalog from ${provider.baseURL}: ` +
        `${entry.errorMessage ?? "unknown error"}. Chat can continue and you can still use "/model <name>".`,
    };
  }

  if (entry.status !== "ready") {
    return {
      level: "warning",
      message: `Kimi model catalog has not been loaded from ${provider.baseURL} yet.`,
    };
  }

  const knownContextCount = entry.models.filter(
    (model) => model.contextTokens !== null,
  ).length;
  const matchingModel = entry.models.find((model) => model.id === provider.model);
  const catalogSummary =
    `Loaded ${entry.models.length} Kimi model${entry.models.length === 1 ? "" : "s"} ` +
    `from ${provider.baseURL}; ${knownContextCount} ` +
    `include context lengths.`;

  if (matchingModel) {
    return {
      level: "info",
      message:
        `${catalogSummary} Current model ${provider.model} is available ` +
        `(${formatTokenCount(matchingModel.contextTokens)} context).`,
    };
  }

  return {
    level: "warning",
    message:
      `${catalogSummary} Current model ${provider.model} is not in the accessible list. ` +
      `Use "/model" to switch.`,
  };
}

export function getKimiRegistryContextTokens(model: string): number | null {
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel) {
    return null;
  }

  const directMatch = KIMI_MODEL_CONTEXT_REGISTRY.get(normalizedModel);
  if (directMatch) {
    return directMatch;
  }

  if (normalizedModel.startsWith("kimi-")) {
    return 256_000;
  }

  return null;
}

function parseProviderCatalogModels(data: unknown): ProviderCatalogModel[] {
  if (!Array.isArray(data)) {
    return [];
  }

  const models = data.flatMap((entry) => parseProviderCatalogModel(entry));
  models.sort((left, right) => left.id.localeCompare(right.id));
  return models;
}

function parseProviderCatalogModel(entry: unknown): ProviderCatalogModel[] {
  if (!entry || typeof entry !== "object") {
    return [];
  }

  const candidate = entry as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!id) {
    return [];
  }

  const responseContextTokens = extractContextTokens(candidate);
  const registryContextTokens = getKimiRegistryContextTokens(id);

  return [
    {
      id,
      contextTokens: responseContextTokens ?? registryContextTokens,
      contextSource:
        responseContextTokens !== null
          ? "response"
          : registryContextTokens !== null
            ? "registry"
            : "unknown",
    },
  ];
}

function extractContextTokens(value: unknown): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const directKeys = [
    "context_length",
    "contextLength",
    "context_window",
    "contextWindow",
    "context_tokens",
    "contextTokens",
    "max_context_tokens",
    "maxContextTokens",
    "max_input_tokens",
    "maxInputTokens",
  ];

  for (const key of directKeys) {
    const parsed = parseTokenValue(candidate[key]);
    if (parsed !== null) {
      return parsed;
    }
  }

  for (const nestedKey of ["capabilities", "limits", "metadata"]) {
    const parsed = extractContextTokens(candidate[nestedKey]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function parseTokenValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const kiloMatch = normalized.match(/^(\d+(?:\.\d+)?)k$/);
  if (kiloMatch) {
    const amount = Number(kiloMatch[1]);
    return Number.isFinite(amount) ? Math.round(amount * 1_000) : null;
  }

  const plainNumber = Number(normalized);
  return Number.isFinite(plainNumber) && plainNumber > 0
    ? Math.round(plainNumber)
    : null;
}

function formatTokenCount(value: number | null): string {
  if (value === null) {
    return "--";
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}m`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  }

  return value.toString();
}
