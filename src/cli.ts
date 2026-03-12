import "dotenv/config";
import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import type { Interface } from "node:readline/promises";
import { Command } from "commander";
import {
  type AgentSession,
  createAgentSession,
  getAgentSessionStats,
  runAgentTurn,
} from "./agent/loop.js";
import {
  loadSettings,
  resetSystemPrompt,
  saveSystemPrompt,
  type SuperRunSettings,
} from "./config/settings.js";
import {
  createSession,
  deleteSession,
  loadSession,
  loadSessionStore,
  saveSession,
  setActiveSession,
  type SessionSummary,
  type SessionStoreState,
  type StoredSession,
} from "./session/store.js";
import { runSessionPickerInteraction } from "./ui/session-picker-controller.js";
import { createTerminalUI, type TerminalUI } from "./ui/tui.js";

export const program = new Command();

program
  .name("superrun")
  .description("A coding agent CLI")
  .argument("[prompt]", "prompt to send to the model")
  .action(async (prompt?: string) => {
    try {
      const settings = await loadSettings();
      const session = createAgentSession({
        systemPrompt: settings.systemPrompt,
      });
      const trimmedPrompt = prompt?.trim();

      if (trimmedPrompt) {
        await runSingleTurn(session, trimmedPrompt);
        return;
      }

      const state = await createInteractiveState(settings, session);
      await runInteractiveSession(session, state);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      console.error("error:", message);
      process.exitCode = 1;
    }
  });

type InteractiveState = {
  settings: SuperRunSettings;
  sessionStore: SessionStoreState;
  currentSessionId: string | null;
  currentSessionTitle: string | null;
  pendingSystemPromptLines: string[] | null;
};

const EXIT_COMMANDS = new Set(["/exit", "exit", "exit()"]);

async function createInteractiveState(
  settings: SuperRunSettings,
  session: AgentSession,
): Promise<InteractiveState> {
  let sessionStore = await loadSessionStore();
  let currentSessionId: string | null = null;

  if (sessionStore.activeSessionId) {
    try {
      const storedSession = await loadSession(sessionStore.activeSessionId);
      restoreStoredSession(session, storedSession);
      currentSessionId = storedSession.id;
      return {
        settings,
        sessionStore,
        currentSessionId,
        currentSessionTitle: storedSession.title,
        pendingSystemPromptLines: null,
      };
    } catch {
      sessionStore = await setActiveSession(null);
    }
  }

  return {
    settings,
    sessionStore,
    currentSessionId,
    currentSessionTitle: null,
    pendingSystemPromptLines: null,
  };
}

async function runSingleTurn(
  session: AgentSession,
  prompt: string,
): Promise<void> {
  console.log("user:", prompt);
  process.stdout.write("assistant: ");

  const reply = await runAgentTurn(session, prompt, {
    onChunk: (chunk) => {
      process.stdout.write(chunk);
    },
  });

  if (!reply) {
    process.stdout.write("(empty response)");
  }

  process.stdout.write("\n");
}

async function runInteractiveSession(
  session: AgentSession,
  state: InteractiveState,
): Promise<void> {
  const rl = createInterface({ input, output });
  const ui = input.isTTY && output.isTTY ? createTerminalUI(output) : null;

  if (ui) {
    renderInteractiveShell(ui, session, state);
  } else {
    console.log('Interactive mode. Type "/exit" to quit.');
    renderSessionPromptHint(ui, session, state.settings);
    renderSessionStoreHint(ui, state);
  }

  try {
    if (ui) {
      while (true) {
        let prompt: string;

        try {
          prompt = (await rl.question(ui.promptLabel)).trim();
        } catch (error) {
          if (isReadlineClosedError(error)) {
            break;
          }
          throw error;
        }

        if (!(await handleInteractivePrompt(session, prompt, rl, state, ui))) {
          break;
        }
      }
      return;
    }

    for await (const line of rl) {
      if (!(await handlePipedInteractiveLine(session, line, state, ui))) {
        break;
      }
    }
  } finally {
    rl.close();
  }
}

