import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { getSymbolSource, isSupportedSourceFile } from "./symbol-resolve.js";
import { readWorkspaceTextFile } from "./text_file.js";
import type { ToolExecutionContext } from "./types.js";
import { normalizeRelativeWorkspacePath, resolveWorkspacePath } from "./workspace.js";

const getSymbolSourceArgsSchema = z.object({
  path: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
});

type GetSymbolSourceArgs = z.infer<typeof getSymbolSourceArgsSchema>;

export const getSymbolSourceTool = {
  definition: {
    name: "get_symbol_source",
    description:
      "Read the full source code of a specific named symbol (function, class, interface, type, variable) in a TypeScript or JavaScript file. Also returns the symbol's line range, a body hash for use with replace_symbol_body, and the file's import declarations for context. Use get_symbols first to discover available symbol names.",
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
      const result = getSymbolSource(absolutePath, file.content, args.symbol);

      if (!result) {
        return JSON.stringify({
          ok: false,
          error: `Symbol "${args.symbol}" not found in ${relativePath}. Use get_symbols to list available symbols.`,
        });
      }

      context?.notices?.addNotice?.({
        level: "info",
        message: `get_symbol_source read ${result.kind} "${result.name}" (lines ${result.startLine}-${result.endLine}) from ${relativePath}`,
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
