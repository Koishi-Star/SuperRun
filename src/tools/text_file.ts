import { readFile, writeFile } from "node:fs/promises";

export type WorkspaceTextFile = {
  content: string;
  lines: string[];
  lineEnding: "\n" | "\r\n";
  trailingNewline: boolean;
};

export async function readWorkspaceTextFile(
  absolutePath: string,
  toolName: string,
): Promise<WorkspaceTextFile> {
  const rawContent = await readFile(absolutePath, "utf8");
  if (rawContent.includes("\u0000")) {
    throw new Error(`${toolName} only supports UTF-8 text files.`);
  }

  return parseWorkspaceText(rawContent);
}

export async function writeWorkspaceTextFile(
  absolutePath: string,
  file: WorkspaceTextFile,
): Promise<void> {
  const nextContent = serializeWorkspaceText(file);
  await writeFile(absolutePath, nextContent, "utf8");
}

export function parseWorkspaceText(content: string): WorkspaceTextFile {
  const lineEnding: "\n" | "\r\n" = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const logicalContent = trailingNewline
    ? normalized.slice(0, -1)
    : normalized;
  const lines = logicalContent.length === 0
    ? []
    : logicalContent.split("\n");

  return {
    content: normalized,
    lines,
    lineEnding,
    trailingNewline,
  };
}

export function serializeWorkspaceText(file: WorkspaceTextFile): string {
  const joined = file.lines.join(file.lineEnding);
  if (!file.trailingNewline || joined.length === 0) {
    return joined;
  }

  return `${joined}${file.lineEnding}`;
}

export function normalizeReplacementLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const trimmedTrailingNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;

  if (trimmedTrailingNewline.length === 0) {
    return [];
  }

  return trimmedTrailingNewline.split("\n");
}
