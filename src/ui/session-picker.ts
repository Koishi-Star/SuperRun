import type { SessionSummary } from "../session/store.js";

export const SESSION_PICKER_EXIT_LABEL = "Return to chat";
export const SESSION_PICKER_NEW_VALUE = "__new_session__";
export const SESSION_PICKER_NEW_LABEL = "New session";
export const SESSION_ACTION_BACK_LABEL = "Back to sessions";

export type SessionPickerChoice = {
  value: string | null;
  name: string;
  description: string;
};

export type SessionPickerActionChoice = {
  value: "switch" | "history" | "rename" | "delete" | null;
  name: string;
  description: string;
  tone: "default" | "accent" | "danger";
};

export function buildSessionPickerChoices(
  sessions: SessionSummary[],
  currentSessionId: string | null,
  options?: {
    includeNewSessionAction?: boolean;
  },
): SessionPickerChoice[] {
  const choices: SessionPickerChoice[] = [];

  if (options?.includeNewSessionAction) {
    choices.push({
      value: SESSION_PICKER_NEW_VALUE,
      name: SESSION_PICKER_NEW_LABEL,
      description: "Create and switch to a fresh saved session.",
    });
  }

  choices.push(...sessions.map((session, index) => {
    const currentSuffix = session.id === currentSessionId ? " (current)" : "";
    return {
      value: session.id,
      name: `${index + 1}. ${session.title}${currentSuffix}`,
      description: `${session.turnCount} turns | ${session.charCount} chars | ${formatTimestamp(session.updatedAt)} | ${session.preview}`,
    };
  }));

  choices.push({
    value: null,
    name: SESSION_PICKER_EXIT_LABEL,
    description: "Return to chat without switching sessions.",
  });

  return choices;
}

export function buildSessionActionChoices(
  session: SessionSummary,
  currentSessionId: string | null,
): SessionPickerActionChoice[] {
  const isCurrentSession = session.id === currentSessionId;
  const choices: SessionPickerActionChoice[] = [];

  if (!isCurrentSession) {
    choices.push({
      value: "switch",
      name: "Switch to session",
      description: "Load this saved session into the active chat.",
      tone: "accent",
    });
  }

  choices.push(
    {
      value: "history",
      name: "View history",
      description: "Open the saved transcript and event log in a viewer.",
      tone: "default",
    },
    {
      value: "rename",
      name: "Rename session",
      description: "Set a clearer title for this saved session.",
      tone: "default",
    },
    {
      value: "delete",
      name: "Delete session",
      description: "Remove this saved session from local storage.",
      tone: "danger",
    },
    {
      value: null,
      name: SESSION_ACTION_BACK_LABEL,
      description: "Return to the saved-session list.",
      tone: "default",
    },
  );

  return choices;
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return parsed.toISOString().replace("T", " ").slice(0, 16);
}
