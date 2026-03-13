import path from "node:path";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import type { ConversationMessage } from "../llm/types.js";
import { getConfigFilePath } from "../config/paths.js";

type PersistedSessionFile = {
  title?: unknown;
  systemPrompt?: unknown;
  history?: unknown;
  maxHistoryTurns?: unknown;
  updatedAt?: unknown;
};

type PersistedSessionIndex = {
  activeSessionId?: unknown;
  sessions?: unknown;
};

type PersistedSessionSummary = {
  id?: unknown;
  title?: unknown;
  preview?: unknown;
  updatedAt?: unknown;
  turnCount?: unknown;
  charCount?: unknown;
};

export type SessionSnapshot = {
  title?: string;
  systemPrompt: string;
  history: ConversationMessage[];
  maxHistoryTurns: number;
};

export type SessionSummary = {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  turnCount: number;
  charCount: number;
};

export type StoredSession = {
  id: string;
  title: string;
  preview: string;
  systemPrompt: string;
  history: ConversationMessage[];
  maxHistoryTurns: number;
  updatedAt: string;
  filePath: string;
};

export type SessionStoreState = {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  indexFilePath: string;
  sessionsDirectoryPath: string;
};

type HydratableSessionSummary = SessionSummary & {
  needsHydration?: boolean;
};