async function handleInteractivePrompt(
  session: AgentSession,
  prompt: string,
  rl: Interface,
  state: InteractiveState,
  ui: TerminalUI | null,
): Promise<boolean> {
  if (!prompt) {
    return true;
  }

  if (isExitCommand(prompt)) {
    return false;
  }

  if (prompt === "/help") {
    if (ui) {
      ui.renderCommands();
    } else {
      console.log("Commands: /help /settings /session /history [id|index|title] /sessions /new /switch <id|index|title> /rename <title> /delete [id|index|title] /system /system reset /clear /exit");
    }
    return true;
  }

  if (prompt === "/settings") {
    renderSettingsSummary(ui, session, state.settings);
    return true;
  }

  if (prompt === "/session") {
    renderCurrentSessionSummary(ui, session, state);
    return true;
  }

  if (matchesCommand(prompt, "/history")) {
    const sessionSelector = parseCommandArgument(prompt, "/history");
    try {
      if (!sessionSelector) {
        renderHistory(ui, {
          label: formatSessionLabel(state.currentSessionTitle, state.currentSessionId),
          history: session.history,
          current: true,
        });
        return true;
      }

      const targetSession = resolveSessionSelector(sessionSelector, state);
      const storedSession = await loadSession(targetSession.id);
      renderHistory(ui, {
        label: formatSessionLabel(storedSession.title, storedSession.id),
        history: storedSession.history,
        current: storedSession.id === state.currentSessionId,
      });
    } catch (error) {
      renderError(ui, error instanceof Error ? error.message : "Failed to load history.");
    }
    return true;
  }

  if (prompt === "/sessions") {
    if (ui) {
      const selectedSession = await runSessionPicker(ui, state);

      try {
        if (selectedSession) {
          const storedSession = await loadSession(selectedSession.id);
          restoreStoredSession(session, storedSession);
          state.currentSessionId = storedSession.id;
          state.currentSessionTitle = storedSession.title;
          state.sessionStore = await setActiveSession(storedSession.id);
          renderInteractiveShell(ui, session, state);
          renderSessionSwitched(ui, storedSession);
          return true;
        }

        renderInteractiveShell(ui, session, state);
        return true;
      } catch (error) {
        renderInteractiveShell(ui, session, state);
        renderError(ui, error instanceof Error ? error.message : "Failed to switch session.");
        return true;
      }
    }

    renderSessionList(ui, state);
    return true;
  }

  if (prompt === "/new") {
    resetCurrentSession(session, state.settings.systemPrompt);
    state.currentSessionTitle = null;
    const result = await createSession({
      systemPrompt: session.systemPrompt,
      history: session.history,
      maxHistoryTurns: session.maxHistoryTurns,
    });
    state.sessionStore = result.store;
    state.currentSessionId = result.session.id;
    state.currentSessionTitle = result.session.title;
    renderNewSessionCreated(ui, result.session);
    return true;
  }

  if (matchesCommand(prompt, "/switch")) {
    const sessionSelector = parseCommandArgument(prompt, "/switch");
    if (!sessionSelector) {
      renderError(ui, 'Usage: /switch <id|index|title>');
      return true;
    }

    try {
      const targetSession = resolveSessionSelector(sessionSelector, state);
      const storedSession = await loadSession(targetSession.id);
      restoreStoredSession(session, storedSession);
      state.currentSessionId = storedSession.id;
      state.currentSessionTitle = storedSession.title;
      state.sessionStore = await setActiveSession(storedSession.id);
      renderSessionSwitched(ui, storedSession);
    } catch (error) {
      renderError(ui, error instanceof Error ? error.message : "Failed to switch session.");
    }
    return true;
  }

  if (matchesCommand(prompt, "/rename")) {
    const nextTitle = parseCommandArgument(prompt, "/rename");
    if (!nextTitle) {
      renderError(ui, 'Usage: /rename <title>');
      return true;
    }

    if (!state.currentSessionId && session.history.length === 0) {
      renderError(ui, 'No current session to rename. Start chatting or use "/new" first.');
      return true;
    }

    await persistCurrentSession(session, state, {
      allowEmpty: true,
      title: nextTitle,
    });
    renderSessionRenamed(ui, state);
    return true;
  }

  if (matchesCommand(prompt, "/delete")) {
    const sessionSelector = parseCommandArgument(prompt, "/delete");
    let targetSessionId = state.currentSessionId;
    if (sessionSelector) {
      try {
        targetSessionId = resolveSessionSelector(sessionSelector, state).id;
      } catch (error) {
        renderError(ui, error instanceof Error ? error.message : "Failed to resolve session.");
        return true;
      }
    }

    if (!targetSessionId) {
      renderError(ui, "No current saved session is selected to delete.");
      return true;
    }

    const deletedCurrent = state.currentSessionId === targetSessionId;
    state.sessionStore = await deleteSession(targetSessionId);

    if (deletedCurrent) {
      if (state.sessionStore.activeSessionId) {
        const activeSession = await loadSession(state.sessionStore.activeSessionId);
        restoreStoredSession(session, activeSession);
        state.currentSessionId = activeSession.id;
        state.currentSessionTitle = activeSession.title;
        renderSessionDeletedAndSwitched(ui, targetSessionId, activeSession);
        return true;
      }

      resetCurrentSession(session, state.settings.systemPrompt);
      state.currentSessionId = null;
      state.currentSessionTitle = null;
      renderSessionDeleted(ui, targetSessionId);
      return true;
    }

    renderSessionDeleted(ui, targetSessionId);
    return true;
  }

  if (prompt === "/system") {
    await runSystemPromptEditor(session, rl, state, ui);
    return true;
  }

  if (prompt === "/system reset") {
    const settings = await resetSystemPrompt();
    state.settings = settings;
    resetCurrentSession(session, settings.systemPrompt);
    await persistCurrentSession(session, state, { allowEmpty: true });
    renderSystemPromptApplied(ui, session, settings, true);
    return true;
  }

  if (prompt === "/clear") {
    if (ui) {
      renderInteractiveShell(ui, session, state);
    }
    return true;
  }

  if (prompt.startsWith("/")) {
    renderError(ui, `Unknown command: ${prompt}. Type /help.`);
    return true;
  }

  if (ui) {
    ui.renderAssistantPrefix();
  } else {
    process.stdout.write("assistant: ");
  }

  const reply = await runAgentTurn(session, prompt, {
    onChunk: (chunk) => {
      process.stdout.write(chunk);
    },
  });

  await persistCurrentSession(session, state);

  if (!reply) {
    process.stdout.write("(empty response)");
  }

  process.stdout.write("\n");
  return true;
}

