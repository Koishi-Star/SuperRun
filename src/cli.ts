import "dotenv/config";
import { stdin as input, stdout as output } from "node:process";
import { Command, Option } from "commander";
import {
  AgentToolLoopLimitError,
  type AgentSession,
  buildTurnMessages,
  commitAgentTurnHistory,
  createAgentSession,
  getAgentSessionStats,
  runAgentTurn,
} from "./agent/loop.js";
import {
  createTaskPlan,
  formatTaskPlanSummary,
  getActiveTaskPlanStep,
  getTaskPlanProgress,
  renderTaskPlanMarkdown,
  updateTaskPlanStep,
  type TaskPlan,
} from "./agent/plan.js";
import {
  buildContextBudgetSnapshot,
  createEmptyContextBudgetSnapshot,
  estimateChatMessageTokens,
} from "./agent/context-budget.js";
import {
  getAgentModeSummary,
  parseAgentMode,
  type AgentMode,
} from "./agent/mode.js";
import {
  loadSettings,
  resetSystemPrompt,
  saveActiveProvider,
  saveProviderBaseURL,
  saveProviderContextLimitTokens,
  saveProviderModel,
  saveProviderTimeoutMs,
  saveSystemPrompt,
  type SuperRunSettings,
} from "./config/settings.js";
import {
  clearPersistedProviderApiKey,
  loadPersistedProviderApiKeys,
  savePersistedProviderApiKey,
} from "./config/provider-secrets.js";
import {
  createSession,
  deleteAllSessions,
  deleteSession,
  loadSession,
  loadSessionStore,
  renameSession,
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
import { runWorkspaceCommand } from "./tools/run_command.js";
import type {
  CommandApprovalDecision,
  CommandApprovalMode,
  CommandApprovalRequest,
  CommandCategory,
  CommandPolicyContext,
  ToolTurnEvent,
  ToolExecutionContext,
  UserInputRequest,
  UserInputResponse,
  WorkspaceEditApprovalRequest,
} from "./tools/types.js";
import {
  createAnsiRichTextStreamWriter,
  formatRichTextToAnsi,
  parseMarkdownTable,
  renderMarkdownTableLines,
} from "./ui/assistant-rich-text.js";
import {
  ALTERNATE_KIMI_BASE_URL,
  DEFAULT_KIMI_BASE_URL,
  getProviderApiKeyPlaceholder,
  getProviderDisplayName,
  parseProviderId,
  resolveProviderRuntimeConfig,
  type ProviderId,
  type ProviderApiKeySource,
  type ProviderRuntimeConfig,
  type ProviderRuntimeSecretOverrides,
} from "./llm/provider.js";
import {
  attachProviderCatalogMetadata,
  createProviderCatalogState,
  describeProviderCatalogStatus,
  refreshProviderCatalog,
  summarizeProviderCatalogRefresh,
  type ProviderCatalogRefreshFeedback,
  type ProviderCatalogState,
} from "./llm/provider-catalog.js";
import { chatOnce } from "./llm/router.js";
import { loadWorkspaceFilePaths } from "./ui/file-reference.js";
import { createInteractiveTraceEventSinkFromEnv } from "./testing/interactive-trace.js";
import { editSystemPromptExternally } from "./ui/external-editor.js";
import {
  createInteractiveRenderer,
  type RendererContextMeter,
  type InteractiveRenderer,
  type RendererPickerOption,
  type RendererLine,
  type RendererViewerLine,
} from "./ui/interactive-renderer.js";
import { buildContextIndicatorDisplay } from "./ui/context-indicator.js";
import {
  buildModePickerChoices,
  CRAZY_AUTO_MODE_VALUE,
  type InteractiveModeChoiceValue,
} from "./ui/mode-picker.js";
import { buildKimiBaseURLPickerChoices } from "./ui/kimi-base-url-picker.js";
import { buildProviderContextPickerChoices } from "./ui/provider-context-picker.js";
import { buildProviderModelPickerChoices } from "./ui/provider-model-picker.js";
import { buildProviderPickerChoices } from "./ui/provider-picker.js";
import { runSessionBrowser } from "./ui/session-browser.js";
import { promptHiddenInput } from "./ui/secret-input.js";
import {
  buildTrashActionChoices,
  buildTrashEntryChoices,
  type TrashActionValue,
} from "./ui/trash-picker.js";

export const program = new Command();

program
  .name("superrun")
  .description("A coding agent CLI")
  .addOption(
    new Option(
      "--mode <mode>",
      'agent tool mode: "default" enables guarded command execution, "strict" keeps only specialized read-only tools, and "plan" keeps the agent read-only with planning-only guidance',
    )
      .choices(["default", "strict", "plan"])
      .default("default"),
  )
  .addOption(
    new Option(
      "--approvals <mode>",
      'approval mode: "ask" prompts before file edits and shell commands, "allow-all" auto-approves ordinary commands but still gates elevated-risk shell actions, "reject" disables local mutations and command execution',
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
      const persistedProviderApiKeys = await loadPersistedProviderApiKeysSafely();
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
          providerCatalog: createProviderCatalogState(),
          providerApiKeyOverrides: { ...persistedProviderApiKeys },
          providerApiKeySources: Object.fromEntries(
            Object.keys(persistedProviderApiKeys).map((providerId) => [
              providerId,
              "stored",
            ]),
          ) as Partial<Record<ProviderId, ProviderApiKeySource>>,
          minCommandPanelDurationMs: DEFAULT_MIN_COMMAND_PANEL_DURATION_MS,
          lastNonPlanMode: getInitialPlanReturnMode(session.mode),
        });
        return;
      }

      if (!(input.isTTY && output.isTTY)) {
        throw new Error(
          'Interactive mode requires a TTY. Run `superrun "<prompt>"` for single-turn use, or start SuperRun from an interactive terminal to use the Ink chat shell.',
        );
      }

      const state = await createInteractiveState(
        settings,
        session,
        approvalMode,
        persistedProviderApiKeys,
      );
      await runInteractiveSession(session, state);
    } catch (error) {
      const message = formatAgentTurnFailureMessage(error);
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
  providerCatalog: ProviderCatalogState;
  providerApiKeyOverrides: ProviderRuntimeSecretOverrides;
  providerApiKeySources: Partial<Record<ProviderId, ProviderApiKeySource>>;
  minCommandPanelDurationMs: number;
  commandApprovalMode: CommandApprovalMode;
  commandHookRunner: ReturnType<typeof createEnvCommandHookRunner>;
  lastNonPlanMode: InteractiveNonPlanMode;
};

type SlashApprovalMode = Exclude<CommandApprovalMode, "crazy_auto">;
type InteractiveNonPlanMode = Exclude<AgentMode, "plan">;

type VerificationBaseline = {
  gitStatusSnapshot: string | null;
};

type TurnVerificationResult = {
  gitAvailable: boolean;
  workspaceChanged: boolean;
  buildPassed: boolean;
  buildExitCode: number | null;
  gitStatusOutput: string;
  gitDiffOutput: string;
  buildStdout: string;
  buildStderr: string;
  failureReason: string | null;
};

type TaskPlanGenerationResult = {
  plan: TaskPlan;
  source: "model" | "fallback";
  attempts: number;
  lastFailureMessage: string | null;
};

const EXIT_COMMANDS = new Set(["/exit", "exit", "exit()"]);
const DEFAULT_MIN_COMMAND_PANEL_DURATION_MS = 1_000;
const MIN_ALLOWED_COMMAND_PANEL_DURATION_MS = 100;
const MAX_ALLOWED_COMMAND_PANEL_DURATION_MS = 10_000;
const TASK_PLAN_HISTORY_CONTEXT_MESSAGES = 6;
const TASK_PLAN_GENERATION_ATTEMPTS = 3;
const TASK_PLAN_TIMEOUT_RETRIES = 3;
const VERIFICATION_BUILD_COMMAND = "npm run build";
const VERIFICATION_STATUS_TIMEOUT_MS = 10_000;
const VERIFICATION_BUILD_TIMEOUT_MS = 120_000;
const IMPLEMENTATION_REQUEST_PATTERN =
  /(?:\b(?:add|build|change|create|edit|fix|implement|modify|refactor|remove|rename|update|write)\b|增加|修改|实现|修复|添加|重构|删除|改成|改为|新增)/i;

async function createInteractiveState(
  settings: SuperRunSettings,
  session: AgentSession,
  approvalMode: CommandApprovalMode,
  persistedProviderApiKeys: ProviderRuntimeSecretOverrides,
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
        providerCatalog: createProviderCatalogState(),
        providerApiKeyOverrides: { ...persistedProviderApiKeys },
        providerApiKeySources: Object.fromEntries(
          Object.keys(persistedProviderApiKeys).map((providerId) => [
            providerId,
            "stored",
          ]),
        ) as Partial<Record<ProviderId, ProviderApiKeySource>>,
        minCommandPanelDurationMs: DEFAULT_MIN_COMMAND_PANEL_DURATION_MS,
        commandApprovalMode: approvalMode,
        commandHookRunner,
        lastNonPlanMode: getInitialPlanReturnMode(session.mode),
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
    providerCatalog: createProviderCatalogState(),
    providerApiKeyOverrides: { ...persistedProviderApiKeys },
    providerApiKeySources: Object.fromEntries(
      Object.keys(persistedProviderApiKeys).map((providerId) => [
        providerId,
        "stored",
      ]),
    ) as Partial<Record<ProviderId, ProviderApiKeySource>>,
    minCommandPanelDurationMs: DEFAULT_MIN_COMMAND_PANEL_DURATION_MS,
    commandApprovalMode: approvalMode,
    commandHookRunner,
    lastNonPlanMode: getInitialPlanReturnMode(session.mode),
  };
}

function shouldForceExecutionContract(
  session: AgentSession,
  prompt: string,
): boolean {
  return session.mode === "default" && IMPLEMENTATION_REQUEST_PATTERN.test(prompt);
}

async function captureVerificationBaseline(
  session: AgentSession,
  prompt: string,
): Promise<VerificationBaseline | null> {
  if (!shouldForceExecutionContract(session, prompt)) {
    return null;
  }

  try {
    const result = await runWorkspaceCommand(
      {
        command: "git status --short --untracked-files=all",
        timeout_ms: VERIFICATION_STATUS_TIMEOUT_MS,
      },
      {
        commandPolicy: createInternalVerificationCommandPolicy(),
      },
    );
    return {
      gitStatusSnapshot: result.exitCode === 0 ? result.stdout.trim() : null,
    };
  } catch {
    return {
      gitStatusSnapshot: null,
    };
  }
}

