import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { getDeleteAreaBannerText } from "../src/cli.js";
import { startMockOpenAIServer } from "./helpers/mock-openai-server.js";

async function spawnCLI(args: string[], env: NodeJS.ProcessEnv) {
  const cliPath = path.resolve("src/index.ts");
  const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const [exitCode] = (await once(child, "close")) as [number | null];
  return { exitCode, stdout, stderr };
}

test("CLI single-turn mode streams a prompt response without requiring a TTY", async () => {
  const server = await startMockOpenAIServer(["Hello from prompt mode."]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-cli-"));

  try {
    const result = await spawnCLI(
      ["Hello there."],
      {
        ...process.env,
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: server.baseURL,
        OPENAI_MODEL: "mock-model",
        OPENAI_TIMEOUT_MS: "5000",
        SUPERRUN_CONFIG_DIR: tempDir,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr || "CLI exited with a non-zero code.");
    assert.equal(server.requests.length, 1);
    assert.match(result.stdout, /Risk notice: this agent may read, run, modify, delete, or create files in the workspace\./);
    assert.match(result.stdout, /user: Hello there\./);
    assert.match(result.stdout, /assistant: Hello from prompt mode\./);
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI rejects non-TTY interactive mode so Ink remains the only supported chat path", async () => {
  const server = await startMockOpenAIServer([]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-cli-"));

  try {
    const result = await spawnCLI(
      [],
      {
        ...process.env,
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: server.baseURL,
        OPENAI_MODEL: "mock-model",
        OPENAI_TIMEOUT_MS: "5000",
        SUPERRUN_CONFIG_DIR: tempDir,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(server.requests.length, 0);
    assert.match(
      result.stderr,
      /error: Interactive mode requires a TTY\. Run `superrun "<prompt>"` for single-turn use, or start SuperRun from an interactive terminal to use the Ink chat shell\./,
    );
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI single-turn ask mode no longer falls back to readline approval prompts", async () => {
  const server = await startMockOpenAIServer([
    {
      toolCalls: [
        {
          id: "call_1",
          name: "run_command",
          arguments: JSON.stringify({
            command: "npm install",
          }),
        },
      ],
    },
    "Command execution was blocked pending interactive approval.",
  ]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-cli-"));

  try {
    const result = await spawnCLI(
      ["Install dependencies."],
      {
        ...process.env,
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: server.baseURL,
        OPENAI_MODEL: "mock-model",
        OPENAI_TIMEOUT_MS: "5000",
        SUPERRUN_CONFIG_DIR: tempDir,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr || "CLI exited with a non-zero code.");
    assert.equal(server.requests.length, 2);
    assert.match(result.stdout, /assistant: Command execution was blocked pending interactive approval\./);

    const toolMessage = server.requests[1]?.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    assert.match(
      String(toolMessage?.content ?? ""),
      /requires approval for write commands\. Re-run in a TTY or switch approvals to allow-all\./,
    );
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI single-turn write_file tool calls also require Ink approval in ask mode", async () => {
  const server = await startMockOpenAIServer([
    {
      toolCalls: [
        {
          id: "call_1",
          name: "write_file",
          arguments: JSON.stringify({
            path: "note.txt",
            content: "hello\n",
          }),
        },
      ],
    },
    "The write was blocked pending interactive approval.",
  ]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-cli-"));

  try {
    const result = await spawnCLI(
      ["Create a note."],
      {
        ...process.env,
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: server.baseURL,
        OPENAI_MODEL: "mock-model",
        OPENAI_TIMEOUT_MS: "5000",
        SUPERRUN_CONFIG_DIR: tempDir,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr || "CLI exited with a non-zero code.");
    assert.equal(server.requests.length, 2);
    assert.match(result.stdout, /assistant: The write was blocked pending interactive approval\./);

    const toolMessage = server.requests[1]?.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    assert.match(
      String(toolMessage?.content ?? ""),
      /write_file requires approval\. Re-run in the Ink TTY shell or switch approvals to allow-all\./,
    );
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("delete area banner text appears only when the delete area is non-empty", () => {
  assert.equal(
    getDeleteAreaBannerText({ fileCount: 0, totalBytes: 0 }),
    null,
  );
  assert.match(
    getDeleteAreaBannerText({ fileCount: 2, totalBytes: 4096 }) ?? "",
    /Delete area now has 2 files \(about 4 KB\)\. Ask SuperRun to use list_deleted_files, restore_deleted_file, purge_deleted_file, or empty_delete_area\./,
  );
});
