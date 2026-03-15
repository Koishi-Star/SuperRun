import type { DeletedFileEntry } from "../tools/trash.js";

export const TRASH_ACTION_EXIT_LABEL = "Return to chat";
export const TRASH_ENTRY_BACK_LABEL = "Back to delete area";

export type TrashActionValue = "view" | "restore" | "purge" | "empty";

export type TrashActionChoice =
  | {
      value: TrashActionValue;
      name: string;
      description: string;
      tone: "default" | "accent" | "danger";
    }
  | {
      value: null;
      name: string;
      description: string;
      tone: "default";
    };

export type TrashEntryChoice = {
  value: string | null;
  name: string;
  description: string;
  tone: "default" | "accent" | "danger";
};

export function buildTrashActionChoices(
  fileCount: number,
): TrashActionChoice[] {
  const choices: TrashActionChoice[] = [
    {
      value: "view",
      name: "View deleted files",
      description:
        fileCount === 0
          ? "The delete area is currently empty."
          : `Browse ${fileCount} deleted file${fileCount === 1 ? "" : "s"} in the delete area.`,
      tone: "default",
    },
  ];

  if (fileCount > 0) {
    choices.push(
      {
        value: "restore",
        name: "Restore a file",
        description: "Put one deleted file back into the workspace.",
        tone: "accent",
      },
      {
        value: "purge",
        name: "Delete one permanently",
        description: "Remove one deleted file from the delete area for good.",
        tone: "danger",
      },
      {
        value: "empty",
        name: "Empty delete area",
        description: "Permanently remove every deleted file in the delete area.",
        tone: "danger",
      },
    );
  }

  choices.push({
    value: null,
    name: TRASH_ACTION_EXIT_LABEL,
    description: "Return to chat without changing the delete area.",
    tone: "default",
  });

  return choices;
}

export function buildTrashEntryChoices(
  entries: DeletedFileEntry[],
  action: "restore" | "purge",
): TrashEntryChoice[] {
  const tone: TrashEntryChoice["tone"] =
    action === "restore" ? "accent" : "danger";
  const actionVerb = action === "restore" ? "Restore" : "Delete permanently";

  return [
    ...entries.map((entry) => ({
      value: entry.id,
      name: `${actionVerb}: ${entry.originalPath}`,
      description:
        `${formatTimestamp(entry.deletedAt)} | ${formatKilobytes(entry.sizeBytes)} KB | ${entry.id}`,
      tone,
    })),
    {
      value: null,
      name: TRASH_ENTRY_BACK_LABEL,
      description: "Return to the delete area action list.",
      tone: "default",
    },
  ];
}

function formatKilobytes(sizeBytes: number): string {
  return Math.max(1, Math.round(sizeBytes / 1024)).toString();
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return parsed.toISOString().replace("T", " ").slice(0, 16);
}
