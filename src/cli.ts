import "dotenv/config";
import { stdin as input, stdout as output } from "node:process";
import { Command, Option } from "commander";
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
  createSessionEventTimestamp,
  formatSessionEvent,
  formatWorkspaceEditChangeSummary,
  type SessionEvent,
} from "./session/events.js";
import {
  getCommandApprovalSummary,
  parseCommandApprovalMode,
} from "./tools/command_policy.js";
import { createEnvCommandHookRunner } from "./tools/command_hooks.js";
import {
  emptyWorkspaceTrash,
  getWorkspaceDeleteAreaStatus,
  listWorkspaceTrashEntries,
  purgeWorkspaceFileFromTrash,
  restoreWorkspaceFileFromTrash,
} from "./tools/trash.js";
import type {
  CommandApprovalDecision,
  CommandApprovalMode,
  CommandApprovalRequest,
  ToolTurnEvent,
  ToolExecutionContext,
  WorkspaceEditApprovalRequest,
} from "./tools/types.js";
import {
  createAnsiRichTextStreamWriter,
  formatRichTextToAnsi,
} from "./ui/assistant-rich-text.js";
import { loadWorkspaceFilePaths } from "./ui/file-reference.js";
import { editSystemPromptExternally } from "./ui/external-editor.js";
import {
  createInteractiveRenderer,
  type InteractiveRenderer,
  type RendererPickerOption,
  type RendererLine,
  type RendererViewerLine,
} from "./ui/interactive-renderer.js";
import { buildModePickerChoices } from "./ui/mode-picker.js";
import { buildSessionPickerChoices } from "./ui/session-picker.js";

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
      'approval mode: "ask" prompts before file edits and shell commands, "allow-all" auto-approves ordinary commands but still gates elevated-risk shell actions, "crazy_auto" removes those guardrails, "reject" disables local mutations and command execution',
    )
      .choices(["ask", "allow-all", "crazy_auto", "reject"])
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
          sessionEvents: [],
          deleteAreaStatus: await getWorkspaceDeleteAreaStatus(),
          minCommandPanelDurationMs: DEFAULT_MIN_COMMAND_PANEL_DURATION_MS,
        });
        return;
      }

      if (!(input.isTTY && output.isTTY)) {
        throw new Error(
          'Interactive mode requires a TTY. Run `superrun "<prompt>"` for single-turn use, or start SuperRun from an interactive terminal to use the Ink chat shell.',
        );
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
  sessionEvents: SessionEvent[];
  deleteAreaStatus: {
    fileCount: number;
    totalBytes: number;
  };
  minCommandPanelDurationMs: number;
  commandApprovalMode: CommandApprovalMode;
  commandHookRunner: ReturnType<typeof createEnvCommandHookRunner>;
};

const EXIT_COMMANDS = new Set(["/exit", "exit", "exit()"]);
const DEFAULT_MIN_COMMAND_PANEL_DURATION_MS = 1_000;
const MIN_ALLOWED_COMMAND_PANEL_DURATION_MS = 100;
const MAX_ALLOWED_COMMAND_PANEL_DURATION_MS = 10_000;

async function createInteractiveState(
  settings: SuperRunSettings,
  session: AgentSession,
  approvalMode: CommandApprovalMode,
): Promise<InteractiveState> {
  let sessionStore = await loadSessionStore();
  let currentSessionId: string | null = null;
  const commandHookRunner = createEnvCommandHookRunner();
  const deleteAreaStatus = await getWorkspaceDeleteAreaStatus();

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
        sessionEvents: [...storedSession.events],
        deleteAreaStatus,
        minCommandPanelDurationMs: DEFAULT_MIN_COMMAND_PANEL_DURATION_MS,
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
    sessionEvents: [],
    deleteAreaStatus,
    minCommandPanelDurationMs: DEFAULT_MIN_COMMAND_PANEL_DURATION_MS,
    commandApprovalMode: approvalMode,
    commandHookRunner,
  };
}

async function runSingleTurn(
  session: AgentSession,
  prompt: string,
  state: InteractiveState,
): Promise<void> {
  const turnEvents: ToolTurnEvent[] = [];
  const assistantWriter = createAnsiRichTextStreamWriter((chunk) => {
    process.stdout.write(chunk);
  }, "assistant");
  console.log("user:", prompt);
  process.stdout.write("assistant: ");

  const reply = await runAgentTurn(session, prompt, {
    toolContext: createToolExecutionContext(session, state, null, turnEvents),
    onChunk: (chunk) => {
      assistantWriter.writeChunk(chunk);
    },
  });

  if (!reply) {
    assistantWriter.writeChunk("(empty response)");
  }

  assistantWriter.end();
  process.stdout.write("\n");
  await renderTurnEvents(null, turnEvents);
}