export async function loadSessionStore(): Promise<SessionStoreState> {
  const indexFilePath = getSessionIndexFilePath();
  const sessionsDirectoryPath = path.dirname(indexFilePath);

  try {
    const content = await readFile(indexFilePath, "utf8");
    const parsed = JSON.parse(content) as PersistedSessionIndex;
    const store = parseSessionStore(parsed, indexFilePath, sessionsDirectoryPath);
    return hydrateSessionStoreSummaries(store);
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        sessions: [],
        activeSessionId: null,
        indexFilePath,
        sessionsDirectoryPath,
      };
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Session index is not valid JSON: ${indexFilePath}`);
    }

    throw error;
  }
}

export async function loadSession(sessionId: string): Promise<StoredSession> {
  const filePath = getSessionFilePath(sessionId);

  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as PersistedSessionFile;
    return parseStoredSession(parsed, sessionId, filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Session does not exist: ${sessionId}`);
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Session file is not valid JSON: ${filePath}`);
    }

    throw error;
  }
}

export async function createSession(
  snapshot: SessionSnapshot,
): Promise<{ session: StoredSession; store: SessionStoreState }> {
  const sessionId = createSessionId();
  return saveSession(sessionId, snapshot);
}

export async function saveSession(
  sessionId: string,
  snapshot: SessionSnapshot,
): Promise<{ session: StoredSession; store: SessionStoreState }> {
  const normalizedId = normalizeSessionId(sessionId);
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
  // Preserve an existing manual title when routine autosaves do not provide one.
  const existingSession = await loadExistingSession(normalizedId);
  const title = deriveSessionTitle(
    snapshot.title,
    existingSession?.title ?? null,
    history,
    normalizedId,
  );
  const preview = buildSessionPreview(history);
  const updatedAt = new Date().toISOString();
  const filePath = getSessionFilePath(normalizedId);
  const indexFilePath = getSessionIndexFilePath();
  const sessionsDirectoryPath = path.dirname(indexFilePath);
  const summary = {
    id: normalizedId,
    title,
    preview,
    updatedAt,
    turnCount: countTurns(history),
    charCount: countChars(history),
  };

  await mkdir(sessionsDirectoryPath, { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        title,
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

  const currentStore = await loadSessionStore();
  const nextSessions = [
    summary,
    ...currentStore.sessions.filter((session) => session.id !== normalizedId),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const store = await writeSessionIndex({
    sessions: nextSessions,
    activeSessionId: normalizedId,
    indexFilePath,
    sessionsDirectoryPath,
  });

  return {
    session: {
      id: normalizedId,
      title,
      preview,
      systemPrompt,
      history,
      maxHistoryTurns: snapshot.maxHistoryTurns,
      updatedAt,
      filePath,
    },
    store,
  };
}

export async function deleteSession(
  sessionId: string,
): Promise<SessionStoreState> {
  const normalizedId = normalizeSessionId(sessionId);
  const filePath = getSessionFilePath(normalizedId);

  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const currentStore = await loadSessionStore();
  const remainingSessions = currentStore.sessions.filter(
    (session) => session.id !== normalizedId,
  );
  const activeSessionId =
    currentStore.activeSessionId === normalizedId
      ? (remainingSessions[0]?.id ?? null)
      : currentStore.activeSessionId;

  return writeSessionIndex({
    sessions: remainingSessions,
    activeSessionId,
    indexFilePath: currentStore.indexFilePath,
    sessionsDirectoryPath: currentStore.sessionsDirectoryPath,
  });
}

export async function deleteAllSessions(): Promise<SessionStoreState> {
  const currentStore = await loadSessionStore();
  const indexFileName = path.basename(currentStore.indexFilePath);

  try {
    const entries = await readdir(currentStore.sessionsDirectoryPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      if (!entry.name.endsWith(".json") || entry.name === indexFileName) {
        continue;
      }

      await unlink(path.join(currentStore.sessionsDirectoryPath, entry.name));
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  return writeSessionIndex({
    sessions: [],
    activeSessionId: null,
    indexFilePath: currentStore.indexFilePath,
    sessionsDirectoryPath: currentStore.sessionsDirectoryPath,
  });
}

export async function setActiveSession(
  sessionId: string | null,
): Promise<SessionStoreState> {
  const currentStore = await loadSessionStore();

  if (sessionId !== null && !currentStore.sessions.some((session) => session.id === sessionId)) {
    throw new Error(`Session does not exist: ${sessionId}`);
  }

  return writeSessionIndex({
    sessions: currentStore.sessions,
    activeSessionId: sessionId,
    indexFilePath: currentStore.indexFilePath,
    sessionsDirectoryPath: currentStore.sessionsDirectoryPath,
  });
}

function parseSessionStore(
  parsed: PersistedSessionIndex,
  indexFilePath: string,
  sessionsDirectoryPath: string,
): SessionStoreState {
  const sessions = parseSessionSummaries(parsed.sessions, indexFilePath);
  const activeSessionId =
    typeof parsed.activeSessionId === "string" ? parsed.activeSessionId.trim() : "";

  return {
    sessions,
    activeSessionId:
      activeSessionId && sessions.some((session) => session.id === activeSessionId)
        ? activeSessionId
        : null,
    indexFilePath,
    sessionsDirectoryPath,
  };
}

function parseSessionSummaries(
  sessions: unknown,
  indexFilePath: string,
): SessionSummary[] {
  if (!Array.isArray(sessions)) {
    if (sessions === undefined) {
      return [];
    }
    throw new Error(`Session index has an invalid sessions value: ${indexFilePath}`);
  }

  return sessions.map((session) => {
    if (!session || typeof session !== "object") {
      throw new Error(`Session index has an invalid summary entry: ${indexFilePath}`);
    }

    const summary = session as PersistedSessionSummary;
    const id = typeof summary.id === "string" ? summary.id.trim() : "";
    const title =
      typeof summary.title === "string" ? normalizeOptionalText(summary.title) : "";
    const preview =
      typeof summary.preview === "string" ? normalizeOptionalText(summary.preview) : "";
    if (!id) {
      throw new Error(`Session index has an invalid summary entry: ${indexFilePath}`);
    }

    const updatedAt =
      typeof summary.updatedAt === "string" ? summary.updatedAt.trim() : "";
    const hasValidUpdatedAt = updatedAt.length > 0;
    const hasValidTurnCount =
      typeof summary.turnCount === "number" &&
      Number.isInteger(summary.turnCount) &&
      summary.turnCount >= 0;
    const hasValidCharCount =
      typeof summary.charCount === "number" &&
      Number.isInteger(summary.charCount) &&
      summary.charCount >= 0;
    const parsedSummary: HydratableSessionSummary = {
      id,
      title: title || getFallbackSessionTitle(id),
      preview: preview || "No preview yet.",
      updatedAt: hasValidUpdatedAt ? updatedAt : "",
      turnCount: hasValidTurnCount ? Number(summary.turnCount) : 0,
      charCount: hasValidCharCount ? Number(summary.charCount) : 0,
    };

    if (
      !title ||
      !preview ||
      !hasValidUpdatedAt ||
      !hasValidTurnCount ||
      !hasValidCharCount
    ) {
      parsedSummary.needsHydration = true;
    }

    return parsedSummary;
  });
}

function parseStoredSession(
  parsed: PersistedSessionFile,
  sessionId: string,
  filePath: string,
): StoredSession {
  const history = parseHistory(parsed.history, filePath);
  const title = deriveSessionTitle(
    typeof parsed.title === "string" ? parsed.title : null,
    null,
    history,
    sessionId,
  );
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
    id: sessionId,
    title,
    preview: buildSessionPreview(history),
    systemPrompt,
    history,
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

async function writeSessionIndex(
  store: SessionStoreState,
): Promise<SessionStoreState> {
  await mkdir(store.sessionsDirectoryPath, { recursive: true });
  await writeFile(
    store.indexFilePath,
    `${JSON.stringify(
      {
        activeSessionId: store.activeSessionId,
        sessions: store.sessions,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return store;
}

async function hydrateSessionStoreSummaries(
  store: SessionStoreState,
): Promise<SessionStoreState> {
  let changed = false;
  const hydratedSessions: SessionSummary[] = [];

  for (const summary of store.sessions) {
    if (!needsSummaryHydration(summary)) {
      hydratedSessions.push(summary);
      continue;
    }

    try {
      const storedSession = await loadSession(summary.id);
      const hydratedSummary: SessionSummary = {
        id: summary.id,
        title: storedSession.title,
        preview: storedSession.preview,
        updatedAt: storedSession.updatedAt,
        turnCount: countTurns(storedSession.history),
        charCount: countChars(storedSession.history),
      };
      hydratedSessions.push(hydratedSummary);
      changed ||= (
        hydratedSummary.title !== summary.title ||
        hydratedSummary.preview !== summary.preview ||
        hydratedSummary.updatedAt !== summary.updatedAt ||
        hydratedSummary.turnCount !== summary.turnCount ||
        hydratedSummary.charCount !== summary.charCount
      );
    } catch {
      hydratedSessions.push(summary);
    }
  }

  if (!changed) {
    return store;
  }

  return writeSessionIndex({
    ...store,
    sessions: hydratedSessions,
  });
}

function getSessionIndexFilePath(): string {
  return getConfigFilePath(path.join("sessions", "index.json"));
}

function getSessionFilePath(sessionId: string): string {
  return getConfigFilePath(path.join("sessions", `${normalizeSessionId(sessionId)}.json`));
}

function normalizeSessionId(sessionId: string): string {
  const trimmedId = sessionId.trim();
  if (!trimmedId) {
    throw new Error("Session id must not be empty.");
  }

  if (!/^[a-z0-9_-]+$/i.test(trimmedId)) {
    throw new Error("Session id may only contain letters, numbers, '_' and '-'.");
  }

  return trimmedId;
}

async function loadExistingSession(sessionId: string): Promise<StoredSession | null> {
  try {
    return await loadSession(sessionId);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `Session does not exist: ${sessionId}`
    ) {
      return null;
    }

    throw error;
  }
}

function createSessionId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `s_${timestamp}_${random}`;
}