async function handlePipedInteractiveLine(
  session: AgentSession,
  line: string,
  state: InteractiveState,
  ui: TerminalUI | null,
): Promise<boolean> {
  if (state.pendingSystemPromptLines) {
    return handlePipedSystemPromptLine(session, line, state, ui);
  }

  const prompt = line.trim();
  if (prompt === "/system") {
    state.pendingSystemPromptLines = [];
    renderSystemPromptTips(ui, session.systemPrompt);
    return true;
  }

  return handleInteractivePrompt(session, prompt, null as never, state, ui);
}

async function handlePipedSystemPromptLine(
  session: AgentSession,
  line: string,
  state: InteractiveState,
  ui: TerminalUI | null,
): Promise<boolean> {
  const pendingLines = state.pendingSystemPromptLines;
  if (!pendingLines) {
    return true;
  }

  const trimmedLine = line.trim();

  if (trimmedLine === "/cancel") {
    state.pendingSystemPromptLines = null;
    renderInfo(ui, "System prompt update cancelled.");
    return true;
  }

  if (trimmedLine === "/save") {
    const nextPrompt = pendingLines.join("\n").trim();
    if (!nextPrompt) {
      renderError(ui, "System prompt must not be empty. Keep typing or use /cancel.");
      return true;
    }

    const settings = await saveSystemPrompt(nextPrompt);
    state.settings = settings;
    resetCurrentSession(session, settings.systemPrompt);
    state.pendingSystemPromptLines = null;
    await persistCurrentSession(session, state, { allowEmpty: true });
    renderSystemPromptApplied(ui, session, settings, true);
    return true;
  }

  pendingLines.push(line);
  return true;
}

