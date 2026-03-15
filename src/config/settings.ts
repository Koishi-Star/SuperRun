import path from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { DEFAULT_SYSTEM_PROMPT } from "../prompts/system.js";
import { getConfigFilePath } from "./paths.js";
import {
  parseProviderId,
  resolveProviderSettings,
  type ProviderId,
  type ProviderSettings,
  type ProviderSettingsOverrides,
} from "../llm/provider.js";

type PersistedSettings = {
  systemPrompt?: unknown;
  providerSettings?: unknown;
};

export type SuperRunSettings = {
  systemPrompt: string;
  hasStoredSystemPrompt: boolean;
  providerSettings: ProviderSettings;
  providerSettingsOverrides: ProviderSettingsOverrides;
  filePath: string;
};

export async function loadSettings(): Promise<SuperRunSettings> {
  const filePath = getSettingsFilePath();

  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as PersistedSettings;
    const storedPrompt =
      typeof parsed.systemPrompt === "string" ? parsed.systemPrompt.trim() : "";
    const providerSettingsOverrides = parseProviderSettingsOverrides(
      parsed.providerSettings,
      filePath,
    );

    return {
      systemPrompt: storedPrompt || DEFAULT_SYSTEM_PROMPT,
      hasStoredSystemPrompt: Boolean(storedPrompt),
      providerSettings: resolveProviderSettings(providerSettingsOverrides),
      providerSettingsOverrides,
      filePath,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        hasStoredSystemPrompt: false,
        providerSettings: resolveProviderSettings(),
        providerSettingsOverrides: {},
        filePath,
      };
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Settings file is not valid JSON: ${filePath}`);
    }

    throw error;
  }
}

export async function saveSystemPrompt(
  systemPrompt: string,
): Promise<SuperRunSettings> {
  const trimmedPrompt = systemPrompt.trim();

  if (!trimmedPrompt) {
    throw new Error("System prompt must not be empty.");
  }

  const currentSettings = await loadSettings();
  return writeSettingsFile(currentSettings.filePath, {
    systemPrompt: trimmedPrompt,
    providerSettingsOverrides: currentSettings.providerSettingsOverrides,
  });
}

export async function resetSystemPrompt(): Promise<SuperRunSettings> {
  const currentSettings = await loadSettings();
  const filePath = currentSettings.filePath;
  if (!hasStoredProviderSettings(currentSettings.providerSettingsOverrides)) {
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    return {
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      hasStoredSystemPrompt: false,
      providerSettings: resolveProviderSettings(),
      providerSettingsOverrides: {},
      filePath,
    };
  }

  return writeSettingsFile(filePath, {
    providerSettingsOverrides: currentSettings.providerSettingsOverrides,
  });
}

export async function saveActiveProvider(
  providerId: ProviderId,
): Promise<SuperRunSettings> {
  const currentSettings = await loadSettings();
  return writeSettingsFile(currentSettings.filePath, {
    ...(currentSettings.hasStoredSystemPrompt
      ? { systemPrompt: currentSettings.systemPrompt }
      : {}),
    providerSettingsOverrides: {
      ...currentSettings.providerSettingsOverrides,
      activeProvider: providerId,
    },
  });
}

export async function saveProviderModel(
  providerId: ProviderId,
  model: string,
): Promise<SuperRunSettings> {
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    throw new Error("Provider model must not be empty.");
  }

  const currentSettings = await loadSettings();
  return writeSettingsFile(currentSettings.filePath, {
    ...(currentSettings.hasStoredSystemPrompt
      ? { systemPrompt: currentSettings.systemPrompt }
      : {}),
    providerSettingsOverrides: {
      ...currentSettings.providerSettingsOverrides,
      [getProviderOverrideKey(providerId)]: {
        ...currentSettings.providerSettingsOverrides[getProviderOverrideKey(providerId)],
        model: trimmedModel,
      },
    },
  });
}

export async function saveProviderTimeoutMs(
  providerId: ProviderId,
  timeoutMs: number,
): Promise<SuperRunSettings> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Provider timeout must be a positive integer.");
  }

  const currentSettings = await loadSettings();
  return writeSettingsFile(currentSettings.filePath, {
    ...(currentSettings.hasStoredSystemPrompt
      ? { systemPrompt: currentSettings.systemPrompt }
      : {}),
    providerSettingsOverrides: {
      ...currentSettings.providerSettingsOverrides,
      [getProviderOverrideKey(providerId)]: {
        ...currentSettings.providerSettingsOverrides[getProviderOverrideKey(providerId)],
        timeoutMs,
      },
    },
  });
}

export async function saveProviderBaseURL(
  providerId: ProviderId,
  baseURL: string,
): Promise<SuperRunSettings> {
  const trimmedBaseURL = baseURL.trim().replace(/\/+$/, "");
  if (!trimmedBaseURL) {
    throw new Error("Provider base URL must not be empty.");
  }

  const currentSettings = await loadSettings();
  return writeSettingsFile(currentSettings.filePath, {
    ...(currentSettings.hasStoredSystemPrompt
      ? { systemPrompt: currentSettings.systemPrompt }
      : {}),
    providerSettingsOverrides: {
      ...currentSettings.providerSettingsOverrides,
      [getProviderOverrideKey(providerId)]: {
        ...currentSettings.providerSettingsOverrides[getProviderOverrideKey(providerId)],
        baseURL: trimmedBaseURL,
      },
    },
  });
}

function getSettingsFilePath(): string {
  return getConfigFilePath("settings.json");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function parseProviderSettingsOverrides(
  value: unknown,
  filePath: string,
): ProviderSettingsOverrides {
  if (value === undefined) {
    return {};
  }

  if (!value || typeof value !== "object") {
    throw new Error(`Settings file has an invalid providerSettings value: ${filePath}`);
  }

  const candidate = value as Record<string, unknown>;
  const overrides: ProviderSettingsOverrides = {};

  if (candidate.activeProvider !== undefined) {
    if (typeof candidate.activeProvider !== "string") {
      throw new Error(`Settings file has an invalid activeProvider value: ${filePath}`);
    }
    overrides.activeProvider = parseProviderId(candidate.activeProvider);
  }

  if (candidate.openaiCompatible !== undefined) {
    overrides.openaiCompatible = parseProviderProfileOverride(
      candidate.openaiCompatible,
      filePath,
      "openaiCompatible",
    );
  }

  if (candidate.kimi !== undefined) {
    overrides.kimi = parseProviderProfileOverride(
      candidate.kimi,
      filePath,
      "kimi",
    );
  }

  return overrides;
}

function parseProviderProfileOverride(
  value: unknown,
  filePath: string,
  key: "openaiCompatible" | "kimi",
): Partial<ProviderSettings["openaiCompatible"]> {
  if (!value || typeof value !== "object") {
    throw new Error(`Settings file has an invalid ${key} provider config: ${filePath}`);
  }

  const candidate = value as Record<string, unknown>;
  const profile: Partial<ProviderSettings["openaiCompatible"]> = {};

  if (candidate.baseURL !== undefined) {
    if (typeof candidate.baseURL !== "string" || !candidate.baseURL.trim()) {
      throw new Error(`Settings file has an invalid ${key}.baseURL value: ${filePath}`);
    }
    profile.baseURL = candidate.baseURL.trim().replace(/\/+$/, "");
  }

  if (candidate.model !== undefined) {
    if (typeof candidate.model !== "string" || !candidate.model.trim()) {
      throw new Error(`Settings file has an invalid ${key}.model value: ${filePath}`);
    }
    profile.model = candidate.model.trim();
  }

  if (candidate.timeoutMs !== undefined) {
    if (
      typeof candidate.timeoutMs !== "number" ||
      !Number.isInteger(candidate.timeoutMs) ||
      candidate.timeoutMs <= 0
    ) {
      throw new Error(`Settings file has an invalid ${key}.timeoutMs value: ${filePath}`);
    }
    profile.timeoutMs = candidate.timeoutMs;
  }

  return profile;
}

async function writeSettingsFile(
  filePath: string,
  nextSettings: {
    systemPrompt?: string;
    providerSettingsOverrides?: ProviderSettingsOverrides;
  },
): Promise<SuperRunSettings> {
  const persistedSettings = buildPersistedSettings(nextSettings);
  if (Object.keys(persistedSettings).length === 0) {
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  } else {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify(persistedSettings, null, 2)}\n`,
      "utf8",
    );
  }

  const providerSettingsOverrides = nextSettings.providerSettingsOverrides ?? {};
  const storedPrompt = nextSettings.systemPrompt?.trim() ?? "";
  return {
    systemPrompt: storedPrompt || DEFAULT_SYSTEM_PROMPT,
    hasStoredSystemPrompt: Boolean(storedPrompt),
    providerSettings: resolveProviderSettings(providerSettingsOverrides),
    providerSettingsOverrides,
    filePath,
  };
}

