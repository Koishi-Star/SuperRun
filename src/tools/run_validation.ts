import { z } from "zod";
import { execFile } from "node:child_process";
import type { ToolDefinition } from "../llm/types.js";
import type { ToolExecutionContext } from "./types.js";

const TYPECHECK_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 8_000;

const runValidationArgsSchema = z.object({
  scope: z.enum(["typecheck", "full"]).optional(),
});

type RunValidationArgs = z.infer<typeof runValidationArgsSchema>;

export const runValidationTool = {
  definition: {
    name: "run_validation",
    description:
      "Run project validation after code changes. With scope \"typecheck\" runs only the TypeScript compiler (tsc --noEmit). With scope \"full\" (the default) also runs the test suite (npm test). Call this after replace_symbol_body or other file edits to verify the project still compiles and passes tests.",
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["typecheck", "full"],
          description:
            "\"typecheck\" for type checking only, \"full\" (default) for type checking + tests.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    _context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const args = parseRunValidationArgs(rawArguments);
      const scope = args.scope ?? "full";

      // Phase 1: Type checking.
      const typecheckResult = await runShellCommand(
        "npx",
        ["tsc", "--noEmit"],
        TYPECHECK_TIMEOUT_MS,
      );
      const typecheckPassed = typecheckResult.exitCode === 0;
      const typecheckErrors = typecheckPassed
        ? []
        : parseTypecheckErrors(typecheckResult.output);

      if (scope === "typecheck") {
        return JSON.stringify({
          ok: typecheckPassed,
          typecheck: {
            passed: typecheckPassed,
            errors: typecheckErrors,
          },
        });
      }

      // Phase 2: Tests (only if typecheck passed).
      if (!typecheckPassed) {
        return JSON.stringify({
          ok: false,
          typecheck: {
            passed: false,
            errors: typecheckErrors,
          },
          test: {
            passed: false,
            summary: "Skipped — typecheck failed.",
          },
        });
      }

      const testResult = await runShellCommand(
        "npm",
        ["test"],
        TEST_TIMEOUT_MS,
      );
      const testPassed = testResult.exitCode === 0;
      const testSummary = truncateOutput(testResult.output, MAX_OUTPUT_CHARS);

      return JSON.stringify({
        ok: typecheckPassed && testPassed,
        typecheck: {
          passed: typecheckPassed,
          errors: typecheckErrors,
        },
        test: {
          passed: testPassed,
          summary: testSummary,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown run_validation error.";
      return JSON.stringify({ ok: false, error: message });
    }
  },
};

// ---------------------------------------------------------------------------
// Shell execution helper
// ---------------------------------------------------------------------------

function runShellCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: process.cwd(),
        timeout: timeoutMs,
        // Merge stdout+stderr for simpler output handling.
        maxBuffer: 2 * 1024 * 1024,
        shell: true,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const combined = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
        const exitCode = error
          ? (error as NodeJS.ErrnoException & { code?: string | number }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? 1
            : (child.exitCode ?? 1)
          : 0;
        resolve({ exitCode, output: combined });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function parseTypecheckErrors(output: string): string[] {
  // tsc outputs errors like: src/foo.ts(10,5): error TS2304: Cannot find name 'bar'.
  // Return up to 20 individual error lines.
  const lines = output.split("\n");
  const errors: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes(": error TS")) {
      errors.push(trimmed);
      if (errors.length >= 20) break;
    }
  }
  // If no structured errors found, return the raw output (truncated).
  if (errors.length === 0 && output.trim()) {
    return [truncateOutput(output, 2000)];
  }
  return errors;
}

function truncateOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  return `${output.slice(0, maxChars)}\n... (truncated)`;
}

function parseRunValidationArgs(rawArguments: string): RunValidationArgs {
  const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  return runValidationArgsSchema.parse(parsed);
}