function deriveSessionTitle(
  explicitTitle: string | null | undefined,
  existingTitle: string | null,
  history: ConversationMessage[],
  sessionId: string,
): string {
  const normalizedExplicitTitle = normalizeOptionalText(explicitTitle);
  if (
    normalizedExplicitTitle &&
    !isGeneratedSessionTitle(normalizedExplicitTitle, sessionId)
  ) {
    return normalizedExplicitTitle;
  }

  if (existingTitle && !isGeneratedSessionTitle(existingTitle, sessionId)) {
    return existingTitle;
  }

  const firstUserMessage = history.find((message) => message.role === "user");
  if (firstUserMessage?.content.trim()) {
    return summarizeText(firstUserMessage.content, 48);
  }

  if (normalizedExplicitTitle) {
    return normalizedExplicitTitle;
  }

  if (existingTitle) {
    return existingTitle;
  }

  return getFallbackSessionTitle(sessionId);
}

function buildSessionPreview(history: ConversationMessage[]): string {
  const lastMessage = [...history].reverse().find((message) => message.content.trim());
  if (!lastMessage) {
    return "No messages yet.";
  }

  const speaker = lastMessage.role === "user" ? "You" : "Assistant";
  return `${speaker}: ${summarizeText(lastMessage.content, 72)}`;
}

function getFallbackSessionTitle(sessionId: string): string {
  const shortId = sessionId.slice(-6);
  return shortId ? `Session ${shortId}` : "Untitled session";
}

function needsSummaryHydration(summary: SessionSummary): boolean {
  return (
    (summary as HydratableSessionSummary).needsHydration === true ||
    !summary.updatedAt ||
    summary.preview === "No preview yet." ||
    isGeneratedSessionTitle(summary.title, summary.id)
  );
}

function isGeneratedSessionTitle(title: string, sessionId: string): boolean {
  return title === getFallbackSessionTitle(sessionId) || title === "Untitled session";
}

function normalizeOptionalText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function summarizeText(value: string, maxLength: number): string {
  const normalized = normalizeOptionalText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function countTurns(history: ConversationMessage[]): number {
  return history.filter((message) => message.role === "user").length;
}

function countChars(history: ConversationMessage[]): number {
  return history.reduce((total, message) => total + message.content.length, 0);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
