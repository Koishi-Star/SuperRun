import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
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

const BLOCKED_COMMAND_RULES: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  {
    pattern: /(?:^|[^\S\r\n])\d*>>?\s*/i,
    reason: "output redirection is not allowed.",
  },
  {
    pattern: /\|\s*tee\b/i,
    reason: "tee-style output capture can write files.",
  },
  {
    pattern:
      /\b(?:rm|del|erase|rmdir|rd|remove-item|move-item|rename-item|copy-item|set-content|add-content|out-file|new-item|clear-content|set-item|touch|mkdir|mktemp|cp|mv|install)\b/i,
    reason: "file-modifying commands are blocked in default mode.",
  },
  {
    pattern:
      /\bgit\s+(?:add|am|apply|bisect|checkout|cherry-pick|clean|clone|commit|fetch|merge|pull|push|rebase|reset|restore|revert|stash|switch|tag|worktree)\b/i,
    reason: "git state-changing commands are blocked in default mode.",
  },
  {
    pattern:
      /\b(?:npm|pnpm|yarn|bun)\s+(?:add|create|dlx|exec|install|link|publish|remove|run\s+prepare|set|uninstall|unlink|update|upgrade)\b/i,
    reason: "package-management commands that change the workspace are blocked.",
  },
  {
    pattern:
      /\b(?:bash|sh|zsh|fish|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?)\b\s+(?:-c|-Command|\/c)\b/i,
    reason: "nested shell execution is blocked.",
  },
  {
    pattern: /\bnode\s+-e\b/i,
    reason: "inline Node.js execution is blocked.",
  },
  {
    pattern: /\bpython(?:3(?:\.\d+)?)?\s+-c\b/i,
    reason: "inline Python execution is blocked.",
  },
  {
    pattern: /\bsed\b[^\r\n]*\s-i(?:\s|$)/i,
    reason: "in-place file editing is blocked.",
  },
  {
    pattern: /\bperl\b[^\r\n]*\s-pi(?:\s|$)/i,
    reason: "in-place file editing is blocked.",
  },
];

export const runCommandTool = {
  definition: {
    name: COMMAND_NAME,
    description:
      "Run a workspace command for inspection, search, build, or test tasks. Commands that obviously modify files, package state, or git state are blocked in default mode.",
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
  async execute(rawArguments: string): Promise<string> {
    try {
      const parsedArgs = parseRunCommandArgs(rawArguments);
      const result = await runWorkspaceCommand(parsedArgs);

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
  validateCommandSafety(command);

  return executeShellCommand(
    command,
    absoluteCwd,
    relativeCwd,
    args.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  );
}

function parseRunCommandArgs(rawArguments: string): RunCommandArgs {
  const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  return runCommandArgsSchema.parse(parsed);
}

function validateCommandSafety(command: string): void {
  if (/[\r\n]/.test(command)) {
    throw new Error("run_command must be a single-line command.");
  }

  for (const rule of BLOCKED_COMMAND_RULES) {
    if (rule.pattern.test(command)) {
      throw new Error(`run_command rejected: ${rule.reason}`);
    }
  }
}

function executeShellCommand(
  command: string,
  absoluteCwd: string,
  relativeCwd: string,
  timeoutMs: number,
): Promise<RunCommandResult> {
  const shell = getShellCommand(command);

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
      resolve({
        command,
        cwd: relativeCwd,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        truncated,
      });
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

function getShellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      file: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", command],
    };
  }

  const shellPath = process.env["SHELL"] || "/bin/sh";
  return {
    file: shellPath,
    args: ["-lc", command],
  };
}
