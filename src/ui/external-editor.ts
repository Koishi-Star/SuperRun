import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ExternalSystemPromptEditResult =
  | {
      status: "unchanged";
    }
  | {
      status: "updated";
      value: string;
    };

export async function editSystemPromptExternally(
  currentPrompt: string,
): Promise<ExternalSystemPromptEditResult> {
  const editedPrompt = await editTextInExternalEditor(currentPrompt, {
    fileName: "system-prompt.md",
  });

  return finalizeExternalSystemPromptEdit(currentPrompt, editedPrompt);
}

export function finalizeExternalSystemPromptEdit(
  currentPrompt: string,
  editedPrompt: string,
): ExternalSystemPromptEditResult {
  // Ignore newline-only churn from editors so closing without substantive edits is treated as cancel.
  const normalizedCurrentPrompt = normalizeExternalEditorText(currentPrompt);
  const normalizedEditedPrompt = normalizeExternalEditorText(editedPrompt);

  if (normalizedEditedPrompt === normalizedCurrentPrompt) {
    return {
      status: "unchanged",
    };
  }

  if (!normalizedEditedPrompt) {
    throw new Error("System prompt must not be empty.");
  }

  return {
    status: "updated",
    value: normalizedEditedPrompt,
  };
}

async function editTextInExternalEditor(
  initialText: string,
  options: {
    fileName: string;
  },
): Promise<string> {
  const tempDirectoryPath = await mkdtemp(
    path.join(os.tmpdir(), "superrun-editor-"),
  );
  const filePath = path.join(tempDirectoryPath, options.fileName);

  try {
    await writeFile(filePath, initialText, "utf8");
    await launchExternalEditor(filePath);
    return await readFile(filePath, "utf8");
  } finally {
    await rm(tempDirectoryPath, { recursive: true, force: true });
  }
}

async function launchExternalEditor(filePath: string): Promise<void> {
  const command = getPreferredEditorCommand();

  await new Promise<void>((resolve, reject) => {
    const editorProcess = spawn(command, [filePath], {
      shell: true,
      stdio: "inherit",
    });

    editorProcess.on("error", (error) => {
      reject(new Error(`Failed to launch external editor: ${error.message}`));
    });

    editorProcess.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`External editor exited with code ${code ?? "unknown"}.`));
        return;
      }

      resolve();
    });
  });
}

function getPreferredEditorCommand(): string {
  const visual = process.env.VISUAL?.trim();
  if (visual) {
    return visual;
  }

  const editor = process.env.EDITOR?.trim();
  if (editor) {
    return editor;
  }

  return process.platform.startsWith("win") ? "notepad" : "vim";
}

function normalizeExternalEditorText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}
