import type { SessionSummary } from "../session/store.js";
import type { InteractiveRenderer } from "./interactive-renderer.js";
import {
  buildSessionActionChoices,
  buildSessionPickerChoices,
  SESSION_PICKER_NEW_VALUE,
} from "./session-picker.js";

const SESSION_BROWSER_EXIT_INPUTS = new Set(["/exit", "exit", "exit()"]);

export type SessionBrowserResult =
  | { kind: "cancel" }
  | { kind: "exit" }
  | { kind: "switch"; sessionId: string }
  | { kind: "history"; sessionId: string }
  | { kind: "rename"; sessionId: string; title: string }
  | { kind: "delete"; sessionId: string }
  | { kind: "new"; title: string | null };

export async function runSessionBrowser(
  ui: InteractiveRenderer,
  options: {
    sessions: SessionSummary[];
    currentSessionId: string | null;
    filterQuery?: string;
  },
): Promise<SessionBrowserResult> {
  while (true) {
    const selectedValue = await ui.selectOption({
      title: "Saved Sessions",
      subtitle: buildSessionPickerSubtitle(options.sessions.length, options.filterQuery),
      helpText: "Up/Down move  Enter select  Esc cancel",
      options: buildSessionPickerChoices(
        options.sessions,
        options.currentSessionId,
        { includeNewSessionAction: true },
      ).map((choice) => ({
        value: choice.value,
        label: choice.name,
        description: choice.description,
        tone:
          choice.value === SESSION_PICKER_NEW_VALUE
            ? "accent"
            : choice.value === options.currentSessionId
              ? "accent"
              : "default",
      })),
    });

    if (selectedValue === null) {
      return { kind: "cancel" };
    }

    if (selectedValue === SESSION_PICKER_NEW_VALUE) {
      const createResult = await promptForNewSession(ui);
      if (createResult.kind !== "cancel") {
        return createResult;
      }
      continue;
    }

    const selectedSession = options.sessions.find((session) => session.id === selectedValue);
    if (!selectedSession) {
      ui.renderError(`Session is no longer available: ${selectedValue}`);
      continue;
    }

    const actionResult = await runSessionActionMenu(
      ui,
      selectedSession,
      options.currentSessionId,
    );
    if (actionResult.kind === "cancel") {
      continue;
    }

    return actionResult;
  }
}

async function runSessionActionMenu(
  ui: InteractiveRenderer,
  session: SessionSummary,
  currentSessionId: string | null,
): Promise<SessionBrowserResult> {
  while (true) {
    const selectedAction = await ui.selectOption({
      title: session.title,
      subtitle: `${session.turnCount} turns | ${session.charCount} chars | ${formatTimestamp(session.updatedAt)}`,
      helpText: "Up/Down move  Enter select  Esc back",
      options: buildSessionActionChoices(session, currentSessionId).map((choice) => ({
        value: choice.value,
        label: choice.name,
        description: choice.description,
        tone: choice.tone,
      })),
    });

    if (selectedAction === null) {
      return { kind: "cancel" };
    }

    if (selectedAction === "switch") {
      return { kind: "switch", sessionId: session.id };
    }

    if (selectedAction === "history") {
      return { kind: "history", sessionId: session.id };
    }

    if (selectedAction === "rename") {
      const renamedTitle = await promptForSessionTitle(ui, session.title);
      if (renamedTitle.kind === "cancel") {
        continue;
      }
      if (renamedTitle.kind === "exit") {
        return renamedTitle;
      }

      return {
        kind: "rename",
        sessionId: session.id,
        title: renamedTitle.title,
      };
    }

    if (selectedAction === "delete") {
      const deleteResult = await promptForDeleteConfirmation(ui, session.title);
      if (deleteResult.kind === "cancel") {
        continue;
      }
      if (deleteResult.kind === "exit") {
        return deleteResult;
      }

      return {
        kind: "delete",
        sessionId: session.id,
      };
    }
  }
}

async function promptForNewSession(
  ui: InteractiveRenderer,
): Promise<SessionBrowserResult> {
  while (true) {
    const input = await ui.readPrompt({
      promptLabel: "new (/cancel) > ",
      workspaceFiles: [],
    });
    const trimmedInput = input.trim();

    if (isExitInput(trimmedInput)) {
      return { kind: "exit" };
    }

    if (trimmedInput === "/cancel") {
      return { kind: "cancel" };
    }

    return {
      kind: "new",
      title: trimmedInput || null,
    };
  }
}

async function promptForSessionTitle(
  ui: InteractiveRenderer,
  currentTitle: string,
): Promise<
  | { kind: "cancel" }
  | { kind: "exit" }
  | { kind: "submit"; title: string }
> {
  while (true) {
    const input = await ui.readPrompt({
      promptLabel: "rename (/cancel) > ",
      workspaceFiles: [],
    });
    const trimmedInput = input.trim();

    if (isExitInput(trimmedInput)) {
      return { kind: "exit" };
    }

    if (trimmedInput === "/cancel") {
      return { kind: "cancel" };
    }

    if (!trimmedInput) {
      ui.renderError(`Session title must not be empty. Keep "${currentTitle}" or type /cancel.`);
      continue;
    }

    if (trimmedInput === currentTitle) {
      ui.renderInfo("Session title is unchanged.");
      continue;
    }

    return {
      kind: "submit",
      title: trimmedInput,
    };
  }
}

async function promptForDeleteConfirmation(
  ui: InteractiveRenderer,
  sessionTitle: string,
): Promise<
  | { kind: "cancel" }
  | { kind: "exit" }
  | { kind: "confirm" }
> {
  while (true) {
    const input = await ui.readPrompt({
      promptLabel: "delete YES (/cancel) > ",
      workspaceFiles: [],
    });
    const trimmedInput = input.trim();

    if (isExitInput(trimmedInput)) {
      return { kind: "exit" };
    }

    if (trimmedInput === "/cancel") {
      return { kind: "cancel" };
    }

    if (trimmedInput === "YES") {
      return { kind: "confirm" };
    }

    ui.renderError(`Type "YES" to delete "${sessionTitle}", or /cancel to go back.`);
  }
}

function buildSessionPickerSubtitle(
  sessionCount: number,
  filterQuery: string | undefined,
): string {
  const countLabel = `${sessionCount} saved session${sessionCount === 1 ? "" : "s"}`;
  if (!filterQuery) {
    return countLabel;
  }

  return `${countLabel} matching "${filterQuery}"`;
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return parsed.toISOString().replace("T", " ").slice(0, 16);
}

function isExitInput(value: string): boolean {
  return SESSION_BROWSER_EXIT_INPUTS.has(value);
}
