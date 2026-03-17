import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { listFileSymbols, isSupportedSourceFile } from "./symbol-resolve.js";
import { readWorkspaceTextFile } from "./text_file.js";
import type { ToolExecutionContext } from "./types.js";
import { normalizeRelativeWorkspacePath, resolveWorkspacePath } from "./workspace.js";

const getSymbolsArgsSchema = z.object({
  path: z.string().trim().min(1),
});

type GetSymbolsArgs = z.infer<typeof getSymbolsArgsSchema>;

export const getSymbolsTool = {
  definition: {
    name: "get_symbols",
    description:
      "List the top-level named symbols (functions, classes, interfaces, types, enums, variables) in a TypeScript or JavaScript file. Use this to understand file structure before editing, instead of reading the entire file. Returns symbol names, kinds, and line ranges — not source code.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative workspace path to the source file.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const args = parseGetSymbolsArgs(rawArguments);
      const relativePath = normalizeRelativeWorkspacePath("get_symbols", args.path);
      const absolutePath = resolveWorkspacePath("get_symbols", process.cwd(), relativePath);

      if (!isSupportedSourceFile(absolutePath)) {
        return JSON.stringify({
          ok: false,
          error: `get_symbols only supports TypeScript and JavaScript files. Use read_file for other file types.`,
        });
      }

      const file = await readWorkspaceTextFile(absolutePath, "get_symbols");
      const symbols = listFileSymbols(absolutePath, file.content);

      context?.notices?.addNotice?.({
        level: "info",
        message: `get_symbols found ${symbols.length} symbol${symbols.length === 1 ? "" : "s"} in ${relativePath}`,
      });

      return JSON.stringify({
        ok: true,
        path: relativePath,
        totalLines: file.lines.length,
        symbols: symbols.map(({ name, kind, startLine, endLine }) => ({
          name,
          kind,
          startLine,
          endLine,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown get_symbols error.";
      return JSON.stringify({ ok: false, error: message });
    }
  },
};

function parseGetSymbolsArgs(rawArguments: string): GetSymbolsArgs {
  const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  return getSymbolsArgsSchema.parse(parsed);
}