function buildPersistedSettings(
  settings: {
    systemPrompt?: string;
    providerSettingsOverrides?: ProviderSettingsOverrides;
  },
): PersistedSettings {
  const persistedSettings: PersistedSettings = {};
  const trimmedPrompt = settings.systemPrompt?.trim();
  if (trimmedPrompt) {
    persistedSettings.systemPrompt = trimmedPrompt;
  }

  const providerSettings = buildPersistedProviderSettings(
    settings.providerSettingsOverrides ?? {},
  );
  if (providerSettings) {
    persistedSettings.providerSettings = providerSettings;
  }

  return persistedSettings;
}

function buildPersistedProviderSettings(
  overrides: ProviderSettingsOverrides,
): ProviderSettingsOverrides | null {
  const providerSettings: ProviderSettingsOverrides = {};
  if (overrides.activeProvider) {
    providerSettings.activeProvider = overrides.activeProvider;
  }

  if (overrides.openaiCompatible && Object.keys(overrides.openaiCompatible).length > 0) {
    providerSettings.openaiCompatible = { ...overrides.openaiCompatible };
  }

  if (overrides.kimi && Object.keys(overrides.kimi).length > 0) {
    providerSettings.kimi = { ...overrides.kimi };
  }

  return Object.keys(providerSettings).length > 0 ? providerSettings : null;
}

function hasStoredProviderSettings(
  overrides: ProviderSettingsOverrides,
): boolean {
  return Boolean(buildPersistedProviderSettings(overrides));
}

function getProviderOverrideKey(
  providerId: ProviderId,
): "openaiCompatible" | "kimi" {
  return providerId === "kimi" ? "kimi" : "openaiCompatible";
}
