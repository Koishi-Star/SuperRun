import "dotenv/config";
import { stdin as input, stdout as output } from "node:process";
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
  clearSavedSession,
  loadSavedSession,
  saveSession,
  type SavedSession,
  type SavedSessionState,
} from "./session/store.js";
import { createTerminalUI, type TerminalUI } from "./ui/tui.js";

export const program = new Command();

program
  .name("superrun")
  .description("A coding agent CLI")
  .argument("[prompt]", "prompt to send to the model")
  .action(async (prompt?: string) => {
    try {
      const settings = await loadSettings();
      const savedSessionState = await loadSavedSession();
      const session = createAgentSession({
        systemPrompt: settings.systemPrompt,
      });
      const trimmedPrompt = prompt?.trim();

      if (trimmedPrompt) {
        await runSingleTurn(session, trimmedPrompt);
        return;
      }

      await runInteractiveSession(session, settings, savedSessionState);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      console.error("error:", message);
      process.exitCode = 1;
    }
  });

type InteractiveState = {
  settings: SuperRunSettings;
  savedSession: SavedSession | null;
  savedSessionFilePath: string;
  pendingSystemPromptLines: string[] | null;
};

async function runSingleTurn(
  session: ReturnType<typeof createAgentSession>,
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
  session: ReturnType<typeof createAgentSession>,
  settings: SuperRunSettings,
  savedSessionState: SavedSessionState,
): Promise<void> {
  const rl = createInterface({ input, output });
  const state: InteractiveState = {
    settings,
    savedSession: savedSessionState.session,
    savedSessionFilePath: savedSessionState.filePath,
    pendingSystemPromptLines: null,
  };
  // Keep piped/non-interactive usage plain, but enable a richer prompt in a real terminal.
  const ui = input.isTTY && output.isTTY ? createTerminalUI(output) : null;

  if (ui) {
    ui.renderWelcome();
    renderSessionPromptHint(ui, session, state.settings);
    renderSavedSessionHint(ui, state.savedSession);
  } else {
    console.log('Interactive mode. Type "/exit" to quit.');
    renderSessionPromptHint(ui, session, state.settings);
    renderSavedSessionHint(ui, state.savedSession);
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
  session: ReturnType<typeof createAgentSession>,
  prompt: string,
  rl: Interface,
  state: InteractiveState,
  ui: TerminalUI | null,
): Promise<boolean> {
  if (!prompt) {
    return true;
  }

  if (prompt === "/exit") {
    return false;
  }

  // Handle local UI commands before sending anything to the model.
  if (prompt === "/help") {
    if (ui) {
      ui.renderCommands();
    } else {
      console.log("Commands: /help /settings /session /resume /forget /system /system reset /clear /exit");
    }
    return true;
  }

  if (prompt === "/settings") {
    renderSettingsSummary(ui, session, state.settings);
    return true;
  }

  if (prompt === "/session") {
    renderSessionSummary(ui, session, state);
    return true;
  }

  if (prompt === "/resume") {
    if (!state.savedSession) {
      renderInfo(ui, "No saved session is available to resume.");
      return true;
    }

    restoreSavedSession(session, state.savedSession);
    renderSessionResumed(ui, state.savedSession);
    return true;
  }

  if (prompt === "/forget") {
    applySystemPrompt(session, state.settings.systemPrompt);
    await clearSavedSessionState(state);
    renderSessionForgotten(ui, state.settings.systemPrompt, state.savedSessionFilePath);
    return true;
  }

  if (prompt === "/system") {
    await runSystemPromptEditor(session, rl, state, ui);
    return true;
  }

  if (prompt === "/system reset") {
    const settings = await resetSystemPrompt();
    applySystemPrompt(session, settings.systemPrompt);
    state.settings = settings;
    await clearSavedSessionState(state);
    renderSystemPromptApplied(ui, session, settings, true);
    return true;
  }

  if (prompt === "/clear") {
    if (ui) {
      ui.clearScreen();
      ui.renderWelcome();
      renderSessionPromptHint(ui, session, state.settings);
    }
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
  session: ReturnType<typeof createAgentSession>,
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
  session: ReturnType<typeof createAgentSession>,
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
    applySystemPrompt(session, settings.systemPrompt);
    state.settings = settings;
    state.pendingSystemPromptLines = null;
    await clearSavedSessionState(state);
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
  session: ReturnType<typeof createAgentSession>,
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
  applySystemPrompt(session, settings.systemPrompt);
  state.settings = settings;
  await clearSavedSessionState(state);
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

function applySystemPrompt(
  session: ReturnType<typeof createAgentSession>,
  systemPrompt: string,
): void {
  session.systemPrompt = systemPrompt;
  // Reset history so new instructions apply to a clean conversation.
  session.history = [];
}

function renderSessionPromptHint(
  ui: TerminalUI | null,
  session: ReturnType<typeof createAgentSession>,
  settings: Pick<SuperRunSettings, "systemPrompt" | "hasStoredSystemPrompt">,
): void {
  const stats = getAgentSessionStats(session);
  const source = settings.hasStoredSystemPrompt ? "saved profile" : "built-in default";
  renderInfo(
    ui,
    `Active behavior (${source}): ${summarizePrompt(settings.systemPrompt)}`,
  );
  renderInfo(
    ui,
    `History: ${stats.historyTurnCount}/${stats.maxHistoryTurns} turns, ${stats.historyCharCount} chars.`,
  );
  renderInfo(ui, 'Use "/system" to change it. Saving a new prompt resets the current conversation.');
  if (ui) {
    output.write("\n");
  }
}

function renderSavedSessionHint(
  ui: TerminalUI | null,
  savedSession: SavedSession | null,
): void {
  if (!savedSession) {
    return;
  }

  const stats = getAgentSessionStats(
    createAgentSession({
      systemPrompt: savedSession.systemPrompt,
      history: savedSession.history,
      maxHistoryTurns: savedSession.maxHistoryTurns,
    }),
  );

  renderInfo(
    ui,
    `Saved session available: ${stats.historyTurnCount} turns, ${stats.historyCharCount} chars, updated ${savedSession.updatedAt}.`,
  );
  renderInfo(ui, 'Use "/resume" to restore it or "/forget" to discard it.');
  if (ui) {
    output.write("\n");
  }
}

function renderSettingsSummary(
  ui: TerminalUI | null,
  session: ReturnType<typeof createAgentSession>,
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
  renderInfo(ui, "Changing it persists the new behavior for future runs and clears the current conversation.");

  const body = `${settings.systemPrompt}\n`;
  if (ui) {
    output.write(body);
  } else {
    process.stdout.write(body);
  }
}

function renderSessionSummary(
  ui: TerminalUI | null,
  session: AgentSession,
  state: InteractiveState,
): void {
  const currentStats = getAgentSessionStats(session);
  const savedSession = state.savedSession;

  if (ui) {
    ui.renderSectionTitle("Session");
  } else {
    console.log("Session");
  }

  renderInfo(
    ui,
    `Current session: ${currentStats.historyTurnCount} turns, ${currentStats.historyMessageCount} messages, ${currentStats.historyCharCount} chars.`,
  );
  renderInfo(
    ui,
    `Current behavior: ${summarizePrompt(session.systemPrompt)}`,
  );
  renderInfo(
    ui,
    `Saved session path: ${state.savedSessionFilePath}`,
  );

  if (!savedSession) {
    renderInfo(ui, "Saved session: none.");
    return;
  }

  const savedStats = getAgentSessionStats(
    createAgentSession({
      systemPrompt: savedSession.systemPrompt,
      history: savedSession.history,
      maxHistoryTurns: savedSession.maxHistoryTurns,
    }),
  );

  renderInfo(
    ui,
    `Saved session: ${savedStats.historyTurnCount} turns, ${savedStats.historyMessageCount} messages, ${savedStats.historyCharCount} chars.`,
  );
  renderInfo(ui, `Saved session updated: ${savedSession.updatedAt}`);
  renderInfo(ui, `Saved behavior: ${summarizePrompt(savedSession.systemPrompt)}`);
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

  renderInfo(ui, "This prompt controls the agent's behavior on every turn.");
  renderInfo(ui, "Saving persists it for future runs and resets the current conversation.");
  renderInfo(ui, 'Type the new prompt below. Use "/save" on its own line to persist or "/cancel" to abort.');
  renderInfo(ui, `Current behavior: ${summarizePrompt(currentPrompt)}`);
}

function renderSystemPromptApplied(
  ui: TerminalUI | null,
  session: ReturnType<typeof createAgentSession>,
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

function renderSessionResumed(
  ui: TerminalUI | null,
  savedSession: SavedSession,
): void {
  const stats = getAgentSessionStats(
    createAgentSession({
      systemPrompt: savedSession.systemPrompt,
      history: savedSession.history,
      maxHistoryTurns: savedSession.maxHistoryTurns,
    }),
  );

  renderInfo(
    ui,
    `Resumed saved session from ${savedSession.updatedAt}.`,
  );
  renderInfo(
    ui,
    `Current history: ${stats.historyTurnCount}/${stats.maxHistoryTurns} turns, ${stats.historyCharCount} chars.`,
  );
  renderInfo(
    ui,
    `This agent will now behave as: ${summarizePrompt(savedSession.systemPrompt)}`,
  );
}

function renderSessionForgotten(
  ui: TerminalUI | null,
  systemPrompt: string,
  filePath: string,
): void {
  renderInfo(ui, `Removed saved session at ${filePath}`);
  renderInfo(ui, "Current conversation cleared.");
  renderInfo(ui, `This agent will now behave as: ${summarizePrompt(systemPrompt)}`);
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

function summarizePrompt(prompt: string): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 96) {
    return singleLine;
  }

  return `${singleLine.slice(0, 93)}...`;
}

function restoreSavedSession(
  session: AgentSession,
  savedSession: SavedSession,
): void {
  session.systemPrompt = savedSession.systemPrompt;
  session.history = [...savedSession.history];
  session.maxHistoryTurns = savedSession.maxHistoryTurns;
}

async function persistCurrentSession(
  session: AgentSession,
  state: InteractiveState,
): Promise<void> {
  if (session.history.length === 0) {
    return;
  }

  state.savedSession = await saveSession({
    systemPrompt: session.systemPrompt,
    history: session.history,
    maxHistoryTurns: session.maxHistoryTurns,
  });
}

async function clearSavedSessionState(
  state: InteractiveState,
): Promise<void> {
  state.savedSessionFilePath = await clearSavedSession();
  state.savedSession = null;
}
