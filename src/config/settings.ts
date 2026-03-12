import { homedir } from "node:os";
import path from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { DEFAULT_SYSTEM_PROMPT } from "../prompts/system.js";

type PersistedSettings = {
  systemPrompt?: unknown;
};

export type SuperRunSettings = {
  systemPrompt: string;
  hasStoredSystemPrompt: boolean;
  filePath: string;
};

export async function loadSettings(): Promise<SuperRunSettings> {
  const filePath = getSettingsFilePath();

  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as PersistedSettings;
    const storedPrompt =
      typeof parsed.systemPrompt === "string" ? parsed.systemPrompt.trim() : "";

    return {
      systemPrompt: storedPrompt || DEFAULT_SYSTEM_PROMPT,
      hasStoredSystemPrompt: Boolean(storedPrompt),
      filePath,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        hasStoredSystemPrompt: false,
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

  const filePath = getSettingsFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ systemPrompt: trimmedPrompt }, null, 2)}\n`,
    "utf8",
  );

  return {
    systemPrompt: trimmedPrompt,
    hasStoredSystemPrompt: true,
    filePath,
  };
}

export async function resetSystemPrompt(): Promise<SuperRunSettings> {
  const filePath = getSettingsFilePath();

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
    filePath,
  };
}

function getSettingsFilePath(): string {
  const overrideDir = process.env.SUPERRUN_CONFIG_DIR?.trim();
  if (overrideDir) {
    return path.join(overrideDir, "settings.json");
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) {
      return path.join(appData, "SuperRun", "settings.json");
    }
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, "superrun", "settings.json");
  }

  const home = homedir().trim();
  if (!home) {
    throw new Error("Unable to determine the home directory for settings.");
  }

  return path.join(home, ".config", "superrun", "settings.json");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