async function runTurnVerification(
  session: AgentSession,
  prompt: string,
  baseline: VerificationBaseline | null,
  executionEvents: ToolTurnEvent[],
  draftReply: string,
  ui: InteractiveRenderer | null,
  turnEvents: ToolTurnEvent[],
): Promise<TurnVerificationResult | null> {
  if (!baseline || !shouldForceExecutionContract(session, prompt)) {
    return null;
  }

  const commandContext = createInternalVerificationToolContext(ui, turnEvents);
  const gitStatus = await runWorkspaceCommand(
    {
      command: "git status --short --untracked-files=all",
      timeout_ms: VERIFICATION_STATUS_TIMEOUT_MS,
    },
    commandContext,
  );
  const gitDiff = await runWorkspaceCommand(
    {
      command: "git diff --stat",
      timeout_ms: VERIFICATION_STATUS_TIMEOUT_MS,
    },
    commandContext,
  );
  const buildResult = await runWorkspaceCommand(
    {
      command: VERIFICATION_BUILD_COMMAND,
      timeout_ms: VERIFICATION_BUILD_TIMEOUT_MS,
    },
    commandContext,
  );

  const gitStatusOutput = gitStatus.stdout.trim();
  const gitAvailable = gitStatus.exitCode === 0;
  const workspaceChanged =
    gitAvailable &&
    gitStatusOutput !== (baseline.gitStatusSnapshot ?? "");
  const requiresRepositoryChange =
    didExecutionAttemptWorkspaceChange(executionEvents) ||
    doesReplyClaimWorkspaceChange(draftReply);
  const buildPassed = buildResult.exitCode === 0 && !buildResult.timedOut;
  const failureReason = !gitAvailable
    ? "git status could not verify repository changes for this task."
    : requiresRepositoryChange && !workspaceChanged
      ? "git status did not show any new repository changes for this task."
      : !buildPassed
        ? "npm run build failed during mandatory verification."
        : null;

  if (failureReason) {
    const warningEvent = {
      kind: "notice",
      level: "warning",
      message: failureReason,
    } satisfies ToolTurnEvent;
    turnEvents.push(warningEvent);
    ui?.applyToolEvent(warningEvent);
  } else {
    const infoEvent = {
      kind: "notice",
      level: "info",
      message: "Mandatory verification passed: git detected repository changes and npm run build succeeded.",
    } satisfies ToolTurnEvent;
    turnEvents.push(infoEvent);
    ui?.applyToolEvent(infoEvent);
  }

  return {
    gitAvailable,
    workspaceChanged,
    buildPassed,
    buildExitCode: buildResult.exitCode,
    gitStatusOutput,
    gitDiffOutput: gitDiff.stdout.trim(),
    buildStdout: buildResult.stdout,
    buildStderr: buildResult.stderr,
    failureReason,
  };
}

function createInternalVerificationToolContext(
  ui: InteractiveRenderer | null,
  turnEvents: ToolTurnEvent[],
): ToolExecutionContext {
  return {
    commandPolicy: createInternalVerificationCommandPolicy(),
    turnEvents: {
      addEvent: (event) => {
        turnEvents.push(event);
        ui?.applyToolEvent(event);
      },
    },
  };
}

function createInternalVerificationCommandPolicy(): CommandPolicyContext {
  return {
    getMode: () => "allow-all",
    setMode: () => {},
  };
}

function buildVerificationFailureReply(
  reply: string,
  verification: TurnVerificationResult,
): string {
  const lines = [
    verification.failureReason ?? "Mandatory verification failed.",
  ];
  if (!verification.gitAvailable) {
    lines.push("`git status --short --untracked-files=all` did not complete successfully.");
  } else if (!verification.workspaceChanged) {
    lines.push("`git status --short --untracked-files=all` showed no new repository changes compared with the pre-task baseline.");
  } else if (verification.gitStatusOutput) {
    lines.push("Detected repository changes:");
    lines.push(verification.gitStatusOutput);
  }

  if (!verification.buildPassed) {
    lines.push(`\`${VERIFICATION_BUILD_COMMAND}\` failed.`);
    if (verification.buildStderr) {
      lines.push(verification.buildStderr);
    } else if (verification.buildStdout) {
      lines.push(verification.buildStdout);
    }
  }

  if (reply.trim()) {
    lines.push("The previous assistant summary was not accepted because verification failed.");
  }

  return lines.join("\n\n");
}

function didExecutionAttemptWorkspaceChange(events: ToolTurnEvent[]): boolean {
  return events.some((event) =>
    event.kind === "workspace_edit_review" ||
    (event.kind === "command_execution" &&
      event.phase === "completed" &&
      event.category !== "read")
  );
}

function doesReplyClaimWorkspaceChange(reply: string): boolean {
  return /(?:\b(?:added|applied|changed|created|implemented|inserted|modified|renamed|updated|wrote)\b|已(?:修改|添加|实现|插入|更新|写入)|现在会输出|命令已插入)/i
    .test(reply);
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
  const plan = await ensureActiveTaskPlan(session, prompt, state, null);
  const verificationBaseline = await captureVerificationBaseline(session, prompt);
  console.log("user:", prompt);
  console.log("plan:");
  process.stdout.write(renderTaskPlanMarkdown(plan));
  process.stdout.write("assistant: ");

  const result = await runAgentTurn(session, prompt, {
    providerConfig: getActiveProviderConfig(state),
    toolContext: createToolExecutionContext(session, state, null, turnEvents),
    commitHistory: false,
    streamFinalResponse: false,
    onChunk: (chunk) => {
      assistantWriter.writeChunk(chunk);
    },
  });
  const executionEvents = [...turnEvents];
  const verification = await runTurnVerification(
    session,
    prompt,
    verificationBaseline,
    executionEvents,
    result.reply,
    null,
    turnEvents,
  );
  const finalReply = verification?.failureReason
    ? buildVerificationFailureReply(result.reply, verification)
    : result.reply;
  commitAgentTurnHistory(session, prompt, finalReply || "(empty response)");
  applyTurnEventsToSession(state, turnEvents);
  await persistCurrentSession(session, state);

  if (!finalReply) {
    assistantWriter.writeChunk("(empty response)");
  } else {
    assistantWriter.writeChunk(finalReply);
  }

  assistantWriter.end();
  process.stdout.write("\n");
  await renderTurnEvents(null, turnEvents);
}