async function runInteractiveSession(
  session: AgentSession,
  state: InteractiveState,
): Promise<void> {
  const ui = createInteractiveRenderer({
    input,
    output,
    minCommandPanelDurationMs: state.minCommandPanelDurationMs,
  });
  renderInteractiveShell(ui, session, state);

  try {
    while (true) {
      await refreshDeleteAreaBanner(session, state, ui);
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
      console.log("Commands: /help /mode [default|strict] /approvals [ask|allow-all|crazy_auto|reject] /duration [seconds] /settings /session /history [id|index|title] /sessions [query] /new [title] /switch <id|index|title> /rename <title> /delete [id|index|title|all] /trash [list|restore <id>|purge <id>|empty YES] /system /editor /system reset /clear /exit");
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
        applyApprovalModeChange(session, state, ui, selectedMode, "slash_command");
        await persistSessionMetadataIfNeeded(session, state);
        renderApprovalSummary(ui, state.commandApprovalMode);
      }
      return true;
    }

    if (!requestedMode) {
      renderApprovalSummary(ui, state.commandApprovalMode);
      return true;
    }

    try {
      applyApprovalModeChange(
        session,
        state,
        ui,
        parseCommandApprovalMode(requestedMode),
        "slash_command",
      );
      await persistSessionMetadataIfNeeded(session, state);
      renderApprovalSummary(ui, state.commandApprovalMode);
    } catch (error) {
      renderError(ui, error instanceof Error ? error.message : "Failed to change approvals.");
    }
    return true;
  }

  if (matchesCommand(prompt, "/duration")) {
    const requestedDuration = parseCommandArgument(prompt, "/duration");
    if (!requestedDuration) {
      renderCommandPanelDurationSummary(ui, state.minCommandPanelDurationMs);
      return true;
    }

    try {
      const nextDurationMs = parseCommandPanelDuration(requestedDuration);
      state.minCommandPanelDurationMs = nextDurationMs;
      ui?.setMinimumCommandPanelDurationMs(nextDurationMs);
      if (ui) {
        ui.setShellFrame(buildInteractiveShellFrame(session, state));
      }
      renderCommandPanelDurationApplied(ui, nextDurationMs);
    } catch (error) {
      renderError(
        ui,
        error instanceof Error ? error.message : "Failed to change command panel duration.",
      );
    }
    return true;
  }

  if (prompt === "/settings") {
    renderSettingsSummary(ui, session, state.settings, state);
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
        await renderHistory(ui, {
          label: formatSessionLabel(state.currentSessionTitle, state.currentSessionId),
          history: session.history,
          events: state.sessionEvents,
          current: true,
        });
        return true;
      }

      const targetSession = resolveSessionSelector(sessionSelector, state);
      const storedSession = await loadSession(targetSession.id);
      await renderHistory(ui, {
        label: formatSessionLabel(storedSession.title, storedSession.id),
        history: storedSession.history,
        events: storedSession.events,
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
          state.sessionEvents = [...storedSession.events];
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

  if (matchesCommand(prompt, "/new")) {
    const requestedTitle = parseCommandArgument(prompt, "/new");
    resetCurrentSession(session, state.settings.systemPrompt);
    state.currentSessionTitle = null;
    state.sessionEvents = [];
    const result = await createSession({
      ...(requestedTitle ? { title: requestedTitle } : {}),
      systemPrompt: session.systemPrompt,
      history: session.history,
      events: state.sessionEvents,
      maxHistoryTurns: session.maxHistoryTurns,
    });
    state.sessionStore = result.store;
    state.currentSessionId = result.session.id;
    state.currentSessionTitle = result.session.title;
    state.sessionEvents = [...result.session.events];
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
      state.sessionEvents = [...storedSession.events];
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
        state.sessionEvents = [...activeSession.events];
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
      state.sessionEvents = [];
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
    state.sessionEvents = [];
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

  if (matchesCommand(prompt, "/trash")) {
    await handleTrashCommand(prompt, session, state, ui);
    return true;
  }

  if (prompt.startsWith("/")) {
    renderError(ui, `Unknown command: ${prompt}. Type /help.`);
    return true;
  }

  if (ui) {
    ui.beginAgentTurn(prompt);
  } else {
    process.stdout.write("assistant: ");
  }

  const turnEvents: ToolTurnEvent[] = [];

  let reply = "";
  try {
    reply = await runAgentTurn(session, prompt, {
      toolContext: createToolExecutionContext(session, state, ui, turnEvents),
      onChunk: (chunk) => {
        if (ui) {
          ui.appendAssistantChunk(chunk);
          return;
        }

        process.stdout.write(chunk);
      },
    });
  } catch (error) {
    if (ui) {
      ui.failActiveTurn(error instanceof Error ? error.message : "Unknown error.");
    }
    throw error;
  }

  applyTurnEventsToSession(state, turnEvents);
  await persistCurrentSession(session, state);
  await refreshDeleteAreaBanner(session, state, ui);

  if (!reply) {
    if (ui) {
      ui.appendAssistantChunk("(empty response)");
    } else {
      process.stdout.write("(empty response)");
    }
  }

  if (ui) {
    ui.completeActiveTurn();
  }

  if (!ui) {
    process.stdout.write("\n");
  }
  await renderTurnEvents(ui, turnEvents);
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
    state.sessionEvents = [];
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
    state.sessionEvents = [];
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
    state.sessionEvents = [];
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
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const sessionLabel = state.currentSessionId
    ? formatSessionLabel(state.currentSessionTitle, state.currentSessionId)
    : state.sessionStore.sessions.length === 0
      ? "unsaved"
      : "not loaded";
  const lines: Array<Omit<RendererLine, "id">> = [
    { kind: "section", text: "SuperRun" },
    {
      kind: "info",
      text: `${model}  ${process.cwd()}`,
    },
    {
      kind: "info",
      text: `session ${sessionLabel}`,
    },
    {
      kind: "info",
      text: `mode ${session.mode}  approvals ${state.commandApprovalMode}`,
    },
    {
      kind: "info",
      text: `history ${stats.historyTurnCount}/${stats.maxHistoryTurns}  saved ${state.sessionStore.sessions.length}  duration ${formatCommandPanelDurationSeconds(state.minCommandPanelDurationMs)}s`,
    },
  ];

  const deleteAreaBanner = getDeleteAreaBannerText(state.deleteAreaStatus);
  if (deleteAreaBanner) {
    lines.push({
      kind: "warning",
      text: deleteAreaBanner,
    });
  }

  if (state.sessionStore.sessions.length === 0) {
    lines.push({
      kind: "info",
      text: "No saved sessions yet.",
    });
  }

  lines.push({
    kind: "body",
    text: "commands /help /sessions /new [title] /mode /approvals /duration /system /clear /exit",
  });

  return lines;
}

function buildDeleteAreaBannerLines(
  state: InteractiveState,
): Array<Omit<RendererLine, "id">> {
  const bannerText = getDeleteAreaBannerText(state.deleteAreaStatus);
  if (!bannerText) {
    return [];
  }

  return [
    {
      kind: "warning",
      text: bannerText,
    },
  ];
}

export function getDeleteAreaBannerText(status: {
  fileCount: number;
  totalBytes: number;
}): string | null {
  if (status.fileCount === 0) {
    return null;
  }

  return `Delete area now has ${status.fileCount} file${status.fileCount === 1 ? "" : "s"} (about ${formatDeleteAreaKilobytes(status.totalBytes)} KB). Use /trash to inspect, restore, purge, or empty it.`;
}

function renderInteractiveShell(
  ui: InteractiveRenderer,
  session: AgentSession,
  state: InteractiveState,
): void {
  ui.clearScreen();
  ui.setShellFrame(buildInteractiveShellFrame(session, state));
}

async function refreshDeleteAreaBanner(
  session: AgentSession,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
): Promise<void> {
  state.deleteAreaStatus = await getWorkspaceDeleteAreaStatus();
  if (ui) {
    ui.setShellFrame(buildInteractiveShellFrame(session, state));
  }
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
  renderInfo(ui, 'Use "/approvals" to review file-edit and command approval behavior.');
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

async function handleTrashCommand(
  prompt: string,
  session: AgentSession,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
): Promise<void> {
  const argument = parseCommandArgument(prompt, "/trash");
  const [subcommand = "list", ...restParts] = argument.split(/\s+/).filter(Boolean);
  const value = restParts.join(" ").trim();

  if (subcommand === "help") {
    renderTrashHelp(ui);
    return;
  }

  if (subcommand === "list") {
    renderTrashList(ui, await listWorkspaceTrashEntries());
    return;
  }

  if (subcommand === "restore") {
    if (!value) {
      renderError(ui, 'Usage: /trash restore <id>');
      return;
    }

    try {
      const result = await restoreWorkspaceFileFromTrash(value);
      await refreshDeleteAreaBanner(session, state, ui);
      renderInfo(ui, `Restored deleted file: ${result.entry.originalPath} -> ${result.restoredPath}`);
    } catch (error) {
      renderError(ui, error instanceof Error ? error.message : "Failed to restore deleted file.");
    }
    return;
  }

  if (subcommand === "purge") {
    if (!value) {
      renderError(ui, 'Usage: /trash purge <id>');
      return;
    }

    try {
      const result = await purgeWorkspaceFileFromTrash(value);
      await refreshDeleteAreaBanner(session, state, ui);
      renderInfo(ui, `Purged deleted file: ${result.entry.originalPath} [${result.entry.id}]`);
    } catch (error) {
      renderError(ui, error instanceof Error ? error.message : "Failed to purge deleted file.");
    }
    return;
  }

  if (subcommand === "empty") {
    if (value !== "YES") {
      renderError(ui, 'Usage: /trash empty YES');
      return;
    }

    try {
      const result = await emptyWorkspaceTrash();
      await refreshDeleteAreaBanner(session, state, ui);
      renderInfo(ui, `Emptied delete area: ${result.purgedCount} file${result.purgedCount === 1 ? "" : "s"} permanently removed.`);
    } catch (error) {
      renderError(ui, error instanceof Error ? error.message : "Failed to empty the delete area.");
    }
    return;
  }

  renderError(ui, `Unknown /trash command: ${subcommand}. Use /trash help.`);
}

function renderTrashHelp(ui: InteractiveRenderer | null): void {
  if (ui) {
    ui.renderSectionTitle("Delete Area");
  } else {
    console.log("Delete Area");
  }

  renderInfo(ui, "/trash list");
  renderInfo(ui, "/trash restore <id>");
  renderInfo(ui, "/trash purge <id>");
  renderInfo(ui, "/trash empty YES");
}

function renderTrashList(
  ui: InteractiveRenderer | null,
  trash: Awaited<ReturnType<typeof listWorkspaceTrashEntries>>,
): void {
  if (ui) {
    ui.renderSectionTitle("Delete Area");
  } else {
    console.log("Delete Area");
  }

  renderInfo(
    ui,
    `Delete area: ${trash.status.fileCount} file${trash.status.fileCount === 1 ? "" : "s"}, about ${formatDeleteAreaKilobytes(trash.status.totalBytes)} KB.`,
  );

  if (trash.entries.length === 0) {
    renderInfo(ui, "Delete area is empty.");
    return;
  }

  for (const entry of trash.entries) {
    renderInfo(
      ui,
      `${entry.id}  ${entry.originalPath}  ${formatDeleteAreaKilobytes(entry.sizeBytes)} KB  ${formatTimestamp(entry.deletedAt)}`,
    );
  }
}

function renderSettingsSummary(
  ui: InteractiveRenderer | null,
  session: AgentSession,
  settings: SuperRunSettings,
  state: Pick<InteractiveState, "minCommandPanelDurationMs">,
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
  renderInfo(
    ui,
    `Minimum command panel duration: ${formatCommandPanelDurationSeconds(state.minCommandPanelDurationMs)}s.`,
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
    : (message: string) => console.log(formatRichTextToAnsi(message, "warning"));

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

async function renderTurnEvents(
  ui: InteractiveRenderer | null,
  events: ToolTurnEvent[],
): Promise<void> {
  for (const event of events) {
    if (event.kind === "command_execution") {
      if (!ui && event.phase !== "output") {
        renderCommandExecutionEvent(null, event);
      }
      continue;
    }

    if (event.kind === "notice") {
      if (ui) {
        continue;
      }
      if (event.level === "error") {
        renderError(ui, event.message);
        continue;
      }

      if (event.level === "warning") {
        console.log(formatRichTextToAnsi(`warning: ${event.message}`, "warning"));
        continue;
      }

      renderInfo(ui, event.message);
      continue;
    }

    if (ui && !event.autoApproved) {
      continue;
    }

    const changeSummaryText = formatWorkspaceEditChangeSummary(
      event.diffPreview.changeSummary,
    );
    if (!ui) {
      renderInfo(
        ui,
        `Edited ${event.path}: ${changeSummaryText}.`,
      );
    }

    if (event.autoApproved) {
      if (!ui) {
        renderInfo(
          ui,
          `Auto-approved under ${event.approvalMode}: ${event.summary}.`,
        );
      }
      if (ui) {
        await ui.viewDiff({
          title: `Applied ${event.tool}`,
          subtitle: event.path,
          summary: `${event.diffPreview.summary}. ${changeSummaryText}.`,
          changeSummary: event.diffPreview.changeSummary,
          truncated: event.diffPreview.truncated,
          lines: event.diffPreview.lines,
        });
      } else {
        for (const line of event.diffPreview.lines) {
          console.log(
            `${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "} ${line.text}`,
          );
        }
      }
    }
  }
}

function applyApprovalModeChange(
  session: AgentSession,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
  nextMode: CommandApprovalMode,
  source: "slash_command" | "approval_decision",
): void {
  const previousMode = state.commandApprovalMode;
  if (previousMode === nextMode) {
    return;
  }

  state.commandApprovalMode = nextMode;
  recordSessionEvent(state, {
    timestamp: createSessionEventTimestamp(),
    kind: "approval_mode_changed",
    from: previousMode,
    to: nextMode,
    source,
  });
  renderInfo(
    ui,
    `Approvals changed: ${previousMode} -> ${nextMode} for this session.`,
  );

  if (source === "slash_command" && session.history.length === 0 && !state.currentSessionId) {
    return;
  }
}

function applyTurnEventsToSession(
  state: InteractiveState,
  events: ToolTurnEvent[],
): void {
  for (const event of events) {
    if (event.kind === "notice") {
      recordSessionEvent(state, {
        timestamp: createSessionEventTimestamp(),
        kind: "tool_notice",
        level: event.level,
        message: event.message,
      });
      continue;
    }

    if (event.kind === "command_execution") {
      continue;
    }

    recordSessionEvent(state, {
      timestamp: createSessionEventTimestamp(),
      kind: "workspace_edit_applied",
      tool: event.tool,
      path: event.path,
      summary: event.summary,
      approvalMode: event.approvalMode,
      autoApproved: event.autoApproved,
      changeSummary: event.diffPreview.changeSummary,
    });
  }
}

function recordSessionEvent(
  state: InteractiveState,
  event: SessionEvent,
): void {
  state.sessionEvents.push(event);
}

async function persistSessionMetadataIfNeeded(
  session: AgentSession,
  state: InteractiveState,
): Promise<void> {
  if (!state.currentSessionId && session.history.length === 0) {
    return;
  }

  await persistCurrentSession(session, state, { allowEmpty: true });
}

function renderApprovalSummary(
  ui: InteractiveRenderer | null,
  mode: CommandApprovalMode,
): void {
  renderInfo(ui, `Approvals: ${getCommandApprovalSummary(mode)}.`);
}

function renderCommandPanelDurationSummary(
  ui: InteractiveRenderer | null,
  durationMs: number,
): void {
  renderInfo(
    ui,
    `Minimum command panel duration: ${formatCommandPanelDurationSeconds(durationMs)}s.`,
  );
  renderInfo(
    ui,
    `Use "/duration <seconds>" to change it. Very short durations can trigger photosensitive epilepsy.`,
  );
}

function renderCommandPanelDurationApplied(
  ui: InteractiveRenderer | null,
  durationMs: number,
): void {
  renderInfo(
    ui,
    `Minimum command panel duration set to ${formatCommandPanelDurationSeconds(durationMs)}s.`,
  );

  if (durationMs < 1_000) {
    renderWarning(
      ui,
      "Warning: very short command panel durations can trigger photosensitive epilepsy.",
    );
  }
}

function parseCommandPanelDuration(value: string): number {
  const normalized = value.trim().toLowerCase().replace(/s$/, "");
  const seconds = Number(normalized);

  if (!Number.isFinite(seconds)) {
    throw new Error('Invalid duration. Use seconds, for example "/duration 1.5".');
  }

  const durationMs = Math.round(seconds * 1_000);
  if (
    durationMs < MIN_ALLOWED_COMMAND_PANEL_DURATION_MS ||
    durationMs > MAX_ALLOWED_COMMAND_PANEL_DURATION_MS
  ) {
    throw new Error(
      `Duration must stay between ${formatCommandPanelDurationSeconds(MIN_ALLOWED_COMMAND_PANEL_DURATION_MS)}s and ${formatCommandPanelDurationSeconds(MAX_ALLOWED_COMMAND_PANEL_DURATION_MS)}s.`,
    );
  }

  return durationMs;
}

function formatCommandPanelDurationSeconds(durationMs: number): string {
  return (durationMs / 1_000).toFixed(durationMs % 1_000 === 0 ? 0 : 1);
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
  renderInfo(ui, `Approvals: ${getCommandApprovalSummary(state.commandApprovalMode)}.`);
  renderInfo(
    ui,
    `Minimum command panel duration: ${formatCommandPanelDurationSeconds(state.minCommandPanelDurationMs)}s.`,
  );
  renderInfo(
    ui,
    `Current session: ${currentStats.historyTurnCount} turns, ${currentStats.historyMessageCount} messages, ${currentStats.historyCharCount} chars.`,
  );
  renderInfo(ui, `Recorded events: ${state.sessionEvents.length}.`);
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

async function renderHistory(
  ui: InteractiveRenderer | null,
  options: {
    label: string;
    history: AgentSession["history"];
    events: SessionEvent[];
    current: boolean;
  },
): Promise<void> {
  if (ui) {
    await ui.viewText({
      title: "History",
      subtitle: options.label,
      helpText: "Up/Down scroll  PgUp/PgDn page  q close  Esc close",
      emptyMessage: "No messages yet.",
      lines: buildHistoryViewerLines(options),
    });
    return;
  }

  console.log("History");

  renderInfo(ui, `Session: ${options.label}`);
  renderInfo(ui, `Messages: ${options.history.length}`);
  renderInfo(ui, `Events: ${options.events.length}`);
  if (options.current) {
    renderInfo(ui, "Viewing the current conversation.");
  }

  if (options.history.length === 0 && options.events.length === 0) {
    renderInfo(ui, "No messages yet.");
    return;
  }

  if (options.history.length > 0) {
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

  if (options.events.length > 0) {
    writeBodyLine(ui, "");
    writeBodyLine(ui, "Events");

    for (const [index, event] of options.events.entries()) {
      writeBodyLine(ui, `${index + 1}. ${formatSessionEvent(event)}`);
    }
  }
}

function buildHistoryViewerLines(options: {
  label: string;
  history: AgentSession["history"];
  events: SessionEvent[];
  current: boolean;
}): RendererViewerLine[] {
  const lines: RendererViewerLine[] = [
    { text: `Session: ${options.label}`, tone: "info" },
    {
      text: `Messages: ${options.history.length}  Events: ${options.events.length}${options.current ? "  Viewing current conversation." : ""}`,
      tone: "info",
    },
  ];

  if (options.events.length > 0) {
    lines.push({ text: "" });
    lines.push({ text: "Recent Activity", tone: "info" });

    for (const [index, event] of options.events.entries()) {
      const tone = getEventViewerTone(event);
      lines.push({
        text: `${index + 1}. ${formatSessionEvent(event)}`,
        ...(tone ? { tone } : {}),
      });
    }
  }

  if (options.history.length > 0) {
    lines.push({ text: "" });
    lines.push({ text: "Transcript", tone: "info" });

    for (const [index, message] of options.history.entries()) {
      const speaker = message.role === "user" ? "You" : "Assistant";
      lines.push({
        text: `${index + 1}. ${speaker}`,
        tone: message.role === "user" ? "info" : "default",
      });

      const contentLines = message.content.split(/\r?\n/);
      for (const line of contentLines) {
        lines.push({ text: `   ${line}` });
      }

      if (index < options.history.length - 1) {
        lines.push({ text: "" });
      }
    }
  }

  return lines;
}

function getEventViewerTone(
  event: SessionEvent,
): RendererViewerLine["tone"] {
  if (event.kind === "tool_notice") {
    if (event.level === "error") {
      return "error";
    }

    if (event.level === "warning") {
      return "warning";
    }
  }

  return "info";
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

  console.log(formatRichTextToAnsi(message, "info"));
}

function renderError(ui: InteractiveRenderer | null, message: string): void {
  if (ui) {
    ui.renderError(message);
    return;
  }

  console.error(`error: ${formatRichTextToAnsi(message, "error")}`);
}

function renderWarning(ui: InteractiveRenderer | null, message: string): void {
  if (ui) {
    ui.renderWarning(message);
    return;
  }

  console.log(formatRichTextToAnsi(message, "warning"));
}

function writeBodyLine(ui: InteractiveRenderer | null, message: string): void {
  if (ui) {
    ui.writeBodyLine(message);
    return;
  }

  console.log(formatRichTextToAnsi(message));
}

function renderCommandExecutionEvent(
  ui: InteractiveRenderer | null,
  event: Extract<ToolTurnEvent, { kind: "command_execution" }>,
): void {
  for (const line of buildCommandExecutionBox(event)) {
    writeBodyLine(ui, line);
  }
}

function buildCommandExecutionBox(
  event: Extract<ToolTurnEvent, { kind: "command_execution" }>,
): string[] {
  if (event.phase === "output") {
    return [];
  }

  if (event.phase === "started") {
    return [
      "┌ Command",
      `│ \`${event.command}\``,
      `│ cwd: \`${event.cwd}\``,
      `│ category: \`${event.category}\``,
      `└ status: **running** (${event.summary})`,
    ];
  }

  const lines = [
    "┌ Command Result",
    `│ \`${event.command}\``,
    `│ cwd: \`${event.cwd}\``,
    `│ category: \`${event.category}\``,
    `│ exit: \`${event.exitCode ?? "null"}\``,
  ];

  lines.push(
    event.timedOut
      ? "│ status: **timed out**"
      : `│ status: **completed** (${event.summary})`,
  );

  if (event.stdout) {
    lines.push("│ stdout:");
    for (const line of event.stdout.split(/\r?\n/)) {
      lines.push(`│   ${line}`);
    }
  }

  if (event.stderr) {
    lines.push("│ stderr:");
    for (const line of event.stderr.split(/\r?\n/)) {
      lines.push(`│   ${line}`);
    }
  }

  if (!event.stdout && !event.stderr) {
    lines.push("│ output: *(empty)*");
  }

  if (event.truncated) {
    lines.push("│ note: output was **truncated** to fit the preview limit");
  }

  lines.push("└ done");
  return lines;
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

function formatDeleteAreaKilobytes(totalBytes: number): number {
  if (totalBytes <= 0) {
    return 0;
  }

  return Math.max(1, Math.round(totalBytes / 1024));
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
      events: state.sessionEvents,
      maxHistoryTurns: session.maxHistoryTurns,
    });
    state.sessionStore = result.store;
    state.currentSessionId = result.session.id;
    state.currentSessionTitle = result.session.title;
    state.sessionEvents = [...result.session.events];
    return;
  }

  const result = await createSession({
    ...(sessionTitle ? { title: sessionTitle } : {}),
    systemPrompt: session.systemPrompt,
    history: session.history,
    events: state.sessionEvents,
    maxHistoryTurns: session.maxHistoryTurns,
  });
  state.sessionStore = result.store;
  state.currentSessionId = result.session.id;
  state.currentSessionTitle = result.session.title;
  state.sessionEvents = [...result.session.events];
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
  const sessions = options?.sessions ?? state.sessionStore.sessions;
  const selectedSessionId = await ui.selectOption({
    title: "Saved Sessions",
    subtitle: buildSessionPickerSubtitle(sessions.length, options?.filterQuery),
    helpText: "Up/Down move  Enter switch  Esc cancel",
    options: buildSessionPickerChoices(sessions, state.currentSessionId).map((choice) => ({
      value: choice.value,
      label: choice.name,
      description: choice.description,
      tone: choice.value === state.currentSessionId ? "accent" : "default",
    })),
  });

  return sessions.find((session) => session.id === selectedSessionId) ?? null;
}

async function runModePicker(
  currentMode: AgentMode,
  ui: InteractiveRenderer,
): Promise<AgentMode | null> {
  const selectedMode = await ui.selectOption({
    title: "Tool Mode",
    subtitle: "Choose how the agent can inspect and execute local work.",
    helpText: "Up/Down move  Enter apply  Esc cancel",
    options: buildModePickerChoices(currentMode).map((choice) => ({
      value: choice.value,
      label: choice.name,
      description: choice.description,
      tone: choice.value === currentMode ? "accent" : "default",
    })),
  });

  return selectedMode ? parseAgentMode(selectedMode) : null;
}

async function runApprovalPicker(
  currentMode: CommandApprovalMode,
  ui: InteractiveRenderer,
): Promise<CommandApprovalMode | null> {
  const selectedMode = await ui.selectOption({
    title: "Approvals",
    subtitle: "Choose how file edits and shell execution are approved in this process.",
    helpText: "Up/Down move  Enter apply  Esc cancel",
    options: buildApprovalPickerOptions(currentMode),
  });

  return selectedMode ? parseCommandApprovalMode(selectedMode) : null;
}

function createToolExecutionContext(
  session: AgentSession,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
  turnEvents: ToolTurnEvent[] = [],
): ToolExecutionContext {
  return {
    commandPolicy: {
      getMode: () => state.commandApprovalMode,
      setMode: (mode) => {
        applyApprovalModeChange(session, state, ui, mode, "approval_decision");
      },
      ...(ui
        ? {
            requestApproval: async (request: CommandApprovalRequest) => {
              recordSessionEvent(state, {
                timestamp: createSessionEventTimestamp(),
                kind: "approval_requested",
                approvalKind: "command",
                summary: request.assessment.summary,
                subject: request.assessment.command,
                category: request.assessment.category,
              });
              const decision = await promptCommandApproval(request, ui);
              recordSessionEvent(state, {
                timestamp: createSessionEventTimestamp(),
                kind: "approval_decided",
                approvalKind: "command",
                summary: request.assessment.summary,
                subject: request.assessment.command,
                decision,
                modeBefore: request.approvalMode,
                modeAfter: decision === "always" ? "allow-all" : request.approvalMode,
                category: request.assessment.category,
              });
              return decision;
            },
          }
        : {}),
      ...(state.commandHookRunner ? { runHook: state.commandHookRunner } : {}),
    },
    workspaceEditPolicy: {
      getMode: () => state.commandApprovalMode,
      setMode: (mode) => {
        applyApprovalModeChange(session, state, ui, mode, "approval_decision");
      },
      ...(ui
        ? {
            requestApproval: async (request: WorkspaceEditApprovalRequest) => {
              recordSessionEvent(state, {
                timestamp: createSessionEventTimestamp(),
                kind: "approval_requested",
                approvalKind: "workspace_edit",
                summary: request.assessment.summary,
                subject: `${request.assessment.tool} ${request.assessment.path}`,
                tool: request.assessment.tool,
                path: request.assessment.path,
              });
              const decision = await promptWorkspaceEditApproval(request, ui);
              recordSessionEvent(state, {
                timestamp: createSessionEventTimestamp(),
                kind: "approval_decided",
                approvalKind: "workspace_edit",
                summary: request.assessment.summary,
                subject: `${request.assessment.tool} ${request.assessment.path}`,
                decision,
                modeBefore: request.approvalMode,
                modeAfter: decision === "always" ? "allow-all" : request.approvalMode,
                tool: request.assessment.tool,
                path: request.assessment.path,
              });
              return decision;
            },
          }
        : {}),
    },
    notices: {
      addNotice: (notice) => {
        const event = {
          kind: "notice",
          level: notice.level,
          message: notice.message,
        } satisfies ToolTurnEvent;
        turnEvents.push(event);
        ui?.applyToolEvent(event);
      },
    },
    turnEvents: {
      addEvent: (event) => {
        turnEvents.push(event);
        ui?.applyToolEvent(event);
      },
    },
  };
}

async function promptCommandApproval(
  request: CommandApprovalRequest,
  ui: InteractiveRenderer,
): Promise<CommandApprovalDecision> {
  const { assessment } = request;
  const reasonSummary = assessment.reasons.join(" ");
  return ui.requestApproval({
    title: `Approve ${assessment.category} command?`,
    subtitle: assessment.summary,
    helpText: "Up/Down move  Enter approve once  a allow-all  Esc reject",
    options: [
      {
        value: "once",
        label: "Approve once",
        description: `${assessment.summary}. ${reasonSummary}`,
        tone: "accent",
      },
      {
        value: "always",
        label: "Allow all this session",
        description: "Switch approvals to allow-all for later ordinary commands in this process.",
        tone: "default",
      },
      {
        value: "reject",
        label: "Reject",
        description: `Block this command: ${assessment.command}`,
        tone: "danger",
      },
    ],
  });
}

async function promptWorkspaceEditApproval(
  request: WorkspaceEditApprovalRequest,
  ui: InteractiveRenderer,
): Promise<CommandApprovalDecision> {
  const { assessment } = request;
  if (assessment.diffPreview) {
    return ui.reviewDiff({
      title: `Approve ${assessment.tool}?`,
      subtitle: assessment.path,
      summary: assessment.diffPreview.summary,
      changeSummary: assessment.diffPreview.changeSummary,
      truncated: assessment.diffPreview.truncated,
      lines: assessment.diffPreview.lines,
    });
  }

  const reasonSummary = assessment.reasons.join(" ");
  return ui.requestApproval({
    title: `Approve ${assessment.tool}?`,
    subtitle: `${assessment.summary}: ${assessment.path}`,
    helpText: "Up/Down move  Enter approve once  a allow-all  Esc reject",
    options: [
      {
        value: "once",
        label: "Approve once",
        description: `${assessment.summary}. ${reasonSummary}`,
        tone: "accent",
      },
      {
        value: "always",
        label: "Allow all this session",
        description: "Switch approvals to allow-all for later file edits and ordinary commands in this process.",
        tone: "default",
      },
      {
        value: "reject",
        label: "Reject",
        description: `Block this edit: ${assessment.path}`,
        tone: "danger",
      },
    ],
  });
}

function buildApprovalPickerOptions(
  currentMode: CommandApprovalMode,
): RendererPickerOption[] {
  return [
    {
      value: "ask",
      label: currentMode === "ask" ? "ask (current)" : "ask",
      description: "Auto-run read-only commands and prompt before file edits or other shell execution.",
      tone: currentMode === "ask" ? "accent" : "default",
    },
    {
      value: "allow-all",
      label: currentMode === "allow-all" ? "allow-all (current)" : "allow-all",
      description: "Auto-approve file edits and ordinary shell commands, but still gate elevated-risk shell actions.",
      tone: currentMode === "allow-all" ? "accent" : "default",
    },
    {
      value: "crazy_auto",
      label: currentMode === "crazy_auto" ? "crazy_auto (current)" : "crazy_auto",
      description: "Auto-approve file edits and all shell commands, including elevated-risk actions.",
      tone: currentMode === "crazy_auto" ? "danger" : "danger",
    },
    {
      value: "reject",
      label: currentMode === "reject" ? "reject (current)" : "reject",
      description: "Block file edits and run_command for the current process.",
      tone: currentMode === "reject" ? "accent" : "default",
    },
    {
      value: null,
      label: "Keep current approvals",
      description: "Return to chat without changing the approval mode.",
      tone: "default",
    },
  ];
}

function buildSessionPickerSubtitle(
  sessionCount: number,
  filterQuery?: string,
): string {
  const trimmedFilter = filterQuery?.trim();
  if (!trimmedFilter) {
    return `${sessionCount} saved session${sessionCount === 1 ? "" : "s"} available.`;
  }

  return `Filter: "${trimmedFilter}" (${sessionCount} match${sessionCount === 1 ? "" : "es"}).`;
}

async function runWithSuspendedRenderer<T>(
  ui: InteractiveRenderer,
  action: () => Promise<T>,
): Promise<T> {
  ui.suspend();
  // Re-attach the shared TTY before handing control to an external editor so
  // stdin stays alive across the suspend/resume handoff on Windows.
  input.resume?.();
  input.ref?.();
  try {
    return await action();
  } finally {
    input.unref?.();
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
