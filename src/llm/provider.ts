export const DEFAULT_PROVIDER_ID = "openai_compatible";
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_COMPATIBLE_MODEL = "gpt-4o-mini";
export const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.cn/v1";
export const ALTERNATE_KIMI_BASE_URL = "https://api.moonshot.ai/v1";
export const DEFAULT_KIMI_MODEL = "kimi-latest";
export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

export type ProviderId = "openai_compatible" | "kimi";

export type ProviderProfileConfig = {
  baseURL: string;
  model: string;
  timeoutMs: number;
  contextLimitTokens?: number;
};

export type ProviderSettingsOverrides = {
  activeProvider?: ProviderId;
  openaiCompatible?: Partial<ProviderProfileConfig>;
  kimi?: Partial<ProviderProfileConfig>;
};

export type ProviderSettings = {
  activeProvider: ProviderId;
  openaiCompatible: ProviderProfileConfig;
  kimi: ProviderProfileConfig;
};

export type ProviderApiKeySource = "runtime" | "stored" | "env" | "missing";

export type ProviderRuntimeSecretOverrides = Partial<Record<ProviderId, string>>;

export type ProviderRuntimeConfig = ProviderProfileConfig & {
  id: ProviderId;
  label: string;
  apiKey: string;
  apiKeySource: ProviderApiKeySource;
  apiKeyPlaceholder: string;
  modelContextTokens: number | null;
  modelContextSource: "catalog" | "registry" | "unknown";
};

export type ProviderUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  source: "response" | "estimate";
};

const KIMI_BASE_URL_ALIASES = new Map<string, string>([
  ["cn", DEFAULT_KIMI_BASE_URL],
  ["moonshot-cn", DEFAULT_KIMI_BASE_URL],
  ["moonshot.cn", DEFAULT_KIMI_BASE_URL],
  ["https://api.moonshot.cn", DEFAULT_KIMI_BASE_URL],
  [DEFAULT_KIMI_BASE_URL, DEFAULT_KIMI_BASE_URL],
  ["ai", ALTERNATE_KIMI_BASE_URL],
  ["moonshot-ai", ALTERNATE_KIMI_BASE_URL],
  ["moonshot.ai", ALTERNATE_KIMI_BASE_URL],
  ["https://api.moonshot.ai", ALTERNATE_KIMI_BASE_URL],
  [ALTERNATE_KIMI_BASE_URL, ALTERNATE_KIMI_BASE_URL],
]);

export function getProviderDisplayName(providerId: ProviderId): string {
  return providerId === "kimi" ? "Kimi" : "OpenAI-Compatible";
}

export function parseProviderId(value: string): ProviderId {
  const normalizedValue = value.trim().toLowerCase();
  if (
    normalizedValue === "openai-compatible" ||
    normalizedValue === "openai_compatible" ||
    normalizedValue === "openai" ||
    normalizedValue === "custom"
  ) {
    return "openai_compatible";
  }

  if (normalizedValue === "kimi" || normalizedValue === "moonshot") {
    return "kimi";
  }

  throw new Error(`Unknown provider: ${value}`);
}

export function resolveProviderSettings(
  overrides?: ProviderSettingsOverrides,
): ProviderSettings {
  const activeProvider =
    overrides?.activeProvider ??
    readOptionalProviderFromEnv(process.env.SUPERRUN_PROVIDER) ??
    DEFAULT_PROVIDER_ID;

  return {
    activeProvider,
    openaiCompatible: {
      baseURL: normalizeBaseURL(
        overrides?.openaiCompatible?.baseURL ??
          process.env.OPENAI_BASE_URL ??
          DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
      ),
      model: normalizeRequiredText(
        overrides?.openaiCompatible?.model ??
          process.env.OPENAI_MODEL ??
          DEFAULT_OPENAI_COMPATIBLE_MODEL,
        "OpenAI-compatible model",
      ),
      timeoutMs: normalizeTimeoutMs(
        overrides?.openaiCompatible?.timeoutMs ??
          process.env.OPENAI_TIMEOUT_MS ??
          DEFAULT_PROVIDER_TIMEOUT_MS,
        "OPENAI_TIMEOUT_MS",
      ),
      ...(overrides?.openaiCompatible?.contextLimitTokens !== undefined
        ? {
            contextLimitTokens: normalizeContextLimitTokens(
              overrides.openaiCompatible.contextLimitTokens,
              "OpenAI-compatible context limit",
            ),
          }
        : {}),
    },
    kimi: {
      baseURL: normalizeProviderBaseURL(
        "kimi",
        overrides?.kimi?.baseURL ??
          process.env.MOONSHOT_BASE_URL ??
          process.env.KIMI_BASE_URL ??
          DEFAULT_KIMI_BASE_URL,
      ),
      model: normalizeRequiredText(
        overrides?.kimi?.model ??
          process.env.MOONSHOT_MODEL ??
          process.env.KIMI_MODEL ??
          DEFAULT_KIMI_MODEL,
        "Kimi model",
      ),
      timeoutMs: normalizeTimeoutMs(
        overrides?.kimi?.timeoutMs ??
          process.env.MOONSHOT_TIMEOUT_MS ??
          process.env.KIMI_TIMEOUT_MS ??
          DEFAULT_PROVIDER_TIMEOUT_MS,
        "MOONSHOT_TIMEOUT_MS",
      ),
      ...(overrides?.kimi?.contextLimitTokens !== undefined
        ? {
            contextLimitTokens: normalizeContextLimitTokens(
              overrides.kimi.contextLimitTokens,
              "Kimi context limit",
            ),
          }
        : {}),
    },
  };
}