async function runInteractiveSession(
  session: AgentSession,
  state: InteractiveState,
): Promise<void> {
  const traceEvent = createInteractiveTraceEventSinkFromEnv();
  const ui = createInteractiveRenderer({
    input,
    output,
    minCommandPanelDurationMs: state.minCommandPanelDurationMs,
    onShortcut: (shortcut) => {
      if (shortcut !== "toggle_plan_mode") {
        return;
      }

      togglePlanMode(session, state, ui);
    },
    ...(traceEvent ? { traceEvent } : {}),
  });
  await initializeProviderCatalogForStartup(session, state, ui);

  try {
    while (true) {
      await refreshDeleteAreaBanner(session, state, ui);
      const prompt = await ui.readPrompt({
        promptLabel: getTTYPromptLabel(ui, state, session),
        promptKind: "primary",
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

async function initializeProviderCatalogForStartup(
  session: AgentSession,
  state: InteractiveState,
  ui: InteractiveRenderer,
): Promise<void> {
  const activeProviderId = state.settings.providerSettings.activeProvider;
  const refreshFeedback = await maybeRefreshProviderCatalog(activeProviderId, state);
  renderInteractiveShell(ui, session, state);
  renderProviderCatalogRefreshFeedback(ui, refreshFeedback);
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
      console.log("Commands: /help /provider [openai-compatible|kimi|key|clear-key|model [name]|context [value|auto]|refresh-models|base-url [url|moonshot-cn|moonshot-ai]|timeout <ms>] /model [name] /mode [default|strict|plan|crazy-auto] /approvals [ask|allow-all|reject] /duration [seconds] /settings /session /history [id|index|title] /plan [/reset] /sessions [query] /new [title] /switch <id|index|title> /rename <title> /delete [id|index|title|all] /trash [list|restore <id>|purge <id>|empty YES] /system /editor /system reset /clear /exit");
    }
    return true;
  }

  if (matchesCommand(prompt, "/model")) {
    const modelArgument = parseCommandArgument(prompt, "/model");
    await handleProviderModelShortcut(session, state, ui, modelArgument);
    return true;
  }

  if (matchesCommand(prompt, "/provider")) {
    const providerArgument = parseCommandArgument(prompt, "/provider");

    if (!providerArgument) {
      if (ui) {
        const selectedProvider = await runProviderPicker(
          state.settings.providerSettings.activeProvider,
          ui,
        );
        renderInteractiveShell(ui, session, state);
        if (!selectedProvider) {
          return true;
        }

        state.settings = await saveActiveProvider(selectedProvider);
        await maybePickKimiBaseURL(selectedProvider, session, state, ui);
        if (selectedProvider !== "kimi") {
          await maybePromptForMissingProviderApiKey(selectedProvider, state, ui);
        }
        const refreshFeedback = await maybeRefreshProviderCatalog(selectedProvider, state);
        renderInteractiveShell(ui, session, state);
        renderProviderCatalogRefreshFeedback(ui, refreshFeedback);
        renderProviderApplied(ui, getActiveProviderConfig(state));
        return true;
      }

      renderProviderSummary(ui, state);
      return true;
    }

    const [providerSubcommand, ...providerRest] = providerArgument.split(/\s+/);
    const providerValue = providerRest.join(" ").trim();

    if (!providerSubcommand) {
      renderProviderSummary(ui, state);
      return true;
    }

    if (providerSubcommand === "key") {
      if (!ui) {
        renderError(ui, '"/provider key" requires an interactive terminal.');
        return true;
      }

      const currentProviderId = state.settings.providerSettings.activeProvider;
      await promptForProviderApiKey(currentProviderId, state, ui);
      renderInteractiveShell(ui, session, state);
      renderProviderCatalogRefreshFeedback(
        ui,
        await maybeRefreshProviderCatalog(currentProviderId, state),
      );
      renderProviderSummary(ui, state);
      return true;
    }

    if (providerSubcommand === "clear-key") {
      const currentProviderId = state.settings.providerSettings.activeProvider;
      delete state.providerApiKeyOverrides[currentProviderId];
      delete state.providerApiKeySources[currentProviderId];
      let clearedPersistedSecret = true;
      try {
        await clearPersistedProviderApiKey(currentProviderId);
      } catch (error) {
        clearedPersistedSecret = false;
        renderWarning(
          ui,
          error instanceof Error
            ? `Cleared the current-process API key for ${getProviderDisplayName(currentProviderId)}, but failed to remove the persisted secret: ${error.message}`
            : `Cleared the current-process API key for ${getProviderDisplayName(currentProviderId)}, but failed to remove the persisted secret.`,
        );
      }
      if (ui) {
        renderInteractiveShell(ui, session, state);
      }
      renderInfo(
        ui,
        clearedPersistedSecret
          ? `Cleared the stored API key for ${getProviderDisplayName(currentProviderId)}.`
          : `Cleared the current-process API key for ${getProviderDisplayName(currentProviderId)}.`,
      );
      return true;
    }

    if (providerSubcommand === "model") {
      await handleProviderModelShortcut(session, state, ui, providerValue);
      return true;
    }

    if (providerSubcommand === "context") {
      const currentProviderId = state.settings.providerSettings.activeProvider;
      try {
        if (ui && !providerValue) {
          const provider = getActiveProviderConfig(state);
          const selectedContextLimit = await runProviderContextPicker(
            provider,
            ui,
          );
          renderInteractiveShell(ui, session, state);
          if (selectedContextLimit === undefined) {
            return true;
          }

          state.settings = await saveProviderContextLimitTokens(
            currentProviderId,
            selectedContextLimit,
          );
          renderProviderApplied(ui, getActiveProviderConfig(state));
          return true;
        }

        if (!providerValue) {
          renderError(ui, 'Usage: /provider context <value|auto>');
          return true;
        }

        const parsedContextLimit = parseProviderContextLimit(providerValue);
        state.settings = await saveProviderContextLimitTokens(
          currentProviderId,
          parsedContextLimit,
        );
        if (ui) {
          renderInteractiveShell(ui, session, state);
        }
        renderProviderApplied(ui, getActiveProviderConfig(state));
      } catch (error) {
        renderError(ui, error instanceof Error ? error.message : "Failed to update the provider context.");
      }
      return true;
    }

    if (providerSubcommand === "refresh-models") {
      const currentProviderId = state.settings.providerSettings.activeProvider;
      if (ui) {
        renderInteractiveShell(ui, session, state);
      }
      renderProviderCatalogRefreshFeedback(
        ui,
        await maybeRefreshProviderCatalog(currentProviderId, state),
      );
      renderProviderSummary(ui, state);
      return true;
    }

    if (providerSubcommand === "base-url") {
      const currentProviderId = state.settings.providerSettings.activeProvider;
      if (ui && currentProviderId === "kimi" && !providerValue) {
        const selectedBaseURL = await runKimiBaseURLPicker(
          state.settings.providerSettings.kimi.baseURL,
          ui,
        );
        renderInteractiveShell(ui, session, state);
        if (!selectedBaseURL) {
          return true;
        }

        state.settings = await saveProviderBaseURL(currentProviderId, selectedBaseURL);
        const refreshFeedback = await maybeRefreshProviderCatalog(currentProviderId, state);
        renderInteractiveShell(ui, session, state);
        renderProviderCatalogRefreshFeedback(ui, refreshFeedback);
        renderProviderApplied(ui, getActiveProviderConfig(state));
        return true;
      }

      if (!providerValue) {
        renderError(
          ui,
          currentProviderId === "kimi"
            ? 'Usage: /provider base-url <url|moonshot-cn|moonshot-ai>'
            : 'Usage: /provider base-url <url>',
        );
        return true;
      }

      state.settings = await saveProviderBaseURL(currentProviderId, providerValue);
      const refreshFeedback = await maybeRefreshProviderCatalog(currentProviderId, state);
      if (ui) {
        renderInteractiveShell(ui, session, state);
      }
      renderProviderCatalogRefreshFeedback(ui, refreshFeedback);
      renderProviderApplied(ui, getActiveProviderConfig(state));
      return true;
    }

    if (providerSubcommand === "timeout") {
      if (!providerValue) {
        renderError(ui, 'Usage: /provider timeout <ms>');
        return true;
      }

      const timeoutMs = Number.parseInt(providerValue, 10);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        renderError(ui, "Provider timeout must be a positive integer in milliseconds.");
        return true;
      }

      const currentProviderId = state.settings.providerSettings.activeProvider;
      state.settings = await saveProviderTimeoutMs(currentProviderId, timeoutMs);
      if (ui) {
        renderInteractiveShell(ui, session, state);
      }
      renderProviderApplied(ui, getActiveProviderConfig(state));
      return true;
    }

    try {
      const nextProviderId = parseProviderId(providerSubcommand);
      state.settings = await saveActiveProvider(nextProviderId);
      await maybePickKimiBaseURL(nextProviderId, session, state, ui);
      if (nextProviderId !== "kimi") {
        await maybePromptForMissingProviderApiKey(nextProviderId, state, ui);
      }
      const refreshFeedback = await maybeRefreshProviderCatalog(nextProviderId, state);
      if (ui) {
        renderInteractiveShell(ui, session, state);
      }
      renderProviderCatalogRefreshFeedback(ui, refreshFeedback);
      renderProviderApplied(ui, getActiveProviderConfig(state));
    } catch (error) {
      renderError(
        ui,
        error instanceof Error
          ? error.message
          : "Unknown /provider command.",
      );
    }
    return true;
  }

  if (matchesCommand(prompt, "/mode")) {
    const requestedMode = parseCommandArgument(prompt, "/mode");

    if (ui && !requestedMode) {
      const selectedMode = await runModePicker(
        session.mode,
        state.commandApprovalMode,
        ui,
      );
      renderInteractiveShell(ui, session, state);
      if (selectedMode) {
        applyInteractiveModeChange(session, state, ui, selectedMode);
      }
      return true;
    }

    if (!requestedMode) {
      renderAgentModeSummary(ui, session.mode, state.commandApprovalMode);
      return true;
    }

    try {
      applyInteractiveModeChange(
        session,
        state,
        ui,
        parseInteractiveModeChoice(requestedMode),
      );
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
        parseSlashApprovalMode(requestedMode),
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

  if (prompt === "/plan") {
    await renderPlan(ui, {
      label: formatSessionLabel(state.currentSessionTitle, state.currentSessionId),
      plan: session.activePlan,
      current: true,
    });
    return true;
  }

  if (prompt === "/plan reset") {
    if (!session.activePlan) {
      renderInfo(ui, "No active plan to clear.");
      return true;
    }

    recordSessionEvent(state, {
      timestamp: createSessionEventTimestamp(),
      kind: "plan_reset",
      planId: session.activePlan.id,
      title: session.activePlan.title,
    });
    session.activePlan = null;
    await persistCurrentSession(session, state, { allowEmpty: true });
    if (ui) {
      renderInteractiveShell(ui, session, state);
    }
    renderInfo(ui, "Cleared the active task plan.");
    return true;
  }

  if (matchesCommand(prompt, "/sessions")) {
    const filterQuery = parseCommandArgument(prompt, "/sessions");
    const filteredSessions = filterSessionSummaries(
      state.sessionStore.sessions,
      filterQuery,
    );

    if (ui) {
      const browserResult = await runSessionBrowser(ui, {
        sessions: filteredSessions,
        currentSessionId: state.currentSessionId,
        filterQuery,
      });

      try {
        if (browserResult.kind === "cancel") {
          renderInteractiveShell(ui, session, state);
          return true;
        }

        if (browserResult.kind === "exit") {
          renderInteractiveShell(ui, session, state);
          return false;
        }

        if (browserResult.kind === "new") {
          resetCurrentSession(session, state.settings.systemPrompt);
          state.currentSessionTitle = null;
          state.sessionEvents = [];
          const result = await createSession({
            ...(browserResult.title ? { title: browserResult.title } : {}),
            systemPrompt: session.systemPrompt,
            history: session.history,
            events: state.sessionEvents,
            maxHistoryTurns: session.maxHistoryTurns,
            contextBudget: session.contextBudget,
          });
          state.sessionStore = result.store;
          state.currentSessionId = result.session.id;
          state.currentSessionTitle = result.session.title;
          state.sessionEvents = [...result.session.events];
          renderInteractiveShell(ui, session, state);
          renderNewSessionCreated(ui, result.session);
          return true;
        }

        if (browserResult.kind === "history") {
          const storedSession = await loadSession(browserResult.sessionId);
          renderInteractiveShell(ui, session, state);
          await renderHistory(ui, {
            label: formatSessionLabel(storedSession.title, storedSession.id),
            history: storedSession.history,
            events: storedSession.events,
            current: storedSession.id === state.currentSessionId,
          });
          return true;
        }

        if (browserResult.kind === "rename") {
          if (browserResult.sessionId === state.currentSessionId) {
            await persistCurrentSession(session, state, {
              allowEmpty: true,
              title: browserResult.title,
            });
          } else {
            const result = await renameSession(browserResult.sessionId, browserResult.title);
            state.sessionStore = result.store;
          }

          renderInteractiveShell(ui, session, state);
          renderSessionRenamed(ui, state, browserResult.title, browserResult.sessionId);
          return true;
        }

        if (browserResult.kind === "delete") {
          const deletedCurrent = state.currentSessionId === browserResult.sessionId;
          state.sessionStore = await deleteSession(browserResult.sessionId);

          if (deletedCurrent) {
            if (state.sessionStore.activeSessionId) {
              const activeSession = await loadSession(state.sessionStore.activeSessionId);
              restoreStoredSession(session, activeSession);
              state.currentSessionId = activeSession.id;
              state.currentSessionTitle = activeSession.title;
              state.sessionEvents = [...activeSession.events];
              renderInteractiveShell(ui, session, state);
              renderSessionDeletedAndSwitched(
                ui,
                browserResult.sessionId,
                activeSession,
                session.mode,
              );
              return true;
            }

            resetCurrentSession(session, state.settings.systemPrompt);
            state.currentSessionId = null;
            state.currentSessionTitle = null;
            state.sessionEvents = [];
            renderInteractiveShell(ui, session, state);
            renderSessionDeleted(ui, browserResult.sessionId);
            return true;
          }

          renderInteractiveShell(ui, session, state);
          renderSessionDeleted(ui, browserResult.sessionId);
          return true;
        }

        const storedSession = await loadSession(browserResult.sessionId);
        restoreStoredSession(session, storedSession);
        state.currentSessionId = storedSession.id;
        state.currentSessionTitle = storedSession.title;
        state.sessionEvents = [...storedSession.events];
        state.sessionStore = await setActiveSession(storedSession.id);
        renderInteractiveShell(ui, session, state);
        renderSessionSwitched(ui, storedSession, session.mode);
        return true;
      } catch (error) {
        renderInteractiveShell(ui, session, state);
        renderError(ui, error instanceof Error ? error.message : "Failed to handle session action.");
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
      contextBudget: session.contextBudget,
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

  await ensureActiveTaskPlan(session, prompt, state, ui);
  const verificationBaseline = await captureVerificationBaseline(session, prompt);

  if (ui) {
    ui.beginAgentTurn(prompt);
  } else {
    process.stdout.write("assistant: ");
  }

  const turnEvents: ToolTurnEvent[] = [];

  let reply = "";
  let finalReply = "";
  let verification: TurnVerificationResult | null = null;
  let turnFailureMessage: string | null = null;
  let shouldCommitHistory = false;
  let shouldCompleteTurn = false;
  const requestAbortController = ui ? new AbortController() : null;
  let exitRequestedDuringTurn = false;
  let contextBudgetSnapshot = buildEstimatedTurnContextBudgetSnapshot(session, prompt, state);
  try {
    const result = await runAgentTurn(session, prompt, {
      providerConfig: getActiveProviderConfig(state),
      toolContext: createToolExecutionContext(session, state, ui, turnEvents),
      commitHistory: false,
      streamFinalResponse: false,
      ...(requestAbortController
        ? { abortSignal: requestAbortController.signal }
        : {}),
      onModelRequestStateChange: (active) => {
        ui?.setActiveRequestCancel(active
          ? () => {
              requestAbortController?.abort(new Error("Cancelled the active AI request."));
            }
          : null);
        ui?.setActiveRequestInterrupt(active
          ? () => {
              exitRequestedDuringTurn = true;
              requestAbortController?.abort(new Error("Interrupted the active session."));
            }
          : null);
      },
      onChunk: (chunk) => {
        if (ui) {
          ui.appendAssistantChunk(chunk);
          return;
        }

        process.stdout.write(chunk);
      },
    });
    reply = result.reply;
    contextBudgetSnapshot = result.contextBudgetSnapshot;
    if (result.trimmedTurns > 0) {
      renderWarning(
        ui,
        `Context budget trimmed ${result.trimmedTurns} older turn${result.trimmedTurns === 1 ? "" : "s"} before this request.`,
      );
    }
    verification = await runTurnVerification(
      session,
      prompt,
      verificationBaseline,
      [...turnEvents],
      reply,
      ui,
      turnEvents,
    );
    finalReply = verification?.failureReason
      ? buildVerificationFailureReply(reply, verification)
      : reply;
    shouldCommitHistory = true;
    shouldCompleteTurn = !verification?.failureReason;
  } catch (error) {
    turnFailureMessage = formatAgentTurnFailureMessage(error);
  } finally {
    ui?.setActiveRequestCancel(null);
    ui?.setActiveRequestInterrupt(null);
  }

  session.contextBudget = contextBudgetSnapshot;
  if (shouldCommitHistory) {
    commitAgentTurnHistory(session, prompt, finalReply || "(empty response)");
  }
  applyTurnEventsToSession(state, turnEvents);
  await persistCurrentSession(session, state, { allowEmpty: true });
  await refreshDeleteAreaBanner(session, state, ui);

  if (turnFailureMessage) {
    if (ui) {
      ui.failActiveTurn(turnFailureMessage);
    }
  } else if (verification?.failureReason) {
    if (ui) {
      ui.failActiveTurn(finalReply);
    } else {
      process.stdout.write(finalReply);
    }
  } else if (!finalReply) {
    if (ui) {
      ui.appendAssistantChunk("(empty response)");
    } else {
      process.stdout.write("(empty response)");
    }
  } else if (ui) {
    ui.appendAssistantChunk(finalReply);
  } else {
    process.stdout.write(finalReply);
  }

  if (ui && shouldCompleteTurn) {
    ui.completeActiveTurn();
  }

  if (!ui && !turnFailureMessage) {
    process.stdout.write("\n");
  }
  await renderTurnEvents(ui, turnEvents);
  if (turnFailureMessage && !ui) {
    throw new Error(turnFailureMessage);
  }

  return !exitRequestedDuringTurn;
}

function buildEstimatedTurnContextBudgetSnapshot(
  session: AgentSession,
  prompt: string,
  state: InteractiveState,
) {
  const providerConfig = getActiveProviderConfig(state);
  const estimatedPromptTokens = estimateChatMessageTokens(
    buildTurnMessages(session, prompt.trim()),
  );
  return buildContextBudgetSnapshot({
    modelContextTokens: providerConfig.modelContextTokens,
    configuredContextLimitTokens: providerConfig.contextLimitTokens,
    estimatedPromptTokens,
  });
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
  session.activePlan = null;
  session.contextBudget = createEmptyContextBudgetSnapshot();
}

function getTTYPromptLabel(
  ui: InteractiveRenderer,
  state: InteractiveState,
  session: AgentSession,
): string {
  return state.pendingSystemPromptLines
    ? ui.editorPromptLabel
    : session.mode === "plan"
      ? "plan > "
      : ui.promptLabel;
}

function getPendingSystemPromptDraft(
  lines: string[],
  currentPrompt: string,
): string {
  const draft = lines.join("\n").trim();
  return draft || currentPrompt;
}

function getInitialPlanReturnMode(mode: AgentMode): InteractiveNonPlanMode {
  return mode === "strict" ? "strict" : "default";
}

function formatApprovalModeDisplay(
  mode: AgentMode,
  approvalMode: CommandApprovalMode,
): string {
  return mode === "plan" ? "inactive" : approvalMode;
}

function buildInteractiveShellFrame(
  session: AgentSession,
  state: InteractiveState,
): {
  title: string;
  workspaceLines: Array<Omit<RendererLine, "id">>;
  statusLines: Array<Omit<RendererLine, "id">>;
  noticeLines: Array<Omit<RendererLine, "id">>;
  planLines: Array<Omit<RendererLine, "id">>;
  footerLines: Array<Omit<RendererLine, "id">>;
  contextMeter: RendererContextMeter | null;
} {
  const stats = getAgentSessionStats(session);
  const provider = getActiveProviderConfig(state);
  const effectiveContextLimitTokens =
    provider.contextLimitTokens ??
    provider.modelContextTokens ??
    stats.effectiveContextLimitTokens;
  const contextDisplay = buildContextIndicatorDisplay(
    stats.currentContextTokens,
    effectiveContextLimitTokens,
  );
  const contextLineColor = getContextIndicatorLineColor(contextDisplay.tone);
  const sessionLabel = state.currentSessionId
    ? formatSessionLabel(state.currentSessionTitle, state.currentSessionId)
    : state.sessionStore.sessions.length === 0
      ? "unsaved"
      : "not loaded";
  const workspaceLines: Array<Omit<RendererLine, "id">> = [
    {
      kind: "info",
      text: `${provider.label}  ${provider.model}  ${process.cwd()}`,
    },
    {
      kind: "info",
      text: `session ${sessionLabel}`,
    },
    {
      kind: "info",
      text: `provider ${formatProviderStatus(provider)}  mode ${formatInteractiveModeLabel(session.mode, state.commandApprovalMode)}  approvals ${formatApprovalModeDisplay(session.mode, state.commandApprovalMode)}`,
    },
  ];
  const statusLines: Array<Omit<RendererLine, "id">> = [
    {
      kind: "info",
      text: `context  ${contextDisplay.usedText} / ${contextDisplay.limitText}  (${contextDisplay.percentText})`,
      ...(contextLineColor ? { color: contextLineColor } : {}),
      dimColor: contextDisplay.tone === "muted",
    },
    {
      kind: "info",
      text: `saved    ${state.sessionStore.sessions.length}`,
    },
    {
      kind: "info",
      text: `duration ${formatCommandPanelDurationSeconds(state.minCommandPanelDurationMs)}s`,
    },
    {
      kind: "info",
      text: `catalog ${describeProviderCatalogStatus(provider, state.providerCatalog)}  source ${stats.contextUsageSource ?? "unknown"}`,
    },
  ];

  if (contextDisplay.isNearFull) {
    statusLines.push({
      kind: "info",
      text: 'Context nearly full. Consider "/new" to start fresh.',
      color: "redBright",
    });
  }

  if (state.sessionStore.sessions.length === 0) {
    statusLines.push({
      kind: "info",
      text: "No saved sessions yet.",
    });
  }

  return {
    title: "SuperRun",
    workspaceLines,
    statusLines,
    noticeLines: buildNoticeBannerLines(session, state),
    planLines: buildPlanCardLines(session.activePlan),
    footerLines: [
      {
        kind: "body",
        text: "commands /help /provider /model /plan /sessions /new [title] /mode /approvals /duration /system /clear /exit",
      },
      {
        kind: "body",
        text: session.mode === "plan"
          ? "keys Shift+Tab exit plan mode  Enter submit  Plan mode is read-only and suggestions-only"
          : "keys Shift+Tab start plan mode  Enter submit  Plan mode keeps the agent read-only",
      },
    ],
    contextMeter: buildContextMeter(stats, effectiveContextLimitTokens, provider.model),
  };
}

function buildNoticeBannerLines(
  session: AgentSession,
  state: InteractiveState,
): Array<Omit<RendererLine, "id">> {
  const lines: Array<Omit<RendererLine, "id">> = [];

  if (session.mode === "plan") {
    lines.push({
      kind: "info",
      text: "Plan mode active: the agent can inspect local files, ask focused clarifying questions, and propose changes, but it cannot edit files or run commands.",
    });
  }

  const deleteAreaBannerText = getDeleteAreaBannerText(state.deleteAreaStatus);
  if (deleteAreaBannerText) {
    lines.push({
      kind: "warning",
      text: deleteAreaBannerText,
    });
  }

  return lines;
}

function buildPlanCardLines(
  plan: TaskPlan | null,
): Array<Omit<RendererLine, "id">> {
  if (!plan) {
    return [];
  }

  const progress = getTaskPlanProgress(plan);
  const activeStep = getActiveTaskPlanStep(plan);
  const lines: Array<Omit<RendererLine, "id">> = [
    {
      kind: "section",
      text: `plan  ${plan.title}`,
    },
    {
      kind: "info",
      text: `progress  ${formatTaskPlanSummary(plan)}  in progress ${progress.inProgressSteps}  blocked ${progress.blockedSteps}`,
    },
  ];

  if (activeStep) {
    lines.push({
      kind: "info",
      text: `current  ${activeStep.title}`,
    });
  }

  for (const step of plan.steps.slice(0, 5)) {
    lines.push({
      kind: step.status === "completed"
        ? "info"
        : step.status === "blocked"
          ? "warning"
          : "body",
      text: `${formatPlanStepBullet(step.status)} ${step.title}`,
    });
  }

  if (plan.steps.length > 5) {
    lines.push({
      kind: "body",
      text: `... ${plan.steps.length - 5} more step${plan.steps.length - 5 === 1 ? "" : "s"}  use /plan`,
    });
  }

  return lines;
}

function formatPlanStepBullet(
  status: TaskPlan["steps"][number]["status"],
): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[~]";
    case "blocked":
      return "[!]";
    default:
      return "[ ]";
  }
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
    ui.setPromptLabel(getTTYPromptLabel(ui, state, session));
  }
}

function renderSessionPromptHint(
  ui: InteractiveRenderer | null,
  session: AgentSession,
  settings: Pick<SuperRunSettings, "systemPrompt" | "hasStoredSystemPrompt">,
): void {
  const stats = getAgentSessionStats(session);
  const source = settings.hasStoredSystemPrompt ? "saved profile" : "built-in default";
  renderInfo(
    ui,
    `Tool mode: ${getAgentModeSummary(session.mode)}.`,
  );
  renderInfo(
    ui,
    `Active behavior (${source}): ${summarizePrompt(session.systemPrompt)}`,
  );
  renderInfo(
    ui,
    `Context: ${formatContextUsage(stats.currentContextTokens, stats.effectiveContextLimitTokens)} used, source ${stats.contextUsageSource ?? "unknown"}.`,
  );
  renderInfo(
    ui,
    'Use "/mode plan" or Shift+Tab for read-only planning, "/approvals" to tune normal approval behavior, or "/mode crazy-auto" to remove the remaining guardrails for this session.',
  );
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
  if (ui && !argument) {
    await runTrashBrowser(session, state, ui);
    return;
  }

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

async function runTrashBrowser(
  session: AgentSession,
  state: InteractiveState,
  ui: InteractiveRenderer,
): Promise<void> {
  while (true) {
    const trash = await listWorkspaceTrashEntries();
    const selectedAction = await ui.selectOption({
      title: "Delete Area",
      subtitle:
        `${trash.status.fileCount} file${trash.status.fileCount === 1 ? "" : "s"} | ${formatDeleteAreaKilobytes(trash.status.totalBytes)} KB`,
      helpText: "Up/Down move  Enter select  Esc cancel",
      options: buildTrashActionChoices(trash.status.fileCount).map((choice) => ({
        value: choice.value,
        label: choice.name,
        description: choice.description,
        tone: choice.tone,
      })),
    });
    renderInteractiveShell(ui, session, state);

    if (selectedAction === null) {
      return;
    }

    if (selectedAction === "view") {
      await ui.viewText({
        title: "Delete Area",
        subtitle:
          `${trash.status.fileCount} file${trash.status.fileCount === 1 ? "" : "s"} | ${formatDeleteAreaKilobytes(trash.status.totalBytes)} KB`,
        helpText: "Up/Down scroll  PgUp/PgDn page  q close  Esc close",
        emptyMessage: "Delete area is empty.",
        lines: buildTrashViewerLines(trash),
      });
      renderInteractiveShell(ui, session, state);
      continue;
    }

    if (selectedAction === "empty") {
      const confirmed = await runTrashEmptyConfirmationPicker(
        trash.status.fileCount,
        ui,
      );
      renderInteractiveShell(ui, session, state);
      if (!confirmed) {
        continue;
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

    if (selectedAction !== "restore" && selectedAction !== "purge") {
      renderError(ui, `Unknown delete-area action: ${selectedAction}`);
      return;
    }

    const selectedEntryId = await runTrashEntryPicker(
      trash.entries,
      selectedAction,
      ui,
    );
    renderInteractiveShell(ui, session, state);
    if (!selectedEntryId) {
      continue;
    }

    try {
      if (selectedAction === "restore") {
        const result = await restoreWorkspaceFileFromTrash(selectedEntryId);
        await refreshDeleteAreaBanner(session, state, ui);
        renderInfo(ui, `Restored deleted file: ${result.entry.originalPath} -> ${result.restoredPath}`);
      } else {
        const result = await purgeWorkspaceFileFromTrash(selectedEntryId);
        await refreshDeleteAreaBanner(session, state, ui);
        renderInfo(ui, `Purged deleted file: ${result.entry.originalPath} [${result.entry.id}]`);
      }
    } catch (error) {
      renderError(
        ui,
        error instanceof Error
          ? error.message
          : selectedAction === "restore"
            ? "Failed to restore deleted file."
            : "Failed to purge deleted file.",
      );
    }
    return;
  }
}

function renderTrashHelp(ui: InteractiveRenderer | null): void {
  if (ui) {
    ui.renderSectionTitle("Delete Area");
  } else {
    console.log("Delete Area");
  }

  renderInfo(ui, "/trash");
  renderInfo(ui, "/trash list");
  renderInfo(ui, "/trash restore <id>");
  renderInfo(ui, "/trash purge <id>");
  renderInfo(ui, "/trash empty YES");
}

async function runTrashEntryPicker(
  entries: Awaited<ReturnType<typeof listWorkspaceTrashEntries>>["entries"],
  action: Exclude<TrashActionValue, "view" | "empty">,
  ui: InteractiveRenderer,
): Promise<string | null> {
  return ui.selectOption({
    title: action === "restore" ? "Restore Deleted File" : "Delete Permanently",
    subtitle:
      action === "restore"
        ? "Choose one deleted file to restore into the workspace."
        : "Choose one deleted file to remove permanently from the delete area.",
    helpText: "Up/Down move  Enter select  Esc back",
    options: buildTrashEntryChoices(entries, action).map((choice) => ({
      value: choice.value,
      label: choice.name,
      description: choice.description,
      tone: choice.tone,
    })),
  });
}

async function runTrashEmptyConfirmationPicker(
  fileCount: number,
  ui: InteractiveRenderer,
): Promise<boolean> {
  const selectedValue = await ui.selectOption({
    title: "Empty Delete Area",
    subtitle:
      `Permanently remove ${fileCount} file${fileCount === 1 ? "" : "s"} from the delete area.`,
    helpText: "Up/Down move  Enter confirm  Esc cancel",
    options: [
      {
        value: "confirm",
        label: "Empty delete area",
        description: "Delete every file in the delete area permanently.",
        tone: "danger",
      },
      {
        value: null,
        label: "Keep deleted files",
        description: "Return to the delete area without removing anything.",
        tone: "default",
      },
    ],
  });

  return selectedValue === "confirm";
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

function buildTrashViewerLines(
  trash: Awaited<ReturnType<typeof listWorkspaceTrashEntries>>,
): RendererViewerLine[] {
  const lines: RendererViewerLine[] = [
    {
      text:
        `Delete area: ${trash.status.fileCount} file${trash.status.fileCount === 1 ? "" : "s"}, about ${formatDeleteAreaKilobytes(trash.status.totalBytes)} KB.`,
      tone: "info",
    },
  ];

  if (trash.entries.length === 0) {
    return lines;
  }

  lines.push({ text: "" });

  for (const [index, entry] of trash.entries.entries()) {
    lines.push({
      text: `${index + 1}. ${entry.originalPath}`,
      tone: "default",
    });
    lines.push({
      text: `${entry.id}  ${formatDeleteAreaKilobytes(entry.sizeBytes)} KB  ${formatTimestamp(entry.deletedAt)}`,
      tone: "info",
      indent: 3,
      format: "plain",
    });
  }

  return lines;
}

function renderSettingsSummary(
  ui: InteractiveRenderer | null,
  session: AgentSession,
  settings: SuperRunSettings,
  state: Pick<
    InteractiveState,
    "minCommandPanelDurationMs" | "providerApiKeyOverrides" | "providerApiKeySources" | "providerCatalog"
  >,
): void {
  const stats = getAgentSessionStats(session);
  const source = settings.hasStoredSystemPrompt ? "saved profile" : "built-in default";
  const provider = getActiveProviderConfig({
    settings,
    providerApiKeyOverrides: state.providerApiKeyOverrides,
    providerApiKeySources: state.providerApiKeySources,
    providerCatalog: state.providerCatalog,
  });

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
    `Context policy: ${formatContextUsage(stats.currentContextTokens, stats.effectiveContextLimitTokens)} used, source ${stats.contextUsageSource ?? "unknown"}.`,
  );
  renderInfo(
    ui,
    `Current transcript: ${stats.historyTurnCount} turns, ${stats.historyMessageCount} messages, ${stats.historyCharCount} chars.`,
  );
  renderInfo(
    ui,
    `Provider: ${provider.label}  model ${provider.model}  timeout ${provider.timeoutMs}ms  key ${formatProviderApiKeyStatus(provider)}.`,
  );
  renderInfo(ui, `Provider base URL: ${provider.baseURL}`);
  renderInfo(
    ui,
    `Provider context: configured ${formatTokenCount(provider.contextLimitTokens)}  model ${formatTokenCount(provider.modelContextTokens)}  effective ${formatTokenCount(stats.effectiveContextLimitTokens)}.`,
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

function renderProviderSummary(
  ui: InteractiveRenderer | null,
  state: Pick<
    InteractiveState,
    "settings" | "providerApiKeyOverrides" | "providerApiKeySources" | "providerCatalog"
  >,
): void {
  const provider = getActiveProviderConfig(state);
  const selectedCatalogModel =
    provider.id === "kimi"
      ? state.providerCatalog.kimi.models.find((model) => model.id === provider.model)
      : null;
  renderInfo(
    ui,
    `Provider: ${provider.label}  model ${provider.model}  timeout ${provider.timeoutMs}ms  key ${formatProviderApiKeyStatus(provider)}.`,
  );
  renderInfo(ui, `Base URL: ${provider.baseURL}`);
  renderInfo(
    ui,
    `Catalog: ${describeProviderCatalogStatus(provider, state.providerCatalog)}.`,
  );
  renderInfo(
    ui,
    `Context: configured ${formatTokenCount(provider.contextLimitTokens)}  model ${formatTokenCount(provider.modelContextTokens)}  source ${provider.modelContextSource}.`,
  );
  if (provider.id === "kimi") {
    renderInfo(
      ui,
      selectedCatalogModel
        ? `Current model access: listed in the loaded catalog with ${formatTokenCount(selectedCatalogModel.contextTokens)} context.`
        : state.providerCatalog.kimi.status === "ready"
          ? 'Current model access: not present in the loaded Kimi catalog. Use "/model" to switch.'
          : "Current model access: unknown until the Kimi catalog loads successfully.",
    );
  }
  renderInfo(
    ui,
    'Use "/provider key" to set a locally stored API key, "/provider clear-key" to remove it, "/model" or "/provider model" to choose a Kimi model, and "/provider context" to adjust the provider token budget.',
  );
  if (provider.id === "openai_compatible") {
    renderInfo(
      ui,
      'Use "/provider base-url <url>" to point the OpenAI-compatible provider at a different endpoint.',
    );
    return;
  }

  renderInfo(
    ui,
    `Use "/provider base-url" to pick a Kimi endpoint, "/provider refresh-models" to reload the Kimi catalog, or pass moonshot-cn / moonshot-ai directly to switch between ${DEFAULT_KIMI_BASE_URL} and ${ALTERNATE_KIMI_BASE_URL}.`,
  );
}

function renderProviderApplied(
  ui: InteractiveRenderer | null,
  provider: ProviderRuntimeConfig,
): void {
  renderInfo(
    ui,
    `Active provider: ${provider.label}  model ${provider.model}  key ${formatProviderApiKeyStatus(provider)}  context ${formatTokenCount(provider.contextLimitTokens)} / ${formatTokenCount(provider.modelContextTokens)}.`,
  );
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
  const provider = getActiveProviderConfig(state);
  const effectiveContextLimitTokens =
    provider.contextLimitTokens ??
    provider.modelContextTokens ??
    currentStats.effectiveContextLimitTokens;

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
    `Current transcript: ${currentStats.historyTurnCount} turns, ${currentStats.historyMessageCount} messages, ${currentStats.historyCharCount} chars.`,
  );
  renderInfo(
    ui,
    `Context budget: ${formatContextUsage(currentStats.currentContextTokens, effectiveContextLimitTokens)}  source ${currentStats.contextUsageSource ?? "unknown"}.`,
  );
  renderInfo(
    ui,
    session.activePlan
      ? `Active plan: ${session.activePlan.title} (${formatTaskPlanSummary(session.activePlan)}).`
      : "Active plan: none.",
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

async function renderPlan(
  ui: InteractiveRenderer | null,
  options: {
    label: string;
    plan: TaskPlan | null;
    current: boolean;
  },
): Promise<void> {
  if (ui) {
    await ui.viewText({
      title: "Plan",
      subtitle: options.label,
      helpText: "Up/Down scroll  PgUp/PgDn page  q close  Esc close",
      emptyMessage: "No active plan.",
      lines: buildPlanViewerLines(options),
    });
    return;
  }

  console.log("Plan");
  renderInfo(ui, `Session: ${options.label}`);
  if (options.current) {
    renderInfo(ui, "Viewing the current plan.");
  }
  if (!options.plan) {
    renderInfo(ui, "No active plan.");
    return;
  }

  for (const line of renderTaskPlanMarkdown(options.plan).trimEnd().split(/\r?\n/)) {
    writeBodyLine(ui, line);
  }
}

function buildPlanViewerLines(options: {
  label: string;
  plan: TaskPlan | null;
  current: boolean;
}): RendererViewerLine[] {
  const lines: RendererViewerLine[] = [
    { text: `Session: ${options.label}`, tone: "info" },
    {
      text: options.current
        ? "Viewing the current plan."
        : "Viewing a saved plan.",
      tone: "info",
    },
  ];
  if (!options.plan) {
    return lines;
  }

  lines.push({ text: "" });
  for (const line of renderTaskPlanMarkdown(options.plan).trimEnd().split(/\r?\n/)) {
    lines.push({
      text: line,
      format: "rich_text",
    });
  }
  return lines;
}

async function ensureActiveTaskPlan(
  session: AgentSession,
  prompt: string,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
): Promise<TaskPlan> {
  const nextPlanResult = await generateTaskPlan(session, prompt, state);
  const nextPlan = nextPlanResult.plan;
  if (session.activePlan) {
    recordSessionEvent(state, {
      timestamp: createSessionEventTimestamp(),
      kind: "plan_reset",
      planId: session.activePlan.id,
      title: session.activePlan.title,
    });
  }

  session.activePlan = nextPlan;
  if (nextPlanResult.source === "fallback" && nextPlanResult.lastFailureMessage) {
    recordSessionEvent(state, {
      timestamp: createSessionEventTimestamp(),
      kind: "plan_fallback_used",
      title: nextPlan.title,
      attempts: nextPlanResult.attempts,
      reason: nextPlanResult.lastFailureMessage,
    });
  }
  recordSessionEvent(state, {
    timestamp: createSessionEventTimestamp(),
    kind: "plan_created",
    planId: nextPlan.id,
    title: nextPlan.title,
    stepCount: nextPlan.steps.length,
  });
  await persistCurrentSession(session, state, { allowEmpty: true });
  if (ui) {
    renderInteractiveShell(ui, session, state);
  }
  return nextPlan;
}

async function generateTaskPlan(
  session: AgentSession,
  prompt: string,
  state: InteractiveState,
): Promise<TaskPlanGenerationResult> {
  let previousFailureMessage: string | null = null;

  for (let attempt = 0; attempt < TASK_PLAN_GENERATION_ATTEMPTS; attempt += 1) {
    try {
      const response = await requestTaskPlanDraft(session, prompt, state, previousFailureMessage);
      const parsed = parseTaskPlanResponse(response.content);
      return {
        plan: createTaskPlan({
          title: parsed.title || summarizePromptForPlan(prompt),
          sourcePrompt: prompt,
          steps: parsed.steps.map((step) => ({
            title: step.title,
            ...(step.details ? { details: step.details } : {}),
          })),
        }),
        source: "model",
        attempts: attempt + 1,
        lastFailureMessage: null,
      };
    } catch (error) {
      previousFailureMessage =
        error instanceof Error ? error.message : "Unknown planning error.";
    }
  }

  return {
    plan: createFallbackTaskPlan(prompt),
    source: "fallback",
    attempts: TASK_PLAN_GENERATION_ATTEMPTS,
    lastFailureMessage: previousFailureMessage,
  };
}

async function requestTaskPlanDraft(
  session: AgentSession,
  prompt: string,
  state: InteractiveState,
  previousFailureMessage: string | null,
) {
  let timeoutRetryCount = 0;

  while (true) {
    try {
      return await chatOnce(
        buildTaskPlanMessages(session, prompt, previousFailureMessage),
        {
          providerConfig: getActiveProviderConfig(state),
        },
      );
    } catch (error) {
      if (!isProviderRequestTimeoutMessage(error) || timeoutRetryCount >= TASK_PLAN_TIMEOUT_RETRIES) {
        throw error;
      }

      timeoutRetryCount += 1;
      previousFailureMessage = [
        previousFailureMessage,
        `The previous planning request timed out (${error.message}). Continue the same planning task and return strict JSON only.`,
      ].filter(Boolean).join(" ");
    }
  }
}

function buildTaskPlanMessages(
  session: AgentSession,
  prompt: string,
  previousFailureMessage: string | null = null,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  return [
    {
      role: "system",
      content: [
        session.systemPrompt,
        'Create an execution plan for the user\'s task before implementation begins.',
        'Return JSON only with this exact shape: {"title":"short title","steps":[{"title":"step title","details":"short detail"}]}.',
        "Use 3 to 7 minimal executable steps.",
        "Keep each step concrete and implementation-oriented.",
        "Do not use tools and do not serialize tool calls into the response.",
        "Do not include markdown, explanations, or extra keys.",
        ...(previousFailureMessage
          ? [`The previous planning attempt was invalid: ${previousFailureMessage}. Fix the output and return strict JSON only.`]
          : []),
      ].join("\n\n"),
    },
    ...session.history.slice(-TASK_PLAN_HISTORY_CONTEXT_MESSAGES),
    {
      role: "user",
      content: `Task:\n${prompt}`,
    },
  ];
}

function parseTaskPlanResponse(content: string): {
  title: string;
  steps: Array<{ title: string; details?: string }>;
} {
  const normalized = content.trim();
  const stripped = normalized.startsWith("```")
    ? normalized.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()
    : normalized;
  const jsonText = extractJsonObject(stripped);
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const steps = rawSteps
    .map((step) => {
      if (!step || typeof step !== "object") {
        return null;
      }

      const candidate = step as Record<string, unknown>;
      const stepTitle = typeof candidate.title === "string" ? candidate.title.trim() : "";
      const stepDetails =
        typeof candidate.details === "string" ? candidate.details.trim() : "";
      if (!stepTitle) {
        return null;
      }
      return {
        title: stepTitle,
        ...(stepDetails ? { details: stepDetails } : {}),
      };
    })
    .filter((step): step is { title: string; details?: string } => step !== null);
  if (steps.length === 0) {
    throw new Error("Planning response did not include any valid steps.");
  }

  return { title, steps };
}

function extractJsonObject(value: string): string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Planning response did not contain a JSON object.");
  }

  return value.slice(start, end + 1);
}

function createFallbackTaskPlan(prompt: string): TaskPlan {
  return createTaskPlan({
    title: summarizePromptForPlan(prompt),
    sourcePrompt: prompt,
    steps: [
      { title: "Inspect the relevant code and constraints", details: "Locate the files, flows, and current behavior involved in the task." },
      { title: "Implement the smallest viable change", details: "Update the targeted code path without broad refactors." },
      { title: "Verify the result and summarize any follow-up", details: "Run focused checks and confirm the behavior matches the request." },
    ],
  });
}

function isProviderRequestTimeoutMessage(error: unknown): error is Error {
  return error instanceof Error &&
    /Request timed out after \d+ms\./.test(error.message);
}

function summarizePromptForPlan(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= 48) {
    return normalized || "Task plan";
  }

  return `${normalized.slice(0, 45)}...`;
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
      const messageTone = message.role === "user" ? "info" : "default";
      lines.push({
        text: `${index + 1}. ${speaker}`,
        tone: messageTone,
      });
      lines.push(...buildHistoryMessageContentLines(message.content, messageTone));

      if (index < options.history.length - 1) {
        lines.push({ text: "" });
      }
    }
  }

  return lines;
}

function buildHistoryMessageContentLines(
  content: string,
  tone: NonNullable<RendererViewerLine["tone"]>,
): RendererViewerLine[] {
  const lines: RendererViewerLine[] = [];
  const contentLines = content.split(/\r?\n/);
  let inCodeFence = false;

  for (let index = 0; index < contentLines.length; index += 1) {
    const line = contentLines[index] ?? "";

    if (!inCodeFence) {
      // Convert markdown tables into preformatted rows so the history viewer
      // shows a readable grid instead of raw pipe syntax.
      const tableMatch = parseMarkdownTable(contentLines, index);
      if (tableMatch) {
        lines.push(
          ...renderMarkdownTableLines(tableMatch.table, process.stdout.columns || undefined).map((tableLine) => ({
            text: tableLine,
            tone,
            format: "plain" as const,
            indent: 3,
          })),
        );
        index = tableMatch.nextIndex - 1;
        continue;
      }
    }

    const isFence = /^```/.test(line.trimStart());
    if (isFence) {
      inCodeFence = !inCodeFence;
      lines.push({
        text: line,
        tone,
        format: "plain",
        indent: 3,
      });
      continue;
    }

    if (inCodeFence) {
      lines.push({
        text: `| ${line}`,
        tone,
        format: "plain",
        indent: 3,
      });
      continue;
    }

    lines.push({
      text: line,
      tone,
      format: "rich_text",
      indent: 3,
    });
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
    `Context: ${formatContextUsage(stats.currentContextTokens, stats.effectiveContextLimitTokens)} used, source ${stats.contextUsageSource ?? "unknown"}.`,
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
      contextBudget: storedSession.contextBudget,
    }),
  );

  renderInfo(
    ui,
    `Switched to session: ${formatSessionLabel(storedSession.title, storedSession.id)}`,
  );
  renderInfo(
    ui,
    `Context: ${formatContextUsage(stats.currentContextTokens, stats.effectiveContextLimitTokens)} used, source ${stats.contextUsageSource ?? "unknown"}.`,
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
  title?: string,
  sessionId?: string | null,
): void {
  renderInfo(
    ui,
    `Renamed session: ${formatSessionLabel(
      title ?? state.currentSessionTitle,
      sessionId ?? state.currentSessionId,
    )}`,
  );
}

function renderAgentModeSummary(
  ui: InteractiveRenderer | null,
  mode: AgentMode,
  approvalMode: CommandApprovalMode,
): void {
  renderInfo(ui, `Current tool mode: ${getInteractiveModeSummary(mode, approvalMode)}.`);
  renderInfo(
    ui,
    'Use Shift+Tab to toggle plan mode quickly, "/mode plan" for read-only planning, "/mode strict" for specialized read-only tools, "/mode default" for guarded command execution, or "/mode crazy-auto" to auto-approve elevated-risk local actions.',
  );
}

function renderAgentModeChanged(
  ui: InteractiveRenderer | null,
  mode: AgentMode,
  approvalMode: CommandApprovalMode,
): void {
  renderInfo(ui, `Tool mode changed to ${getInteractiveModeSummary(mode, approvalMode)}.`);
}

function togglePlanMode(
  session: AgentSession,
  state: InteractiveState,
  ui: InteractiveRenderer,
): void {
  if (state.pendingSystemPromptLines) {
    return;
  }

  if (session.mode === "plan") {
    session.mode = state.lastNonPlanMode;
    ui.setPromptLabel(getTTYPromptLabel(ui, state, session));
    ui.setShellFrame(buildInteractiveShellFrame(session, state));
    renderInfo(
      ui,
      `Plan mode disabled. Restored ${getInteractiveModeSummary(session.mode, state.commandApprovalMode)}.`,
    );
    return;
  }

  state.lastNonPlanMode = session.mode === "strict" ? "strict" : "default";
  session.mode = "plan";
  ui.setPromptLabel(getTTYPromptLabel(ui, state, session));
  ui.setShellFrame(buildInteractiveShellFrame(session, state));
  renderInfo(
    ui,
    "Plan mode enabled. The agent is now limited to read-only repository inspection, focused clarification questions, and suggested changes.",
  );
}

function parseInteractiveModeChoice(
  value: string | null | undefined,
): InteractiveModeChoiceValue {
  const normalized = value?.trim().toLowerCase() ?? "default";
  if (normalized === CRAZY_AUTO_MODE_VALUE || normalized === "crazy_auto") {
    return CRAZY_AUTO_MODE_VALUE;
  }

  return parseAgentMode(normalized);
}

function parseSlashApprovalMode(
  value: string | null | undefined,
): SlashApprovalMode {
  const parsedMode = parseCommandApprovalMode(value);
  if (parsedMode === "crazy_auto") {
    throw new Error(
      'Invalid approval mode: crazy_auto. Use "ask", "allow-all", or "reject". Use "/mode crazy-auto" for full auto-approval.',
    );
  }

  return parsedMode;
}

function getInteractiveModeSummary(
  mode: AgentMode,
  approvalMode: CommandApprovalMode,
): string {
  if (mode === "default" && approvalMode === "crazy_auto") {
    return "crazy-auto (default tools plus auto-approved file edits and elevated-risk shell commands)";
  }

  return getAgentModeSummary(mode);
}

function formatInteractiveModeLabel(
  mode: AgentMode,
  approvalMode: CommandApprovalMode,
): string {
  return mode === "default" && approvalMode === "crazy_auto" ? CRAZY_AUTO_MODE_VALUE : mode;
}

function applyInteractiveModeChange(
  session: AgentSession,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
  nextMode: InteractiveModeChoiceValue,
): void {
  if (nextMode === CRAZY_AUTO_MODE_VALUE) {
    session.mode = "default";
    state.lastNonPlanMode = "default";
    applyApprovalModeChange(session, state, ui, "crazy_auto", "slash_command");
    renderAgentModeChanged(ui, session.mode, state.commandApprovalMode);
    return;
  }

  session.mode = nextMode;
  if (nextMode !== "plan") {
    state.lastNonPlanMode = nextMode;
  }
  if (session.mode !== "plan" && state.commandApprovalMode === "crazy_auto") {
    applyApprovalModeChange(session, state, ui, "ask", "slash_command");
  }
  if (ui) {
    ui.setPromptLabel(getTTYPromptLabel(ui, state, session));
  }
  renderAgentModeChanged(ui, session.mode, state.commandApprovalMode);
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

function formatAgentTurnFailureMessage(error: unknown): string {
  if (error instanceof AgentToolLoopLimitError) {
    return "Stopped this turn after the model exhausted the tool-call limit without producing an answer. The failed tool loop was not added to session history. Ask for a narrower target or a specific file if you want to continue.";
  }

  return error instanceof Error ? error.message : "Unknown error";
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
  session.activePlan = storedSession.activePlan ? { ...storedSession.activePlan } : null;
  session.maxHistoryTurns = storedSession.maxHistoryTurns;
  session.contextBudget = { ...storedSession.contextBudget };
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
      activePlan: session.activePlan,
      maxHistoryTurns: session.maxHistoryTurns,
      contextBudget: session.contextBudget,
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
    activePlan: session.activePlan,
    maxHistoryTurns: session.maxHistoryTurns,
    contextBudget: session.contextBudget,
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

async function runProviderPicker(
  currentProvider: ProviderId,
  ui: InteractiveRenderer,
): Promise<ProviderId | null> {
  const selectedProvider = await ui.selectOption({
    title: "Provider",
    subtitle: "Choose which provider profile to use for future model requests.",
    helpText: "Up/Down move  Enter apply  Esc cancel",
    options: buildProviderPickerChoices(currentProvider).map((choice) => ({
      value: choice.value,
      label: choice.name,
      description: choice.description,
      tone: choice.value === currentProvider ? "accent" : "default",
    })),
  });

  return selectedProvider ? parseProviderId(selectedProvider) : null;
}

async function runKimiBaseURLPicker(
  currentBaseURL: string,
  ui: InteractiveRenderer,
): Promise<string | null> {
  return ui.selectOption({
    title: "Kimi Endpoint",
    subtitle: "Choose which Moonshot API host this Kimi profile should use.",
    helpText: "Up/Down move  Enter apply  Esc cancel",
    options: buildKimiBaseURLPickerChoices(currentBaseURL).map((choice) => ({
      value: choice.value,
      label: choice.name,
      description: choice.description,
      tone: choice.value === currentBaseURL ? "accent" : "default",
    })),
  });
}

async function runProviderModelPicker(
  currentModel: string,
  models: ProviderCatalogState["kimi"]["models"],
  ui: InteractiveRenderer,
): Promise<string | null> {
  if (models.length === 0) {
    return null;
  }

  return ui.selectOption({
    title: "Kimi Model",
    subtitle: "Choose which Kimi model to use for future requests.",
    helpText: "Up/Down move  Enter apply  Esc cancel",
    options: buildProviderModelPickerChoices(currentModel, models).map((choice) => ({
      value: choice.value,
      label: choice.name,
      description: choice.description,
      tone: choice.value === currentModel ? "accent" : "default",
    })),
  });
}

async function handleProviderModelShortcut(
  session: AgentSession,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
  modelValue: string,
): Promise<void> {
  const currentProviderId = state.settings.providerSettings.activeProvider;

  if (!modelValue && ui && currentProviderId === "kimi") {
    const selectedModel = await runProviderModelPicker(
      state.settings.providerSettings.kimi.model,
      state.providerCatalog.kimi.models,
      ui,
    );
    renderInteractiveShell(ui, session, state);
    if (!selectedModel) {
      if (state.providerCatalog.kimi.status !== "ready") {
        renderWarning(
          ui,
          "Kimi model catalog is not loaded yet. Use /provider refresh-models or /model <name>.",
        );
      }
      return;
    }

    state.settings = await saveProviderModel(currentProviderId, selectedModel);
    renderProviderApplied(ui, getActiveProviderConfig(state));
    return;
  }

  if (!modelValue) {
    renderError(ui, 'Usage: /model <name> or /provider model <name>');
    return;
  }

  state.settings = await saveProviderModel(currentProviderId, modelValue);
  if (ui) {
    renderInteractiveShell(ui, session, state);
  }
  renderProviderApplied(ui, getActiveProviderConfig(state));
}

async function runProviderContextPicker(
  provider: ProviderRuntimeConfig,
  ui: InteractiveRenderer,
): Promise<number | null | undefined> {
  const selectedValue = await ui.selectOption({
    title: "Context Budget",
    subtitle: `Choose the default token budget for ${provider.label}.`,
    helpText: "Up/Down move  Enter apply  Esc cancel",
    options: buildProviderContextPickerChoices({
      ...(provider.contextLimitTokens !== undefined
        ? { configuredContextLimitTokens: provider.contextLimitTokens }
        : {}),
      modelContextTokens: provider.modelContextTokens,
    }).map((choice) => ({
      value: choice.value,
      label: choice.name,
      description: choice.description,
      tone: choice.tone,
    })),
  });

  if (selectedValue === null) {
    return undefined;
  }

  if (selectedValue === "auto") {
    return null;
  }

  if (selectedValue === "custom") {
    const enteredValue = await ui.readPrompt({
      promptLabel: "context > ",
      workspaceFiles: [],
    });
    return parseProviderContextLimit(enteredValue);
  }

  return Number.parseInt(selectedValue, 10);
}

async function runModePicker(
  currentMode: AgentMode,
  currentApprovalMode: CommandApprovalMode,
  ui: InteractiveRenderer,
): Promise<InteractiveModeChoiceValue | null> {
  const activeMode = formatInteractiveModeLabel(currentMode, currentApprovalMode);
  const selectedMode = await ui.selectOption({
    title: "Tool Mode",
    subtitle: "Choose how the agent can inspect and execute local work.",
    helpText: "Up/Down move  Enter apply  Esc cancel",
    options: buildModePickerChoices(currentMode, currentApprovalMode).map((choice) => ({
      value: choice.value,
      label: choice.name,
      description: choice.description,
      tone: choice.value === null
        ? "default"
        : choice.value === CRAZY_AUTO_MODE_VALUE
          ? "danger"
          : choice.value === activeMode
            ? "accent"
            : "default",
    })),
  });

  return selectedMode ? parseInteractiveModeChoice(selectedMode) : null;
}

async function runApprovalPicker(
  currentMode: CommandApprovalMode,
  ui: InteractiveRenderer,
): Promise<SlashApprovalMode | null> {
  const selectedMode = await ui.selectOption({
    title: "Approvals",
    subtitle:
      'Choose how file edits and shell execution are approved in this process. Use "/mode crazy-auto" for full auto-approval.',
    helpText: "Up/Down move  Enter apply  Esc cancel",
    options: buildApprovalPickerOptions(currentMode),
  });

  return selectedMode ? parseSlashApprovalMode(selectedMode) : null;
}

async function maybePickKimiBaseURL(
  providerId: ProviderId,
  session: AgentSession,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
): Promise<void> {
  if (!ui || providerId !== "kimi") {
    return;
  }

  // When the user switches to Kimi from the provider picker, offer the endpoint
  // choice immediately so they do not need to remember a follow-up slash command.
  const selectedBaseURL = await runKimiBaseURLPicker(
    state.settings.providerSettings.kimi.baseURL,
    ui,
  );
  renderInteractiveShell(ui, session, state);
  if (!selectedBaseURL) {
    return;
  }

  state.settings = await saveProviderBaseURL(providerId, selectedBaseURL);
  await promptForProviderApiKeyInline(providerId, state, ui);
}

async function maybeRefreshProviderCatalog(
  providerId: ProviderId,
  state: InteractiveState,
): Promise<ProviderCatalogRefreshFeedback | null> {
  if (providerId !== "kimi") {
    state.providerCatalog[providerId] = {
      status: "idle",
      models: [],
      errorMessage: null,
      fetchedAt: null,
    };
    return null;
  }

  const provider = getActiveProviderConfig(state);
  if (provider.apiKeySource === "missing") {
    state.providerCatalog.kimi = {
      status: "error",
      models: [],
      errorMessage: `No API key is configured for ${provider.label}.`,
      fetchedAt: new Date().toISOString(),
    };
    return summarizeProviderCatalogRefresh(provider, state.providerCatalog.kimi);
  }

  const catalog = await refreshProviderCatalog(provider);
  state.providerCatalog.kimi = catalog;
  return summarizeProviderCatalogRefresh(provider, catalog);
}

function renderProviderCatalogRefreshFeedback(
  ui: InteractiveRenderer | null,
  feedback: ProviderCatalogRefreshFeedback | null,
): void {
  if (!feedback) {
    return;
  }

  if (feedback.level === "warning") {
    renderWarning(ui, feedback.message);
    return;
  }

  renderInfo(ui, feedback.message);
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
    plan: {
      updatePlan: async (request) => {
        if (!session.activePlan) {
          throw new Error("No active task plan.");
        }

        const currentStep = session.activePlan.steps.find((step) => step.id === request.stepId);
        if (!currentStep) {
          throw new Error(`Task plan step does not exist: ${request.stepId}`);
        }

        const nextPlan = updateTaskPlanStep(session.activePlan, request.stepId, {
          ...(request.status ? { status: request.status } : {}),
          ...(request.note !== undefined ? { note: request.note } : {}),
        });
        const nextStep = nextPlan.steps.find((step) => step.id === request.stepId) ?? currentStep;
        session.activePlan = nextPlan;
        recordSessionEvent(state, {
          timestamp: createSessionEventTimestamp(),
          kind: "plan_step_updated",
          planId: nextPlan.id,
          stepId: nextStep.id,
          stepTitle: nextStep.title,
          from: currentStep.status,
          to: nextStep.status,
        });
        const progress = getTaskPlanProgress(nextPlan);
        if (progress.completedSteps === progress.totalSteps) {
          recordSessionEvent(state, {
            timestamp: createSessionEventTimestamp(),
            kind: "plan_completed",
            planId: nextPlan.id,
            title: nextPlan.title,
          });
        }
        await persistCurrentSession(session, state, { allowEmpty: true });
        if (ui) {
          ui.setShellFrame(buildInteractiveShellFrame(session, state));
        }
        return {
          planId: nextPlan.id,
          stepId: nextStep.id,
          status: nextStep.status,
        };
      },
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
    ...(ui
      ? {
          userInput: {
            requestUserInput: async (request: UserInputRequest) =>
              promptPlanUserInput(request, session, state, ui),
          },
        }
      : {}),
  };
}

async function promptPlanUserInput(
  request: UserInputRequest,
  session: AgentSession,
  state: InteractiveState,
  ui: InteractiveRenderer,
): Promise<UserInputResponse> {
  const selectedValue = await ui.selectOption({
    title: request.title,
    subtitle: request.question,
    helpText: "Up/Down move  Enter select  Esc dismiss",
    options: [
      ...request.options.map((option, index) => ({
        value: option.value,
        label: option.label,
        description: option.description,
        tone: index === 0 ? "accent" as const : "default" as const,
      })),
      {
        value: "__custom__",
        label: "Custom input",
        description: "Type a custom answer instead of picking one of the listed options.",
        tone: "default" as const,
      },
    ],
  });
  ui.setShellFrame(buildInteractiveShellFrame(session, state));

  if (selectedValue === null) {
    return {
      kind: "dismissed",
      value: null,
      label: null,
      answer: "",
    };
  }

  if (selectedValue === "__custom__") {
    const customAnswer = (await ui.readPrompt({
      promptLabel: "plan answer > ",
      promptKind: "auxiliary",
      workspaceFiles: [],
    })).trim();
    ui.setShellFrame(buildInteractiveShellFrame(session, state));
    ui.setPromptLabel(getTTYPromptLabel(ui, state, session));

    if (!customAnswer) {
      return {
        kind: "dismissed",
        value: null,
        label: null,
        answer: "",
      };
    }

    return {
      kind: "custom",
      value: "custom",
      label: "Custom input",
      answer: customAnswer,
    };
  }

  const selectedOption = request.options.find((option) => option.value === selectedValue);
  if (!selectedOption) {
    return {
      kind: "dismissed",
      value: null,
      label: null,
      answer: "",
    };
  }

  return {
    kind: "option",
    value: selectedOption.value,
    label: selectedOption.label,
    answer: selectedOption.label,
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

function getActiveProviderConfig(
  state: Pick<
    InteractiveState,
    "settings" | "providerApiKeyOverrides" | "providerApiKeySources" | "providerCatalog"
  >,
): ProviderRuntimeConfig {
  const provider = attachProviderCatalogMetadata(
    resolveProviderRuntimeConfig(
      state.settings.providerSettings,
      state.providerApiKeyOverrides,
    ),
    state.providerCatalog,
  );
  const apiKeySourceOverride = state.providerApiKeySources[provider.id];
  if (apiKeySourceOverride && provider.apiKeySource === "runtime") {
    return {
      ...provider,
      apiKeySource: apiKeySourceOverride,
    };
  }

  return provider;
}

function formatProviderApiKeyStatus(
  provider: ProviderRuntimeConfig,
): string {
  if (provider.apiKeySource === "missing") {
    return "missing";
  }

  return `${provider.apiKeySource}:${provider.apiKeyPlaceholder}`;
}

function formatProviderStatus(
  provider: ProviderRuntimeConfig,
): string {
  return `${provider.id} ${formatProviderApiKeyStatus(provider)}`;
}

function parseProviderContextLimit(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Provider context limit must not be empty.");
  }

  if (normalized === "auto") {
    return null;
  }

  const kiloMatch = normalized.match(/^(\d+(?:\.\d+)?)k$/);
  if (kiloMatch) {
    const amount = Number(kiloMatch[1]);
    if (Number.isFinite(amount) && amount > 0) {
      return Math.round(amount * 1_000);
    }
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Invalid context limit. Use a positive integer or a value like "128k".');
  }

  return parsed;
}

function formatContextUsage(
  usedTokens: number | null,
  limitTokens: number | null,
): string {
  return `${formatTokenCount(usedTokens)}/${formatTokenCount(limitTokens)}`;
}

function buildContextMeter(
  stats: ReturnType<typeof getAgentSessionStats>,
  effectiveContextLimitTokens = stats.effectiveContextLimitTokens,
  modelLabel: string | null = null,
): RendererContextMeter | null {
  if (stats.currentContextTokens === null && effectiveContextLimitTokens === null) {
    return null;
  }

  return {
    usedTokens: stats.currentContextTokens,
    limitTokens: effectiveContextLimitTokens,
    source: stats.contextUsageSource,
    display: buildContextIndicatorDisplay(
      stats.currentContextTokens,
      effectiveContextLimitTokens,
    ),
    modelLabel,
  };
}

function getContextIndicatorLineColor(
  tone: ReturnType<typeof buildContextIndicatorDisplay>["tone"],
): string | undefined {
  switch (tone) {
    case "notice":
      return "yellow";
    case "warning":
      return "red";
    case "critical":
      return "redBright";
    case "muted":
    default:
      return "gray";
  }
}

function formatTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined) {
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

async function maybePromptForMissingProviderApiKey(
  providerId: ProviderId,
  state: InteractiveState,
  ui: InteractiveRenderer | null,
): Promise<void> {
  const provider = getActiveProviderConfig(state);
  if (provider.id !== providerId || provider.apiKeySource !== "missing") {
    return;
  }

  if (!ui) {
    renderWarning(
      ui,
      `No API key is configured for ${provider.label}. Set ${providerId === "kimi" ? "MOONSHOT_API_KEY" : "OPENAI_API_KEY"} or use /provider key in the TTY.`,
    );
    return;
  }

  await promptForProviderApiKey(providerId, state, ui);
}

async function promptForProviderApiKey(
  providerId: ProviderId,
  state: InteractiveState,
  ui: InteractiveRenderer,
): Promise<void> {
  const providerLabel = getProviderDisplayName(providerId);
  const secretValue = await runWithSuspendedRenderer(ui, () =>
    promptHiddenInput({
      input,
      output,
      prompt: `${providerLabel} API key (hidden; empty keeps current): `,
    }),
  );

  if (!secretValue) {
    renderInfo(
      ui,
      `Kept the current API key source for ${providerLabel}.`,
    );
    return;
  }

  state.providerApiKeyOverrides[providerId] = secretValue;
  try {
    await savePersistedProviderApiKey(providerId, secretValue);
    state.providerApiKeySources[providerId] = "stored";
    renderInfo(
      ui,
      `Stored a locally persisted API key for ${providerLabel} as ${getProviderApiKeyPlaceholder(providerId)}.`,
    );
  } catch (error) {
    state.providerApiKeySources[providerId] = "runtime";
    renderWarning(
      ui,
      error instanceof Error
        ? `Stored the API key for ${providerLabel} only for this process because local key storage failed: ${error.message}`
        : `Stored the API key for ${providerLabel} only for this process because local key storage failed.`,
    );
  }
}

async function loadPersistedProviderApiKeysSafely(): Promise<ProviderRuntimeSecretOverrides> {
  try {
    return await loadPersistedProviderApiKeys();
  } catch (error) {
    console.error(
      "warning:",
      error instanceof Error
        ? `Failed to load locally stored provider API keys: ${error.message}`
        : "Failed to load locally stored provider API keys.",
    );
    return {};
  }
}

async function promptForProviderApiKeyInline(
  providerId: ProviderId,
  state: InteractiveState,
  ui: InteractiveRenderer,
): Promise<void> {
  const providerLabel = getProviderDisplayName(providerId);
  const enteredValue = await ui.readPrompt({
    promptLabel: `${providerLabel} api key (visible; empty keeps current) > `,
    workspaceFiles: [],
  });

  const secretValue = enteredValue.trim();
  if (!secretValue) {
    renderInfo(ui, `Kept the current API key source for ${providerLabel}.`);
    return;
  }

  state.providerApiKeyOverrides[providerId] = secretValue;
  try {
    await savePersistedProviderApiKey(providerId, secretValue);
    state.providerApiKeySources[providerId] = "stored";
    renderInfo(
      ui,
      `Stored a locally persisted API key for ${providerLabel} as ${getProviderApiKeyPlaceholder(providerId)}.`,
    );
  } catch (error) {
    state.providerApiKeySources[providerId] = "runtime";
    renderWarning(
      ui,
      error instanceof Error
        ? `Stored the API key for ${providerLabel} only for this process because local key storage failed: ${error.message}`
        : `Stored the API key for ${providerLabel} only for this process because local key storage failed.`,
    );
  }
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
