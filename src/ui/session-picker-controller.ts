import { select } from "@inquirer/prompts";
import type { SessionSummary } from "../session/store.js";
import { isPromptExitError } from "./inquirer-errors.js";
import { buildSessionPickerChoices } from "./session-picker.js";

export async function runSessionPickerInteraction(options: {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  filterQuery?: string | null | undefined;
}): Promise<SessionSummary | null> {
  const choices = buildSessionPickerChoices(
    options.sessions,
    options.currentSessionId,
  );
  const message = options.filterQuery?.trim()
    ? `Switch sessions (filter: "${options.filterQuery.trim()}")`
    : "Switch sessions";
  let selectedId: string | null;
  try {
    selectedId = await select<string | null>({
      message,
      choices: choices.map((choice) => ({
        value: choice.value,
        name: choice.name,
        description: choice.description,
      })),
      pageSize: Math.min(Math.max(choices.length, 3), 12),
    });
  } catch (error) {
    if (isPromptExitError(error)) {
      return null;
    }

    throw error;
  }

  return options.sessions.find((session) => session.id === selectedId) ?? null;
}