function isReadlineClosedError(error: unknown): boolean {
  return error instanceof Error && error.message === "readline was closed";
}

async function runSystemPromptEditor(
  session: AgentSession,
  rl: Interface,
  state: InteractiveState,
  ui: TerminalUI | null,
): Promise<void> {
  renderSystemPromptTips(ui, session.systemPrompt);

  const nextPrompt = await readMultilineSystemPrompt(rl, ui);
  if (nextPrompt === null) {
    renderInfo(ui, "System prompt update cancelled.");
    return;
  }

  const settings = await saveSystemPrompt(nextPrompt);
  state.settings = settings;
  resetCurrentSession(session, settings.systemPrompt);
  await persistCurrentSession(session, state, { allowEmpty: true });
  renderSystemPromptApplied(ui, session, settings, true);
}

async function readMultilineSystemPrompt(
  rl: Interface,
  ui: TerminalUI | null,
): Promise<string | null> {
  const lines: string[] = [];

  while (true) {
    const line = await rl.question(ui ? ui.editorPromptLabel : "");
    const trimmedLine = line.trim();

    if (trimmedLine === "/cancel") {
      return null;
    }

    if (trimmedLine === "/save") {
      const prompt = lines.join("\n").trim();
      if (!prompt) {
        renderError(ui, "System prompt must not be empty. Keep typing or use /cancel.");
        continue;
      }

      return prompt;
    }

    lines.push(line);
  }
}

function resetCurrentSession(
  session: AgentSession,
  systemPrompt: string,
): void {
  session.systemPrompt = systemPrompt;
  session.history = [];
}

function renderInteractiveShell(
  ui: TerminalUI,
  session: AgentSession,
  state: InteractiveState,
): void {
  ui.clearScreen();
  ui.renderWelcome();
  renderSessionPromptHint(ui, session, state.settings);
  renderSessionStoreHint(ui, state);
}

function renderSessionPromptHint(
  ui: TerminalUI | null,
  session: AgentSession,
  settings: Pick<SuperRunSettings, "systemPrompt" | "hasStoredSystemPrompt">,
): void {
  const stats = getAgentSessionStats(session);
  const source = settings.hasStoredSystemPrompt ? "saved profile" : "built-in default";
  renderInfo(
    ui,
    `Active behavior (${source}): ${summarizePrompt(session.systemPrompt)}`,
  );
  renderInfo(
    ui,
    `History: ${stats.historyTurnCount}/${stats.maxHistoryTurns} turns, ${stats.historyCharCount} chars.`,
  );
  renderInfo(ui, 'Use "/system" to change the default behavior for new work.');
  if (ui) {
    output.write("\n");
  }
}

function renderSessionStoreHint(
  ui: TerminalUI | null,
  state: InteractiveState,
): void {
  const currentSessionId = state.currentSessionId;

  if (currentSessionId) {
    renderInfo(
      ui,
      `Current session: ${formatSessionLabel(state.currentSessionTitle, currentSessionId)}. Saved sessions: ${state.sessionStore.sessions.length}.`,
    );
    renderInfo(ui, 'Use "/sessions" to browse saved work, or "/new" to start fresh.');
    if (ui) {
      output.write("\n");
    }
    return;
  }

  if (state.sessionStore.sessions.length === 0) {
    renderInfo(ui, 'No saved sessions yet. Start chatting or use "/new" to create one now.');
    if (ui) {
      output.write("\n");
    }
    return;
  }

  renderInfo(
    ui,
    `Saved sessions: ${state.sessionStore.sessions.length}. Active session is not loaded.`,
  );
  renderInfo(ui, 'Use "/sessions" to browse them or "/switch <index>" to load one.');
  if (ui) {
    output.write("\n");
  }
}

