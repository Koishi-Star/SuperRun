import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import {
  authorizeCommand,
  classifyCommand,
  runAfterCommandHook,
} from "./command_policy.js";
import { getPlatformShellCommand } from "./shell.js";
import type { CommandAssessment, ToolExecutionContext } from "./types.js";
import {
  normalizeRelativeWorkspacePath,
  resolveWorkspacePath,
} from "./workspace.js";

const COMMAND_NAME = "run_command";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 16_000;

const runCommandArgsSchema = z.object({
  command: z.string().trim().min(1).max(600),
  cwd: z.string().trim().min(1).optional(),
  timeout_ms: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
});

type RunCommandArgs = z.infer<typeof runCommandArgsSchema>;

type RunCommandResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

export const runCommandTool = {
  definition: {
    name: COMMAND_NAME,
    description:
      "Run a workspace command for inspection, search, build, test, or explicitly approved environment tasks. Elevated-risk shell mutation and download-exec flows stay gated unless the session approval mode is relaxed.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Shell command to run inside the workspace. Prefer read-only inspection, build, lint, and test commands.",
        },
        cwd: {
          type: "string",
          description:
            "Optional relative workspace directory to run the command from. Defaults to the workspace root.",
        },
        timeout_ms: {
          type: "integer",
          description:
            `Optional timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
          minimum: 1,
          maximum: MAX_TIMEOUT_MS,
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const parsedArgs = parseRunCommandArgs(rawArguments);
      const result = await runWorkspaceCommand(parsedArgs, context);

      return JSON.stringify({
        ok: !result.timedOut,
        ...result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown run_command error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};

export async function runWorkspaceCommand(
  args: RunCommandArgs,
  context?: ToolExecutionContext,
): Promise<RunCommandResult> {
  const workspaceRoot = process.cwd();
  const relativeCwd = normalizeRelativeWorkspacePath(COMMAND_NAME, args.cwd);
  const absoluteCwd = resolveWorkspacePath(
    COMMAND_NAME,
    workspaceRoot,
    relativeCwd,
  );
  const cwdStat = await lstat(absoluteCwd);

  if (!cwdStat.isDirectory()) {
    throw new Error("run_command cwd must point to a workspace directory.");
  }

  const command = args.command.trim();
  const assessment = classifyCommand(command, relativeCwd);
  await authorizeCommand(assessment, context?.commandPolicy);

  return executeShellCommand(
    command,
    absoluteCwd,
    relativeCwd,
    args.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    assessment,
    context,
  );
}

function parseRunCommandArgs(rawArguments: string): RunCommandArgs {
  const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  return runCommandArgsSchema.parse(parsed);
}

function executeShellCommand(
  command: string,
  absoluteCwd: string,
  relativeCwd: string,
  timeoutMs: number,
  assessment: CommandAssessment,
  context?: ToolExecutionContext,
): Promise<RunCommandResult> {
  const shell = getPlatformShellCommand(command);

  return new Promise((resolve, reject) => {
    const child = spawn(shell.file, shell.args, {
      cwd: absoluteCwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      ({ nextValue: stdout, truncated } = appendOutput(
        stdout,
        chunk,
        stdout.length + stderr.length,
        truncated,
      ));
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      ({ nextValue: stderr, truncated } = appendOutput(
        stderr,
        chunk,
        stdout.length + stderr.length,
        truncated,
      ));
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const result = {
        command,
        cwd: relativeCwd,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        truncated,
      };

      void runAfterCommandHook(context?.commandPolicy, {
        stage: "after",
        approvalMode: context?.commandPolicy?.getMode() ?? "allow-all",
        assessment,
        result: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
        },
      })
        .then(() => {
          resolve(result);
        })
        .catch(reject);
    });
  });
}

function appendOutput(
  currentValue: string,
  chunk: Buffer | string,
  currentTotalLength: number,
  alreadyTruncated: boolean,
): { nextValue: string; truncated: boolean } {
  if (alreadyTruncated || currentTotalLength >= MAX_OUTPUT_CHARS) {
    return {
      nextValue: currentValue,
      truncated: true,
    };
  }

  const text = chunk.toString();
  const remaining = MAX_OUTPUT_CHARS - currentTotalLength;

  if (text.length <= remaining) {
    return {
      nextValue: currentValue + text,
      truncated: false,
    };
  }

  return {
    nextValue: currentValue + text.slice(0, remaining),
    truncated: true,
  };
}
