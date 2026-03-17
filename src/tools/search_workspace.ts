import path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { readWorkspaceTextFile } from "./text_file.js";
import type { ToolExecutionContext } from "./types.js";
import {
  normalizeRelativeWorkspacePath,
  resolveWorkspacePath,
} from "./workspace.js";

const MAX_PATTERN_LENGTH = 200;
const MAX_RESULTS = 100;
const DEFAULT_RESULTS = 40;
const MAX_SEARCHED_FILES = 400;
const MAX_FILE_BYTES = 512_000;
const MAX_LINE_PREVIEW_CHARS = 240;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
]);

const searchWorkspaceArgsSchema = z.object({
  pattern: z.string().trim().min(1).max(MAX_PATTERN_LENGTH),
  path: z.string().trim().min(1).optional(),
  regex: z.boolean().optional(),
  case_sensitive: z.boolean().optional(),
  max_results: z.number().int().min(1).max(MAX_RESULTS).optional(),
});

type SearchWorkspaceArgs = z.infer<typeof searchWorkspaceArgsSchema>;

type SearchWorkspaceMatch = {
  path: string;
  line: number;
  text: string;
};

export const searchWorkspaceTool = {
  definition: {
    name: "search_workspace",
    description:
      "Search UTF-8 workspace files for matching text or regex patterns. Prefer this over shell grep, findstr, or Select-String when you need repository text search.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Literal text or regex pattern to search for.",
        },
        path: {
          type: "string",
          description: "Optional relative workspace directory or file path to search within. Defaults to the workspace root.",
        },
        regex: {
          type: "boolean",
          description: "Treat pattern as a JavaScript regex. Defaults to false for literal search.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Whether the search should be case-sensitive. Defaults to false.",
        },
        max_results: {
          type: "integer",
          description: `Maximum number of matching lines to return. Defaults to ${DEFAULT_RESULTS}.`,
          minimum: 1,
          maximum: MAX_RESULTS,
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const parsedArgs = parseSearchWorkspaceArgs(rawArguments);
      const result = await searchWorkspace(parsedArgs);
      context?.notices?.addNotice({
        level: "info",
        message:
          `search_workspace found ${result.matches.length} match${result.matches.length === 1 ? "" : "es"} in ${result.searchedFiles} file${result.searchedFiles === 1 ? "" : "s"} under ${result.path}.`,
      });
      return JSON.stringify({
        ok: true,
        ...result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown search_workspace error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};

export async function searchWorkspace(args: SearchWorkspaceArgs): Promise<{
  path: string;
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  searchedFiles: number;
  matches: SearchWorkspaceMatch[];
  truncated: boolean;
}> {
  const workspaceRoot = process.cwd();
  const relativePath = normalizeRelativeWorkspacePath("search_workspace", args.path);
  const absolutePath = resolveWorkspacePath("search_workspace", workspaceRoot, relativePath);
  const rootStat = await lstat(absolutePath);
  const matcher = createSearchMatcher(args.pattern, {
    regex: args.regex ?? false,
    caseSensitive: args.case_sensitive ?? false,
  });
  const maxResults = args.max_results ?? DEFAULT_RESULTS;
  const matches: SearchWorkspaceMatch[] = [];
  let searchedFiles = 0;
  let truncated = false;

  const searchFile = async (
    fileRelativePath: string,
    fileAbsolutePath: string,
  ): Promise<void> => {
    if (matches.length >= maxResults || searchedFiles >= MAX_SEARCHED_FILES) {
      truncated = true;
      return;
    }

    const stat = await lstat(fileAbsolutePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return;
    }

    try {
      const file = await readWorkspaceTextFile(fileAbsolutePath, "search_workspace");
      searchedFiles += 1;

      for (let index = 0; index < file.lines.length; index += 1) {
        if (matcher(file.lines[index] ?? "")) {
          matches.push({
            path: fileRelativePath,
            line: index + 1,
            text: summarizeMatchedLine(file.lines[index] ?? ""),
          });
          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }
        }
      }
    } catch {
      // Skip binary, unreadable, or otherwise unsupported files during search.
    }
  };

  if (rootStat.isFile()) {
    await searchFile(relativePath, absolutePath);
  } else {
    await walkSearchDirectory(
      relativePath,
      absolutePath,
      async (fileRelativePath, fileAbsolutePath) => {
        await searchFile(fileRelativePath, fileAbsolutePath);
        return matches.length < maxResults && searchedFiles < MAX_SEARCHED_FILES;
      },
    );
    if (searchedFiles >= MAX_SEARCHED_FILES) {
      truncated = true;
    }
  }

  return {
    path: relativePath,
    pattern: args.pattern,
    regex: args.regex ?? false,
    caseSensitive: args.case_sensitive ?? false,
    searchedFiles,
    matches,
    truncated,
  };
}

async function walkSearchDirectory(
  relativePath: string,
  absolutePath: string,
  visitFile: (fileRelativePath: string, fileAbsolutePath: string) => Promise<boolean>,
): Promise<boolean> {
  const entries = await readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const childRelativePath =
      relativePath === "."
        ? entry.name
        : path.posix.join(relativePath.replace(/\\/g, "/"), entry.name);
    const childAbsolutePath = path.join(absolutePath, entry.name);

    if (entry.isDirectory()) {
      const shouldContinue = await walkSearchDirectory(
        childRelativePath,
        childAbsolutePath,
        visitFile,
      );
      if (!shouldContinue) {
        return false;
      }
      continue;
    }

    if (!(await visitFile(childRelativePath, childAbsolutePath))) {
      return false;
    }
  }

  return true;
}

function createSearchMatcher(
  pattern: string,
  options: { regex: boolean; caseSensitive: boolean },
): (line: string) => boolean {
  const source = options.regex ? pattern : escapeRegExp(pattern);
  const flags = options.caseSensitive ? "u" : "iu";
  const expression = new RegExp(source, flags);
  return (line: string) => expression.test(line);
}

function summarizeMatchedLine(line: string): string {
  const normalized = line.replace(/\t/g, "  ").trim();
  if (normalized.length <= MAX_LINE_PREVIEW_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_LINE_PREVIEW_CHARS - 3)}...`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSearchWorkspaceArgs(rawArguments: string): SearchWorkspaceArgs {
  const parsed = rawArguments.trim()
    ? JSON.parse(rawArguments)
    : {};
  return searchWorkspaceArgsSchema.parse(parsed);
}