function renderSettingsSummary(
  ui: TerminalUI | null,
  session: AgentSession,
  settings: SuperRunSettings,
): void {
  const stats = getAgentSessionStats(session);
  const source = settings.hasStoredSystemPrompt ? "saved profile" : "built-in default";

  if (ui) {
    ui.renderSectionTitle("System Prompt");
  } else {
    console.log("System Prompt");
  }

  renderInfo(ui, `Source: ${source}`);
  renderInfo(ui, `Path: ${settings.filePath}`);
  renderInfo(
    ui,
    `History policy: keep the most recent ${stats.maxHistoryTurns} turns.`,
  );
  renderInfo(
    ui,
    `Current history: ${stats.historyTurnCount} turns, ${stats.historyMessageCount} messages, ${stats.historyCharCount} chars.`,
  );
  renderInfo(ui, `System prompt size: ${stats.systemPromptCharCount} chars.`);
  renderInfo(ui, "This text defines how the agent should behave on every turn.");
  renderInfo(ui, "Changing it clears the current conversation and updates the default for new work.");

  const body = `${settings.systemPrompt}\n`;
  if (ui) {
    output.write(body);
  } else {
    process.stdout.write(body);
  }
}

function renderCurrentSessionSummary(
  ui: TerminalUI | null,
  session: AgentSession,
  state: InteractiveState,
): void {
  const currentStats = getAgentSessionStats(session);

  if (ui) {
    ui.renderSectionTitle("Session");
  } else {
    console.log("Session");
  }

  renderInfo(
    ui,
    `Current session: ${formatSessionLabel(
      state.currentSessionTitle,
      state.currentSessionId,
    )}`,
  );
  renderInfo(
    ui,
    `Current session: ${currentStats.historyTurnCount} turns, ${currentStats.historyMessageCount} messages, ${currentStats.historyCharCount} chars.`,
  );
  renderInfo(ui, `Current behavior: ${summarizePrompt(session.systemPrompt)}`);
  renderInfo(ui, `Session index: ${state.sessionStore.indexFilePath}`);
  renderInfo(ui, `Saved sessions total: ${state.sessionStore.sessions.length}`);
}

function renderSessionList(
  ui: TerminalUI | null,
  state: InteractiveState,
): void {
  if (ui) {
    ui.renderSectionTitle("Sessions");
  } else {
    console.log("Sessions");
  }

  if (state.sessionStore.sessions.length === 0) {
    renderInfo(ui, "No saved sessions.");
    return;
  }

  renderInfo(ui, 'Use "/switch <index>", "/switch <id>", or "/switch <title>" to load a session.');

  for (const [index, sessionSummary] of state.sessionStore.sessions.entries()) {
    const marker = sessionSummary.id === state.currentSessionId ? "*" : " ";
    renderInfo(
      ui,
      `${marker} ${index + 1}. ${sessionSummary.title} [${sessionSummary.id}]  ${sessionSummary.turnCount} turns  ${sessionSummary.charCount} chars  ${formatTimestamp(sessionSummary.updatedAt)}`,
    );
    renderInfo(ui, `    ${sessionSummary.preview}`);
  }
}

function renderHistory(
  ui: TerminalUI | null,
  options: {
    label: string;
    history: AgentSession["history"];
    current: boolean;
  },
): void {
  if (ui) {
    ui.renderSectionTitle("History");
  } else {
    console.log("History");
  }

  renderInfo(ui, `Session: ${options.label}`);
  renderInfo(ui, `Messages: ${options.history.length}`);
  if (options.current) {
    renderInfo(ui, "Viewing the current conversation.");
  }

  if (options.history.length === 0) {
    renderInfo(ui, "No messages yet.");
    return;
  }

  writeBodyLine(ui, "");

  for (const [index, message] of options.history.entries()) {
    const speaker = message.role === "user" ? "You" : "Assistant";
    writeBodyLine(ui, `${index + 1}. ${speaker}`);

    for (const line of message.content.split(/\r?\n/)) {
      writeBodyLine(ui, `   ${line}`);
    }

    if (index < options.history.length - 1) {
      writeBodyLine(ui, "");
    }
  }
}