export function resolveProviderRuntimeConfig(
  settings: ProviderSettings,
  runtimeSecrets?: ProviderRuntimeSecretOverrides,
): ProviderRuntimeConfig {
  const providerId = settings.activeProvider;
  const profile =
    providerId === "kimi" ? settings.kimi : settings.openaiCompatible;
  const runtimeApiKey = normalizeOptionalText(runtimeSecrets?.[providerId]);
  const envApiKey = readProviderApiKeyFromEnv(providerId);
  const apiKey = runtimeApiKey || envApiKey || "";

  return {
    id: providerId,
    label: getProviderDisplayName(providerId),
    baseURL: profile.baseURL,
    model: profile.model,
    timeoutMs: profile.timeoutMs,
    ...(profile.contextLimitTokens !== undefined
      ? { contextLimitTokens: profile.contextLimitTokens }
      : {}),
    apiKey,
    apiKeySource: runtimeApiKey ? "runtime" : envApiKey ? "env" : "missing",
    apiKeyPlaceholder: getProviderApiKeyPlaceholder(providerId),
    modelContextTokens: null,
    modelContextSource: "unknown",
  };
}

export function readProviderApiKeyFromEnv(
  providerId: ProviderId,
): string {
  for (const envName of getProviderApiKeyEnvNames(providerId)) {
    const value = normalizeOptionalText(process.env[envName]);
    if (value) {
      return value;
    }
  }

  return "";
}

export function getProviderApiKeyPlaceholder(
  providerId: ProviderId,
): string {
  return providerId === "kimi" ? "__kimi_token__" : "__provider_token__";
}

export function buildSafeProcessEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const safeEnv = { ...sourceEnv };

  for (const envName of getProviderApiKeyEnvNames("kimi")) {
    if (safeEnv[envName]) {
      safeEnv[envName] = getProviderApiKeyPlaceholder("kimi");
    }
  }

  for (const envName of getProviderApiKeyEnvNames("openai_compatible")) {
    if (safeEnv[envName]) {
      safeEnv[envName] = getProviderApiKeyPlaceholder("openai_compatible");
    }
  }

  return safeEnv;
}

export function getProviderApiKeyEnvNames(
  providerId: ProviderId,
): string[] {
  return providerId === "kimi"
    ? ["MOONSHOT_API_KEY", "KIMI_API_KEY"]
    : ["OPENAI_API_KEY"];
}

export function normalizeProviderBaseURL(
  providerId: ProviderId,
  value: string,
): string {
  const normalizedValue = normalizeBaseURL(value);
  if (providerId !== "kimi") {
    return normalizedValue;
  }

  return KIMI_BASE_URL_ALIASES.get(normalizedValue.toLowerCase()) ?? normalizedValue;
}

function readOptionalProviderFromEnv(
  value: string | undefined,
): ProviderId | null {
  const normalizedValue = normalizeOptionalText(value);
  if (!normalizedValue) {
    return null;
  }

  return parseProviderId(normalizedValue);
}

function normalizeBaseURL(value: string): string {
  const normalizedValue = normalizeRequiredText(value, "Provider base URL");
  return normalizedValue.replace(/\/+$/, "");
}

function normalizeRequiredText(
  value: string,
  fieldName: string,
): string {
  const normalizedValue = normalizeOptionalText(value);
  if (!normalizedValue) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  return normalizedValue;
}

function normalizeOptionalText(
  value: string | undefined | null,
): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTimeoutMs(
  value: number | string,
  fieldName: string,
): number {
  const parsedValue =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`${fieldName} must be a positive integer when set.`);
  }

  return Math.round(parsedValue);
}

function normalizeContextLimitTokens(
  value: number,
  fieldName: string,
): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer when set.`);
  }

  return value;
}
