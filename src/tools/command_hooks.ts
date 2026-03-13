import { spawn } from "node:child_process";
import type { CommandHookEvent, CommandHookResult } from "./types.js";
import { getPlatformShellCommand } from "./shell.js";

export function createEnvCommandHookRunner(): ((
  event: CommandHookEvent,
) => Promise<CommandHookResult | void>) | undefined {
  const beforeHook = process.env["SUPERRUN_PRE_COMMAND_HOOK"]?.trim();
  const afterHook = process.env["SUPERRUN_POST_COMMAND_HOOK"]?.trim();

  if (!beforeHook && !afterHook) {
    return undefined;
  }

  return async (event) => {
    const hookCommand = event.stage === "before" ? beforeHook : afterHook;
    if (!hookCommand) {
      return undefined;
    }

    const shell = getPlatformShellCommand(hookCommand);
    const rawOutput = await new Promise<string>((resolve, reject) => {
      const child = spawn(shell.file, shell.args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `Command hook exited with code ${code}: ${stderr.trim() || hookCommand}`,
            ),
          );
          return;
        }

        resolve(stdout.trim());
      });

      child.stdin.end(`${JSON.stringify(event)}\n`);
    });

    if (!rawOutput) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      throw new Error("Command hook returned invalid JSON.");
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Command hook must return a JSON object when it returns output.");
    }

    const action =
      "action" in parsed && typeof parsed.action === "string"
        ? parsed.action
        : undefined;
    const message =
      "message" in parsed && typeof parsed.message === "string"
        ? parsed.message
        : undefined;

    if (action && action !== "allow" && action !== "block") {
      throw new Error("Command hook action must be \"allow\" or \"block\".");
    }

    const result: CommandHookResult = {};
    if (action === "allow" || action === "block") {
      result.action = action;
    }
    if (message) {
      result.message = message;
    }

    return result;
  };
}