function renderSystemPromptTips(
  ui: TerminalUI | null,
  currentPrompt: string,
): void {
  if (ui) {
    ui.renderSectionTitle("System Prompt Editor");
  } else {
    console.log("System Prompt Editor");
  }

  renderInfo(ui, "This prompt controls the default behavior for the current conversation.");
  renderInfo(ui, "Saving clears the current conversation and updates the default for future sessions.");
  renderInfo(ui, 'Type the new prompt below. Use "/save" on its own line to persist or "/cancel" to abort.');
  renderInfo(ui, `Current behavior: ${summarizePrompt(currentPrompt)}`);
}

function renderSystemPromptApplied(
  ui: TerminalUI | null,
  session: AgentSession,
  settings: SuperRunSettings,
  historyCleared: boolean,
): void {
  const stats = getAgentSessionStats(session);
  renderInfo(ui, `Saved system prompt to ${settings.filePath}`);
  if (historyCleared) {
    renderInfo(ui, "Conversation history cleared so the new behavior starts cleanly.");
  }
  renderInfo(
    ui,
    `Current history: ${stats.historyTurnCount}/${stats.maxHistoryTurns} turns, ${stats.historyCharCount} chars.`,
  );
  renderInfo(ui, `This agent will now behave as: ${summarizePrompt(settings.systemPrompt)}`);
}

function renderNewSessionCreated(
  ui: TerminalUI | null,
  storedSession: StoredSession,
): void {
  renderInfo(
    ui,
    `Created new session: ${formatSessionLabel(storedSession.title, storedSession.id)}`,
  );
  renderInfo(ui, "Current conversation cleared.");
}

function renderSessionSwitched(
  ui: TerminalUI | null,
  storedSession: StoredSession,
): void {
  const stats = getAgentSessionStats(
    createAgentSession({
      systemPrompt: storedSession.systemPrompt,
      history: storedSession.history,
      maxHistoryTurns: storedSession.maxHistoryTurns,
    }),
  );

  renderInfo(
    ui,
    `Switched to session: ${formatSessionLabel(storedSession.title, storedSession.id)}`,
  );
  renderInfo(
    ui,
    `Current history: ${stats.historyTurnCount}/${stats.maxHistoryTurns} turns, ${stats.historyCharCount} chars.`,
  );
  renderInfo(ui, storedSession.preview);
  renderInfo(ui, `This agent will now behave as: ${summarizePrompt(storedSession.systemPrompt)}`);
}

function renderSessionDeleted(
  ui: TerminalUI | null,
  sessionId: string,
): void {
  renderInfo(ui, `Deleted session: ${sessionId}`);
}

function renderSessionDeletedAndSwitched(
  ui: TerminalUI | null,
  deletedSessionId: string,
  nextSession: StoredSession,
): void {
  renderInfo(ui, `Deleted session: ${deletedSessionId}`);
  renderSessionSwitched(ui, nextSession);
}

function renderSessionRenamed(
  ui: TerminalUI | null,
  state: InteractiveState,
): void {
  renderInfo(
    ui,
    `Renamed session: ${formatSessionLabel(
      state.currentSessionTitle,
      state.currentSessionId,
    )}`,
  );
}

function renderInfo(ui: TerminalUI | null, message: string): void {
  if (ui) {
    ui.renderInfo(message);
    return;
  }

  console.log(message);
}

function renderError(ui: TerminalUI | null, message: string): void {
  if (ui) {
    ui.renderError(message);
    return;
  }

  console.error(`error: ${message}`);
}

