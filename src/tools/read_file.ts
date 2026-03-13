import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import type { ToolExecutionContext } from "./types.js";
import {
  normalizeRelativeWorkspacePath,
  resolveWorkspacePath,
} from "./workspace.js";

const MAX_RANGE_LINES = 200;
const MAX_OUTPUT_CHARS = 40_000;

const readFileArgsSchema = z.object({
  path: z.string().trim().min(1),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
});

type ReadFileArgs = z.infer<typeof readFileArgsSchema>;

export const readFileTool = {
  definition: {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the workspace with 1-based line bounds. Use this before editing so you can inspect the exact lines you plan to change.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative workspace path to the file to read.",
        },
        start_line: {
          type: "integer",
          description: "Optional 1-based starting line. Defaults to 1.",
          minimum: 1,
        },
        end_line: {
          type: "integer",
          description: `Optional 1-based ending line. Reads up to ${MAX_RANGE_LINES} lines at a time.`,
          minimum: 1,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    _context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const parsedArgs = parseReadFileArgs(rawArguments);
      const result = await readWorkspaceFile(parsedArgs);
      return JSON.stringify({
        ok: true,
        ...result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown read_file error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};

export async function readWorkspaceFile(args: ReadFileArgs): Promise<{
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  content: string;
}> {
  const relativePath = normalizeRelativeWorkspacePath("read_file", args.path);
  const absolutePath = resolveWorkspacePath("read_file", process.cwd(), relativePath);
  const fileContent = await readFile(absolutePath, "utf8");

  if (fileContent.includes("\u0000")) {
    throw new Error("read_file only supports UTF-8 text files.");
  }

  const normalizedContent = fileContent.replace(/\r\n/g, "\n");
  const lines = normalizedContent.split("\n");
  const totalLines = lines.length;
  const startLine = args.start_line ?? 1;

  if (startLine > totalLines) {
    throw new Error(`read_file start_line is out of range for ${relativePath}.`);
  }

  const requestedEndLine = args.end_line ?? Math.min(totalLines, startLine + MAX_RANGE_LINES - 1);
  if (requestedEndLine < startLine) {
    throw new Error("read_file end_line must be greater than or equal to start_line.");
  }

  const cappedEndLine = Math.min(requestedEndLine, startLine + MAX_RANGE_LINES - 1, totalLines);
  let content = lines.slice(startLine - 1, cappedEndLine).join("\n");
  let truncated = cappedEndLine < requestedEndLine || cappedEndLine < totalLines;

  if (content.length > MAX_OUTPUT_CHARS) {
    content = content.slice(0, MAX_OUTPUT_CHARS);
    truncated = true;
  }

  return {
    path: relativePath,
    startLine,
    endLine: cappedEndLine,
    totalLines,
    truncated,
    content,
  };
}

function parseReadFileArgs(rawArguments: string): ReadFileArgs {
  const parsed = rawArguments.trim()
    ? JSON.parse(rawArguments)
    : {};
  return readFileArgsSchema.parse(parsed);
}
