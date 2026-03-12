import path from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import type { ConversationMessage } from "../llm/types.js";
import { getConfigFilePath } from "../config/paths.js";

type PersistedSessionFile = {
  systemPrompt?: unknown;
  history?: unknown;
  maxHistoryTurns?: unknown;
  updatedAt?: unknown;
};

export type SavedSession = {
  systemPrompt: string;
  history: ConversationMessage[];
  maxHistoryTurns: number;
  updatedAt: string;
  filePath: string;
};

export type SavedSessionState = {
  session: SavedSession | null;
  filePath: string;
};

export type SessionSnapshot = {
  systemPrompt: string;
  history: ConversationMessage[];
  maxHistoryTurns: number;
};

export async function loadSavedSession(): Promise<SavedSessionState> {
  const filePath = getSessionFilePath();

  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as PersistedSessionFile;
    const session = parseSavedSession(parsed, filePath);

    return {
      session,
      filePath,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        session: null,
        filePath,
      };
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Session file is not valid JSON: ${filePath}`);
    }

    throw error;
  }
}

export async function saveSession(
  snapshot: SessionSnapshot,
): Promise<SavedSession> {
  const filePath = getSessionFilePath();
  const systemPrompt = snapshot.systemPrompt.trim();

  if (!systemPrompt) {
    throw new Error("Session system prompt must not be empty.");
  }

  if (!Number.isInteger(snapshot.maxHistoryTurns) || snapshot.maxHistoryTurns <= 0) {
    throw new Error("Session maxHistoryTurns must be a positive integer.");
  }

  const history = snapshot.history.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const updatedAt = new Date().toISOString();

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        systemPrompt,
        history,
        maxHistoryTurns: snapshot.maxHistoryTurns,
        updatedAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    systemPrompt,
    history,
    maxHistoryTurns: snapshot.maxHistoryTurns,
    updatedAt,
    filePath,
  };
}

export async function clearSavedSession(): Promise<string> {
  const filePath = getSessionFilePath();

  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  return filePath;
}

function parseSavedSession(
  parsed: PersistedSessionFile,
  filePath: string,
): SavedSession {
  const systemPrompt =
    typeof parsed.systemPrompt === "string" ? parsed.systemPrompt.trim() : "";
  const updatedAt =
    typeof parsed.updatedAt === "string" ? parsed.updatedAt.trim() : "";
  const maxHistoryTurns =
    typeof parsed.maxHistoryTurns === "number" ? parsed.maxHistoryTurns : NaN;

  if (!systemPrompt) {
    throw new Error(`Session file is missing a valid system prompt: ${filePath}`);
  }

  if (!Number.isInteger(maxHistoryTurns) || maxHistoryTurns <= 0) {
    throw new Error(`Session file has an invalid maxHistoryTurns value: ${filePath}`);
  }

  if (!updatedAt) {
    throw new Error(`Session file is missing an updatedAt timestamp: ${filePath}`);
  }

  return {
    systemPrompt,
    history: parseHistory(parsed.history, filePath),
    maxHistoryTurns,
    updatedAt,
    filePath,
  };
}

function parseHistory(
  history: unknown,
  filePath: string,
): ConversationMessage[] {
  if (!Array.isArray(history)) {
    throw new Error(`Session file has an invalid history value: ${filePath}`);
  }

  return history.map((message) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("role" in message) ||
      !("content" in message)
    ) {
      throw new Error(`Session file has an invalid history message: ${filePath}`);
    }

    const role = message.role;
    const content = message.content;

    if (
      (role !== "user" && role !== "assistant") ||
      typeof content !== "string"
    ) {
      throw new Error(`Session file has an invalid history message: ${filePath}`);
    }

    return {
      role,
      content,
    };
  });
}

function getSessionFilePath(): string {
  return getConfigFilePath("session.json");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