function writeBodyLine(ui: TerminalUI | null, message: string): void {
  if (ui) {
    output.write(`${message}\n`);
    return;
  }

  console.log(message);
}

function summarizePrompt(prompt: string): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 96) {
    return singleLine;
  }

  return `${singleLine.slice(0, 93)}...`;
}

function formatSessionLabel(
  title: string | null,
  sessionId: string | null,
): string {
  if (!sessionId) {
    return "(unsaved)";
  }

  if (!title) {
    return sessionId;
  }

  return `${title} [${sessionId}]`;
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return parsed.toISOString().replace("T", " ").slice(0, 16);
}

function restoreStoredSession(
  session: AgentSession,
  storedSession: StoredSession,
): void {
  session.systemPrompt = storedSession.systemPrompt;
  session.history = [...storedSession.history];
  session.maxHistoryTurns = storedSession.maxHistoryTurns;
}

async function persistCurrentSession(
  session: AgentSession,
  state: InteractiveState,
  options?: { allowEmpty?: boolean; title?: string },
): Promise<void> {
  if (!options?.allowEmpty && session.history.length === 0) {
    return;
  }

  const sessionTitle = options?.title?.trim() || state.currentSessionTitle || undefined;

  if (state.currentSessionId) {
    const result = await saveSession(state.currentSessionId, {
      ...(sessionTitle ? { title: sessionTitle } : {}),
      systemPrompt: session.systemPrompt,
      history: session.history,
      maxHistoryTurns: session.maxHistoryTurns,
    });
    state.sessionStore = result.store;
    state.currentSessionId = result.session.id;
    state.currentSessionTitle = result.session.title;
    return;
  }

  const result = await createSession({
    ...(sessionTitle ? { title: sessionTitle } : {}),
    systemPrompt: session.systemPrompt,
    history: session.history,
    maxHistoryTurns: session.maxHistoryTurns,
  });
  state.sessionStore = result.store;
  state.currentSessionId = result.session.id;
  state.currentSessionTitle = result.session.title;
}

function parseCommandArgument(
  prompt: string,
  command: string,
): string {
  if (prompt === command) {
    return "";
  }

  return prompt.slice(command.length).trim();
}

function isExitCommand(prompt: string): boolean {
  return EXIT_COMMANDS.has(prompt.trim());
}

function matchesCommand(prompt: string, command: string): boolean {
  return prompt === command || prompt.startsWith(`${command} `);
}

function resolveSessionSelector(
  selector: string,
  state: InteractiveState,
): SessionSummary {
  const trimmedSelector = selector.trim();

  // Numeric selectors map to the current /sessions list order for quick TUI switching.
  if (/^\d+$/.test(trimmedSelector)) {
    const index = Number(trimmedSelector);
    const sessionSummary = state.sessionStore.sessions[index - 1];
    if (!sessionSummary) {
      throw new Error(`Session index is out of range: ${trimmedSelector}`);
    }

    return sessionSummary;
  }

  const sessionSummary = state.sessionStore.sessions.find(
    (candidate) => candidate.id === trimmedSelector,
  );
  if (!sessionSummary) {
    const titleMatches = state.sessionStore.sessions.filter(
      (candidate) => candidate.title === trimmedSelector,
    );
    if (titleMatches.length === 1) {
      return titleMatches[0] as SessionSummary;
    }

    if (titleMatches.length > 1) {
      throw new Error(`Session title is ambiguous: ${trimmedSelector}`);
    }

    throw new Error(`Session does not exist: ${trimmedSelector}`);
  }

  return sessionSummary;
}

async function runSessionPicker(
  ui: TerminalUI,
  state: InteractiveState,
): Promise<SessionSummary | null> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return null;
  }

  emitKeypressEvents(input);
  return runSessionPickerInteraction({
    ui,
    input,
    sessions: state.sessionStore.sessions,
    currentSessionId: state.currentSessionId,
  });
}
