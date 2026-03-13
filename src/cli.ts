import "dotenv/config";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import { select } from "@inquirer/prompts";
import {
  type AgentSession,
  createAgentSession,
  getAgentSessionStats,
  runAgentTurn,
} from "./agent/loop.js";
import {
  getAgentModeSummary,
  parseAgentMode,
  type AgentMode,
} from "./agent/mode.js";
import {
  loadSettings,
  resetSystemPrompt,
  saveSystemPrompt,
  type SuperRunSettings,
} from "./config/settings.js";
import {
  createSession,
  deleteAllSessions,
  deleteSession,
  loadSession,
  loadSessionStore,
  saveSession,
  setActiveSession,
  type SessionSummary,
  type SessionStoreState,
  type StoredSession,
} from "./session/store.js";
import {
  getCommandApprovalSummary,
  parseCommandApprovalMode,
} from "./tools/command_policy.js";
import { createEnvCommandHookRunner } from "./tools/command_hooks.js";
import type {
  CommandApprovalDecision,
  CommandApprovalMode,
  CommandApprovalRequest,
  ToolExecutionContext,
} from "./tools/types.js";
import { loadWorkspaceFilePaths } from "./ui/file-reference.js";
import { editSystemPromptExternally } from "./ui/external-editor.js";
import {
  createInteractiveRenderer,
  type InteractiveRenderer,
  type RendererLine,
} from "./ui/interactive-renderer.js";
import { isPromptExitError } from "./ui/inquirer-errors.js";
import { runModePickerInteraction } from "./ui/mode-picker-controller.js";
import { runSessionPickerInteraction } from "./ui/session-picker-controller.js";

export const program = new Command();

