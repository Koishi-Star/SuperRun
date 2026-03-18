import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { getSymbolSource, isSupportedSourceFile } from "./symbol-resolve.js";
import { readWorkspaceTextFile } from "./text_file.js";
import type { ToolExecutionContext } from "./types.js";
import { normalizeRelativeWorkspacePath, resolveWorkspacePath } from "./workspace.js";

const getSymbolSourceArgsSchema = z.object({
  path: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  member: z.string().trim().min(1).optional(),
  full: z.boolean().optional(),
});

type GetSymbolSourceArgs = z.infer<typeof getSymbolSourceArgsSchema>;

export const getSymbolSourceTool = {
  definition: {
    name: "get_symbol_source",
    description:
      "Read the source code of a named symbol in a TypeScript or JavaScript file. For symbols larger than 200 lines, returns a truncated preview with a member list — use the `member` parameter to drill into a specific class method or nested function, or pass `full: true` to read the entire source. Returns the symbol's line range, a body hash for use with replace_symbol_body, and the file's import declarations. Use get_symbols first to discover available symbol names and see which ones are large.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative workspace path to the source file.",
        },
        symbol: {
          type: "string",
          description: "Exact name of the symbol to read (e.g. function name, class name).",
        },
        member: {
          type: "string",
          description:
            "Optional. Name of a class method, property, or nested function to read instead of the entire symbol. Use get_symbols to see available members.",
        },
        full: {
          type: "boolean",
          description:
            "Optional. Pass true to read the full source of a large symbol without truncation. Only use this when you genuinely need the entire symbol (e.g. for a major refactor).",
        },
      },
      required: ["path", "symbol"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const args = parseGetSymbolSourceArgs(rawArguments);
      const relativePath = normalizeRelativeWorkspacePath("get_symbol_source", args.path);
      const absolutePath = resolveWorkspacePath("get_symbol_source", process.cwd(), relativePath);

      if (!isSupportedSourceFile(absolutePath)) {
        return JSON.stringify({
          ok: false,
          error: `get_symbol_source only supports TypeScript and JavaScript files.`,
        });
      }

      const file = await readWorkspaceTextFile(absolutePath, "get_symbol_source");
      const result = getSymbolSource(absolutePath, file.content, args.symbol, {
        ...(args.member !== undefined ? { memberName: args.member } : {}),
        ...(args.full !== undefined ? { full: args.full } : {}),
      });

      if (!result) {
        const what = args.member
          ? `Member "${args.member}" in symbol "${args.symbol}"`
          : `Symbol "${args.symbol}"`;
        return JSON.stringify({
          ok: false,
          error: `${what} not found in ${relativePath}. Use get_symbols to list available symbols and their members.`,
        });
      }

      const readTarget = args.member
        ? `member "${args.member}" of ${result.kind} "${result.name}"`
        : `${result.kind} "${result.name}"`;
      context?.notices?.addNotice?.({
        level: "info",
        message: `get_symbol_source read ${readTarget} (lines ${result.startLine}-${result.endLine}) from ${relativePath}`,
      });

      return JSON.stringify({
        ok: true,
        path: relativePath,
        name: result.name,
        kind: result.kind,
        startLine: result.startLine,
        endLine: result.endLine,
        bodyHash: result.bodyHash,
        source: result.source,
        imports: result.imports,
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.members ? { members: result.members } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown get_symbol_source error.";
      return JSON.stringify({ ok: false, error: message });
    }
  },
};

function parseGetSymbolSourceArgs(rawArguments: string): GetSymbolSourceArgs {
  const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  return getSymbolSourceArgsSchema.parse(parsed);
}
