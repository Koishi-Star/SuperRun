import type { SessionSummary } from "../session/store.js";

export const SESSION_PICKER_EXIT_LABEL = "Return to chat";

export type SessionPickerChoice = {
  value: string | null;
  name: string;
  description: string;
};

export function buildSessionPickerChoices(
  sessions: SessionSummary[],
  currentSessionId: string | null,
): SessionPickerChoice[] {
  const choices: SessionPickerChoice[] = sessions.map((session, index) => {
    const currentSuffix = session.id === currentSessionId ? " (current)" : "";
    return {
      value: session.id,
      name: `${index + 1}. ${session.title}${currentSuffix}`,
      description: `${session.turnCount} turns | ${session.charCount} chars | ${formatTimestamp(session.updatedAt)} | ${session.preview}`,
    };
  });

  choices.push({
    value: null,
    name: SESSION_PICKER_EXIT_LABEL,
    description: "Return to chat without switching sessions.",
  });

  return choices;
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return parsed.toISOString().replace("T", " ").slice(0, 16);
}