program
  .name("superrun")
  .description("A coding agent CLI")
  .addOption(
    new Option(
      "--mode <mode>",
      'agent tool mode: "default" enables guarded command execution, "strict" keeps only specialized read-only tools',
    )
      .choices(["default", "strict"])
      .default("default"),
  )
  .addOption(
    new Option(
      "--approvals <mode>",
      'command approval mode: "ask" prompts before non-read-only commands, "allow-all" auto-approves, "reject" disables command execution',
    )
      .choices(["ask", "allow-all", "reject"])
      .default("ask"),
  )
  .argument("[prompt]", "prompt to send to the model")
  .action(async (prompt?: string) => {
    try {
      const settings = await loadSettings();
      const options = program.opts<{
        mode: AgentMode;
        approvals: CommandApprovalMode;
      }>();
      const mode = parseAgentMode(options.mode);
      const approvalMode = parseCommandApprovalMode(options.approvals);
      const session = createAgentSession({
        mode,
        systemPrompt: settings.systemPrompt,
      });
      const trimmedPrompt = prompt?.trim();

      if (trimmedPrompt) {
        renderRiskNotice();
        await runSingleTurn(session, trimmedPrompt, {
          commandApprovalMode: approvalMode,
          commandHookRunner: createEnvCommandHookRunner(),
          settings,
          sessionStore: {
            sessions: [],
            activeSessionId: null,
            indexFilePath: "",
            sessionsDirectoryPath: "",
          },
          currentSessionId: null,
          currentSessionTitle: null,
          pendingDeleteAllConfirmation: false,
          pendingSystemPromptLines: null,
          workspaceFiles: null,
        });
        return;
      }

      if (!(input.isTTY && output.isTTY)) {
        renderRiskNotice();
      }

      const state = await createInteractiveState(settings, session, approvalMode);
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
  pendingDeleteAllConfirmation: boolean;
  pendingSystemPromptLines: string[] | null;
  workspaceFiles: string[] | null;
  commandApprovalMode: CommandApprovalMode;
  commandHookRunner: ReturnType<typeof createEnvCommandHookRunner>;
};

const EXIT_COMMANDS = new Set(["/exit", "exit", "exit()"]);

async function createInteractiveState(
  settings: SuperRunSettings,
  session: AgentSession,
  approvalMode: CommandApprovalMode,
): Promise<InteractiveState> {
  let sessionStore = await loadSessionStore();
  let currentSessionId: string | null = null;
  const commandHookRunner = createEnvCommandHookRunner();

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
        pendingDeleteAllConfirmation: false,
        pendingSystemPromptLines: null,
        workspaceFiles: null,
        commandApprovalMode: approvalMode,
        commandHookRunner,
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
    pendingDeleteAllConfirmation: false,
    pendingSystemPromptLines: null,
    workspaceFiles: null,
    commandApprovalMode: approvalMode,
    commandHookRunner,
  };
}

async function runSingleTurn(
  session: AgentSession,
  prompt: string,
  state: InteractiveState,
): Promise<void> {
  console.log("user:", prompt);
  process.stdout.write("assistant: ");

  const reply = await runAgentTurn(session, prompt, {
    toolContext: createToolExecutionContext(state, null),
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
  const ui = input.isTTY && output.isTTY
    ? createInteractiveRenderer({ input, output })
    : null;

  if (ui) {
    renderInteractiveShell(ui, session, state);
  } else {
    console.log('Interactive mode. Type "/exit" to quit.');
    renderApprovalSummary(ui, state.commandApprovalMode);
    renderSessionPromptHint(ui, session, state.settings);
    renderSessionStoreHint(ui, state);
  }

  if (ui) {
    try {
      while (true) {
        const prompt = await ui.readPrompt({
        promptLabel: getTTYPromptLabel(ui, state),
        workspaceFiles: state.pendingSystemPromptLines
          ? []
          : await ensureWorkspaceFilesLoaded(state),
      });

        if (!(await handleInteractiveInput(session, prompt, state, ui))) {
          break;
        }
      }
    } finally {
      ui.dispose();
    }

    return;
  }

  const rl = createInterface({ input, output });
  try {
    for await (const line of rl) {
      if (!(await handleInteractiveInput(session, line, state, ui))) {
        break;
      }
    }
  } finally {
    rl.close();
  }
}

async function handleInteractiveInput(
  session: AgentSession,
  line: string,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
): Promise<boolean> {
  if (state.pendingDeleteAllConfirmation) {
    return handleDeleteAllConfirmationLine(session, line, state, ui);
  }

  // Keep `/system` editing in the main input loop so TTY and piped flows behave the same way.
  if (state.pendingSystemPromptLines) {
    return handleSystemPromptEditorLine(session, line, state, ui);
  }

  const prompt = line.trim();
  if (prompt === "/system") {
    state.pendingSystemPromptLines = [];
    renderSystemPromptTips(ui, session.systemPrompt, "inline");
    return true;
  }

  return handleInteractivePrompt(session, prompt, state, ui);
}

async function handleInteractivePrompt(
  session: AgentSession,
  prompt: string,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
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
      console.log("Commands: /help /mode [default|strict] /approvals [ask|allow-all|reject] /settings /session /history [id|index|title] /sessions [query] /new /switch <id|index|title> /rename <title> /delete [id|index|title|all] /system /editor /system reset /clear /exit");
    }
    return true;
  }

  if (matchesCommand(prompt, "/mode")) {
    const requestedMode = parseCommandArgument(prompt, "/mode");

    if (ui && !requestedMode) {
      const selectedMode = await runModePicker(session.mode, ui);
      renderInteractiveShell(ui, session, state);
      if (selectedMode) {
        session.mode = selectedMode;
        renderAgentModeChanged(ui, selectedMode);
      }
      return true;
    }

    if (!requestedMode) {
      renderAgentModeSummary(ui, session.mode);
      return true;
    }

    try {
      const nextMode = parseAgentMode(requestedMode);
      session.mode = nextMode;
      renderAgentModeChanged(ui, nextMode);
    } catch (error) {
      renderError(ui, error instanceof Error ? error.message : "Failed to change mode.");
    }
    return true;
  }

  if (matchesCommand(prompt, "/approvals")) {
    const requestedMode = parseCommandArgument(prompt, "/approvals");

    if (ui && !requestedMode) {
      const selectedMode = await runApprovalPicker(state.commandApprovalMode, ui);
      renderInteractiveShell(ui, session, state);
      if (selectedMode) {
        state.commandApprovalMode = selectedMode;
        renderApprovalSummary(ui, state.commandApprovalMode);
      }
      return true;
    }

    if (!requestedMode) {
      renderApprovalSummary(ui, state.commandApprovalMode);
      return true;
    }

    try {
      state.commandApprovalMode = parseCommandApprovalMode(requestedMode);
      renderApprovalSummary(ui, state.commandApprovalMode);
    } catch (error) {
      renderError(ui, error instanceof Error ? error.message : "Failed to change approvals.");
    }
    return true;
  }

  if (prompt === "/settings") {
    renderSettingsSummary(ui, session, state.settings);
    renderApprovalSummary(ui, state.commandApprovalMode);
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

  if (matchesCommand(prompt, "/sessions")) {
    const filterQuery = parseCommandArgument(prompt, "/sessions");
    const filteredSessions = filterSessionSummaries(
      state.sessionStore.sessions,
      filterQuery,
    );

    if (ui) {
      const selectedSession = await runSessionPicker(state, ui, {
        sessions: filteredSessions,
        filterQuery,
      });

      try {
        if (selectedSession) {
          const storedSession = await loadSession(selectedSession.id);
          restoreStoredSession(session, storedSession);
          state.currentSessionId = storedSession.id;
          state.currentSessionTitle = storedSession.title;
          state.sessionStore = await setActiveSession(storedSession.id);
          renderInteractiveShell(ui, session, state);
          renderSessionSwitched(ui, storedSession, session.mode);
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

    renderSessionList(ui, state, {
      sessions: filteredSessions,
      filterQuery,
    });
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
      renderSessionSwitched(ui, storedSession, session.mode);
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
    if (sessionSelector.toLowerCase() === "all") {
      if (state.sessionStore.sessions.length === 0) {
        renderInfo(ui, "No saved sessions to delete.");
        return true;
      }

      state.pendingDeleteAllConfirmation = true;
      renderDeleteAllConfirmationPrompt(ui, state.sessionStore.sessions.length);
      return true;
    }

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
        renderSessionDeletedAndSwitched(
          ui,
          targetSessionId,
          activeSession,
          session.mode,
        );
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

  if (prompt === "/editor") {
    await runExternalSystemPromptEditor(session, state, ui);
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
    toolContext: createToolExecutionContext(state, ui),
    onChunk: (chunk) => {
      if (ui) {
        ui.appendAssistantChunk(chunk);
        return;
      }

      process.stdout.write(chunk);
    },
  });

  await persistCurrentSession(session, state);

  if (!reply) {
    if (ui) {
      ui.appendAssistantChunk("(empty response)");
    } else {
      process.stdout.write("(empty response)");
    }
  }

  if (!ui) {
    process.stdout.write("\n");
  }
  return true;
}

async function handleDeleteAllConfirmationLine(
  session: AgentSession,
  line: string,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
): Promise<boolean> {
  state.pendingDeleteAllConfirmation = false;
  const confirmation = line.trim();

  if (confirmation === "/cancel") {
    renderInfo(ui, "Delete-all cancelled.");
    return true;
  }

  if (confirmation !== "YES") {
    renderInfo(ui, 'Delete-all cancelled. Type "YES" exactly to confirm.');
    return true;
  }

  const deletedCount = state.sessionStore.sessions.length;
  const deletedCurrentSession = state.currentSessionId !== null;
  state.sessionStore = await deleteAllSessions();

  if (deletedCurrentSession) {
    resetCurrentSession(session, state.settings.systemPrompt);
    state.currentSessionId = null;
    state.currentSessionTitle = null;
  }

  renderAllSessionsDeleted(ui, deletedCount, deletedCurrentSession);
  return true;
}

async function handleSystemPromptEditorLine(
  session: AgentSession,
  line: string,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
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

  if (trimmedLine === "/editor") {
    if (!input.isTTY || !output.isTTY) {
      renderError(ui, '"/editor" requires an interactive terminal.');
      return true;
    }

    const draftPrompt = getPendingSystemPromptDraft(pendingLines, session.systemPrompt);
    state.pendingSystemPromptLines = null;
    await runExternalSystemPromptEditor(session, state, ui, draftPrompt);
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

async function runExternalSystemPromptEditor(
  session: AgentSession,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
  initialPrompt = session.systemPrompt,
): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    renderError(ui, '"/editor" requires an interactive terminal.');
    return;
  }

  renderSystemPromptTips(ui, initialPrompt, "external");

  try {
    const result = ui
      ? await runWithSuspendedRenderer(ui, () => editSystemPromptExternally(initialPrompt))
      : await editSystemPromptExternally(initialPrompt);
    if (ui) {
      renderInteractiveShell(ui, session, state);
    }

    if (result.status === "unchanged") {
      renderInfo(ui, "System prompt unchanged. Keeping current behavior.");
      return;
    }

    const settings = await saveSystemPrompt(result.value);
    state.settings = settings;
    resetCurrentSession(session, settings.systemPrompt);
    await persistCurrentSession(session, state, { allowEmpty: true });
    renderSystemPromptApplied(ui, session, settings, true);
  } catch (error) {
    if (ui) {
      renderInteractiveShell(ui, session, state);
    }

    renderError(
      ui,
      error instanceof Error
        ? error.message
        : "Failed to update the system prompt from the external editor.",
    );
    return;
  }
}

function resetCurrentSession(
  session: AgentSession,
  systemPrompt: string,
): void {
  session.systemPrompt = systemPrompt;
  session.history = [];
}

function getTTYPromptLabel(
  ui: InteractiveRenderer,
  state: InteractiveState,
): string {
  return state.pendingSystemPromptLines
    ? ui.editorPromptLabel
    : ui.promptLabel;
}

function getPendingSystemPromptDraft(
  lines: string[],
  currentPrompt: string,
): string {
  const draft = lines.join("\n").trim();
  return draft || currentPrompt;
}

function buildInteractiveShellFrame(
  session: AgentSession,
  state: InteractiveState,
): Array<Omit<RendererLine, "id">> {
  const stats = getAgentSessionStats(session);
  const source = state.settings.hasStoredSystemPrompt
    ? "saved profile"
    : "built-in default";
  const lines: Array<Omit<RendererLine, "id">> = [
    { kind: "section", text: "SuperRun" },
    { kind: "info", text: "Local coding agent interactive mode" },
    {
      kind: "info",
      text: "Commands: /help /mode /approvals /history /sessions /new /switch /rename /delete /system /editor /clear /exit",
    },
    { kind: "body", text: "" },
    {
      kind: "warning",
      text: "Risk notice: this agent may read, run, modify, delete, or create files in the workspace. Keep backups.",
    },
    {
      kind: "warning",
      text: "Using SuperRun means you accept that risk. It will try to approve and intercept risky actions, but it cannot guarantee complete safety.",
    },
    {
      kind: "warning",
      text: "Recommendation: initialize git in the workspace so you have a recovery path for your files.",
    },
    { kind: "body", text: "" },
    {
      kind: "info",
      text: `Command approvals: ${getCommandApprovalSummary(state.commandApprovalMode)}.`,
    },
    {
      kind: "info",
      text: `Tool mode: ${getAgentModeSummary(session.mode)}.`,
    },
    {
      kind: "info",
      text: `Active behavior (${source}): ${summarizePrompt(session.systemPrompt)}`,
    },
    {
      kind: "info",
      text: `History: ${stats.historyTurnCount}/${stats.maxHistoryTurns} turns, ${stats.historyCharCount} chars.`,
    },
    {
      kind: "info",
      text: 'Use "/approvals" to review command approval behavior.',
    },
    {
      kind: "info",
      text: 'Use "/system" to change the default behavior for new work.',
    },
    { kind: "body", text: "" },
  ];

  if (state.currentSessionId) {
    lines.push({
      kind: "info",
      text: `Current session: ${formatSessionLabel(state.currentSessionTitle, state.currentSessionId)}. Saved sessions: ${state.sessionStore.sessions.length}.`,
    });
    lines.push({
      kind: "info",
      text: 'Use "/sessions" to browse saved work, or "/new" to start fresh.',
    });
  } else if (state.sessionStore.sessions.length === 0) {
    lines.push({
      kind: "info",
      text: 'No saved sessions yet. Start chatting or use "/new" to create one now.',
    });
  } else {
    lines.push({
      kind: "info",
      text: `Saved sessions: ${state.sessionStore.sessions.length}. Active session is not loaded.`,
    });
    lines.push({
      kind: "info",
      text: 'Use "/sessions" to browse them or "/switch <index>" to load one.',
    });
  }

  lines.push({ kind: "body", text: "" });
  return lines;
}

function renderInteractiveShell(
  ui: InteractiveRenderer,
  session: AgentSession,
  state: InteractiveState,
): void {
  ui.clearScreen();
  ui.setShellFrame(buildInteractiveShellFrame(session, state));
}

function renderSessionPromptHint(
  ui: InteractiveRenderer | null,
  session: AgentSession,
  settings: Pick<SuperRunSettings, "systemPrompt" | "hasStoredSystemPrompt">,
): void {
  const stats = getAgentSessionStats(session);
  const source = settings.hasStoredSystemPrompt ? "saved profile" : "built-in default";
  renderInfo(ui, `Tool mode: ${getAgentModeSummary(session.mode)}.`);
  renderInfo(
    ui,
    `Active behavior (${source}): ${summarizePrompt(session.systemPrompt)}`,
  );
  renderInfo(
    ui,
    `History: ${stats.historyTurnCount}/${stats.maxHistoryTurns} turns, ${stats.historyCharCount} chars.`,
  );
  renderInfo(ui, 'Use "/approvals" to review command approval behavior.');
  renderInfo(ui, 'Use "/system" to change the default behavior for new work.');
}

function renderSessionStoreHint(
  ui: InteractiveRenderer | null,
  state: InteractiveState,
): void {
  const currentSessionId = state.currentSessionId;

  if (currentSessionId) {
    renderInfo(
      ui,
      `Current session: ${formatSessionLabel(state.currentSessionTitle, currentSessionId)}. Saved sessions: ${state.sessionStore.sessions.length}.`,
    );
    renderInfo(ui, 'Use "/sessions" to browse saved work, or "/new" to start fresh.');
    return;
  }

  if (state.sessionStore.sessions.length === 0) {
    renderInfo(ui, 'No saved sessions yet. Start chatting or use "/new" to create one now.');
    return;
  }

  renderInfo(
    ui,
    `Saved sessions: ${state.sessionStore.sessions.length}. Active session is not loaded.`,
  );
  renderInfo(ui, 'Use "/sessions" to browse them or "/switch <index>" to load one.');
}

function renderSettingsSummary(
  ui: InteractiveRenderer | null,
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
  renderInfo(ui, `Tool mode: ${getAgentModeSummary(session.mode)}.`);
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

  for (const line of settings.systemPrompt.split(/\r?\n/)) {
    writeBodyLine(ui, line);
  }
}

function renderRiskNotice(ui: InteractiveRenderer | null = null): void {
  const write = ui
    ? (message: string) => ui.renderWarning(message)
    : (message: string) => console.log(message);

  write(
    "Risk notice: this agent may read, run, modify, delete, or create files in the workspace. Keep backups.",
  );
  write(
    "Using SuperRun means you accept that risk. It will try to approve and intercept risky actions, but it cannot guarantee complete safety.",
  );
  write(
    "Recommendation: initialize git in the workspace so you have a recovery path for your files.",
  );
}

function renderApprovalSummary(
  ui: InteractiveRenderer | null,
  mode: CommandApprovalMode,
): void {
  renderInfo(ui, `Command approvals: ${getCommandApprovalSummary(mode)}.`);
}

function renderCurrentSessionSummary(
  ui: InteractiveRenderer | null,
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
  renderInfo(ui, `Mode: ${getAgentModeSummary(session.mode)}.`);
  renderInfo(ui, `Command approvals: ${getCommandApprovalSummary(state.commandApprovalMode)}.`);
  renderInfo(
    ui,
    `Current session: ${currentStats.historyTurnCount} turns, ${currentStats.historyMessageCount} messages, ${currentStats.historyCharCount} chars.`,
  );
  renderInfo(ui, `Current behavior: ${summarizePrompt(session.systemPrompt)}`);
  renderInfo(ui, `Session index: ${state.sessionStore.indexFilePath}`);
  renderInfo(ui, `Saved sessions total: ${state.sessionStore.sessions.length}`);
}

function renderSessionList(
  ui: InteractiveRenderer | null,
  state: InteractiveState,
  options?: {
    sessions?: SessionSummary[];
    filterQuery?: string;
  },
): void {
  const sessions = options?.sessions ?? state.sessionStore.sessions;
  const filterQuery = normalizeText(options?.filterQuery);

  if (ui) {
    ui.renderSectionTitle("Sessions");
  } else {
    console.log("Sessions");
  }

  if (sessions.length === 0) {
    renderInfo(
      ui,
      filterQuery
        ? `No saved sessions match "${filterQuery}".`
        : "No saved sessions.",
    );
    return;
  }

  if (filterQuery) {
    renderInfo(
      ui,
      `Filter: "${filterQuery}" (${sessions.length} match${sessions.length === 1 ? "" : "es"}).`,
    );
  }

  renderInfo(
    ui,
    'Use "/switch <index>", "/switch <id>", or "/switch <title>" to load a session.',
  );

  for (const sessionSummary of sessions) {
    const marker = sessionSummary.id === state.currentSessionId ? "*" : " ";
    const displayIndex = state.sessionStore.sessions.findIndex(
      (candidate) => candidate.id === sessionSummary.id,
    ) + 1;
    renderInfo(
      ui,
      `${marker} ${displayIndex}. ${sessionSummary.title} [${sessionSummary.id}]  ${sessionSummary.turnCount} turns  ${sessionSummary.charCount} chars  ${formatTimestamp(sessionSummary.updatedAt)}`,
    );
    renderInfo(ui, `    ${sessionSummary.preview}`);
  }
}

function renderHistory(
  ui: InteractiveRenderer | null,
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
  ui: InteractiveRenderer | null,
  currentPrompt: string,
  mode: "inline" | "external",
): void {
  if (ui) {
    ui.renderSectionTitle("System Prompt Editor");
  } else {
    console.log("System Prompt Editor");
  }

  renderInfo(ui, "This prompt controls the default behavior for the current conversation.");
  renderInfo(ui, "Saving clears the current conversation and updates the default for future sessions.");
  renderInfo(
    ui,
    mode === "external"
      ? "An external editor will open with the current prompt. Close it to auto-apply non-empty changes; leaving the text unchanged cancels the update."
      : 'Type the new prompt below. Use "/save" on its own line to persist or "/cancel" to abort. Use "/editor" to open your external editor, which auto-applies non-empty changes when it closes.',
  );
  renderInfo(ui, `Current behavior: ${summarizePrompt(currentPrompt)}`);
}

function renderSystemPromptApplied(
  ui: InteractiveRenderer | null,
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
  ui: InteractiveRenderer | null,
  storedSession: StoredSession,
): void {
  renderInfo(
    ui,
    `Created new session: ${formatSessionLabel(storedSession.title, storedSession.id)}`,
  );
  renderInfo(ui, "Current conversation cleared.");
}

function renderSessionSwitched(
  ui: InteractiveRenderer | null,
  storedSession: StoredSession,
  mode: AgentMode,
): void {
  const stats = getAgentSessionStats(
    createAgentSession({
      mode,
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
  renderInfo(ui, `Mode: ${getAgentModeSummary(mode)}.`);
  renderInfo(ui, storedSession.preview);
  renderInfo(ui, `This agent will now behave as: ${summarizePrompt(storedSession.systemPrompt)}`);
}

function renderSessionDeleted(
  ui: InteractiveRenderer | null,
  sessionId: string,
): void {
  renderInfo(ui, `Deleted session: ${sessionId}`);
}

function renderDeleteAllConfirmationPrompt(
  ui: InteractiveRenderer | null,
  sessionCount: number,
): void {
  renderInfo(
    ui,
    `Delete all saved sessions (${sessionCount})? Type "YES" to confirm or "/cancel" to abort.`,
  );
}

function renderAllSessionsDeleted(
  ui: InteractiveRenderer | null,
  deletedCount: number,
  clearedCurrentSession: boolean,
): void {
  renderInfo(ui, `Deleted all saved sessions: ${deletedCount}`);
  if (clearedCurrentSession) {
    renderInfo(ui, "Current conversation reset because its saved session was deleted.");
  }
}

function renderSessionDeletedAndSwitched(
  ui: InteractiveRenderer | null,
  deletedSessionId: string,
  nextSession: StoredSession,
  mode: AgentMode,
): void {
  renderInfo(ui, `Deleted session: ${deletedSessionId}`);
  renderSessionSwitched(ui, nextSession, mode);
}

function renderSessionRenamed(
  ui: InteractiveRenderer | null,
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

function renderAgentModeSummary(
  ui: InteractiveRenderer | null,
  mode: AgentMode,
): void {
  renderInfo(ui, `Current tool mode: ${getAgentModeSummary(mode)}.`);
  renderInfo(
    ui,
    'Use "/mode strict" for specialized read-only tools, or "/mode default" to re-enable command execution.',
  );
}

function renderAgentModeChanged(
  ui: InteractiveRenderer | null,
  mode: AgentMode,
): void {
  renderInfo(ui, `Tool mode changed to ${getAgentModeSummary(mode)}.`);
}

function renderInfo(ui: InteractiveRenderer | null, message: string): void {
  if (ui) {
    ui.renderInfo(message);
    return;
  }

  console.log(message);
}

function renderError(ui: InteractiveRenderer | null, message: string): void {
  if (ui) {
    ui.renderError(message);
    return;
  }

  console.error(`error: ${message}`);
}

function writeBodyLine(ui: InteractiveRenderer | null, message: string): void {
  if (ui) {
    ui.writeBodyLine(message);
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
  state: InteractiveState,
  ui: InteractiveRenderer,
  options?: {
    sessions?: SessionSummary[];
    filterQuery?: string | undefined;
  },
): Promise<SessionSummary | null> {
  if (!input.isTTY || !output.isTTY) {
    return null;
  }

  return runWithSuspendedRenderer(ui, () =>
    runSessionPickerInteraction({
      sessions: options?.sessions ?? state.sessionStore.sessions,
      currentSessionId: state.currentSessionId,
      filterQuery: options?.filterQuery,
    }),
  );
}

async function runModePicker(
  currentMode: AgentMode,
  ui: InteractiveRenderer,
): Promise<AgentMode | null> {
  if (!input.isTTY || !output.isTTY) {
    return null;
  }

  return runWithSuspendedRenderer(ui, () =>
    runModePickerInteraction({
      currentMode,
    }),
  );
}

async function runApprovalPicker(
  currentMode: CommandApprovalMode,
  ui: InteractiveRenderer,
): Promise<CommandApprovalMode | null> {
  if (!input.isTTY || !output.isTTY) {
    return null;
  }

  return runWithSuspendedRenderer(ui, async () => {
    try {
      return await select<CommandApprovalMode | null>({
        message: "Choose the command approval mode",
        choices: [
          {
            value: "ask",
            name: currentMode === "ask" ? "ask (current)" : "ask",
            description: "Auto-run read-only commands and prompt before other shell execution.",
          },
          {
            value: "allow-all",
            name: currentMode === "allow-all" ? "allow-all (current)" : "allow-all",
            description: "Auto-approve command execution for the current process.",
          },
          {
            value: "reject",
            name: currentMode === "reject" ? "reject (current)" : "reject",
            description: "Block run_command entirely for the current process.",
          },
          {
            value: null,
            name: "Keep current approvals",
            description: "Return to chat without changing the approval mode.",
          },
        ],
        pageSize: 4,
      });
    } catch (error) {
      if (isPromptExitError(error)) {
        return null;
      }

      throw error;
    }
  });
}

function createToolExecutionContext(
  state: InteractiveState,
  ui: InteractiveRenderer | null,
): ToolExecutionContext {
  const requestApproval =
    input.isTTY && output.isTTY
      ? (request: CommandApprovalRequest) => promptCommandApproval(request, ui)
      : undefined;

  return {
    commandPolicy: {
      getMode: () => state.commandApprovalMode,
      setMode: (mode) => {
        state.commandApprovalMode = mode;
      },
      ...(requestApproval ? { requestApproval } : {}),
      ...(state.commandHookRunner ? { runHook: state.commandHookRunner } : {}),
    },
  };
}

async function promptCommandApproval(
  request: CommandApprovalRequest,
  ui: InteractiveRenderer | null,
): Promise<CommandApprovalDecision> {
  const { assessment } = request;
  const reasonSummary = assessment.reasons.join(" ");
  const runPrompt = async () => {
    try {
      return await select<CommandApprovalDecision>({
        message: `Approve ${assessment.category} command?`,
        choices: [
          {
            value: "once",
            name: "Approve once",
            description: `${assessment.summary}. ${reasonSummary}`,
          },
          {
            value: "always",
            name: "Allow all this session",
            description: "Switch approvals to allow-all for subsequent commands in this process.",
          },
          {
            value: "reject",
            name: "Reject",
            description: `Block this command: ${assessment.command}`,
          },
        ],
        pageSize: 3,
      });
    } catch (error) {
      if (isPromptExitError(error)) {
        return "reject";
      }

      throw error;
    }
  };

  if (ui) {
    return runWithSuspendedRenderer(ui, runPrompt);
  }

  return runPrompt();
}

async function runWithSuspendedRenderer<T>(
  ui: InteractiveRenderer,
  action: () => Promise<T>,
): Promise<T> {
  ui.suspend();
  try {
    return await action();
  } finally {
    ui.resume();
  }
}

async function ensureWorkspaceFilesLoaded(
  state: InteractiveState,
): Promise<string[]> {
  if (state.workspaceFiles) {
    return state.workspaceFiles;
  }

  state.workspaceFiles = await loadWorkspaceFilePaths(process.cwd());
  return state.workspaceFiles;
}

function filterSessionSummaries(
  sessions: SessionSummary[],
  query: string,
): SessionSummary[] {
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery) {
    return sessions;
  }

  return sessions.filter((session) => {
    const searchableText = `${session.title}\n${session.preview}`.toLowerCase();
    return searchableText.includes(normalizedQuery);
  });
}

function normalizeText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}
