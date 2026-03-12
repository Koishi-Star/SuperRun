import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { startMockOpenAIServer } from "./helpers/mock-openai-server.js";

test("CLI interactive mode preserves history across turns", async () => {
  const server = await startMockOpenAIServer([
    "Hello Ada.",
    "Your name is Ada.",
  ]);

  try {
    const cliPath = path.resolve("src/index.ts");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: server.baseURL,
          OPENAI_MODEL: "mock-model",
          OPENAI_TIMEOUT_MS: "5000",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

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

    child.stdin.write("\n");
    child.stdin.write("My name is Ada.\n");
    child.stdin.write("What is my name?\n");
    child.stdin.end("/exit\n");

    const [exitCode] = (await once(child, "close")) as [number | null];

    assert.equal(exitCode, 0, stderr || "CLI exited with a non-zero code.");
    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.requests[1]?.messages, [
      {
        role: "system",
        content:
          "You are a helpful coding assistant. Be accurate, concise, and practical.",
      },
      { role: "user", content: "My name is Ada." },
      { role: "assistant", content: "Hello Ada." },
      { role: "user", content: "What is my name?" },
    ]);
    assert.match(stdout, /Interactive mode\. Type "\/exit" to quit\./);
    assert.match(stdout, /assistant: Hello Ada\./);
    assert.match(stdout, /assistant: Your name is Ada\./);
  } finally {
    await server.close();
  }
});

test("CLI handles local slash commands without calling the model", async () => {
  const server = await startMockOpenAIServer([]);

  try {
    const cliPath = path.resolve("src/index.ts");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: server.baseURL,
          OPENAI_MODEL: "mock-model",
          OPENAI_TIMEOUT_MS: "5000",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

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

    child.stdin.write("/help\n");
    child.stdin.end("/exit\n");

    const [exitCode] = (await once(child, "close")) as [number | null];

    assert.equal(exitCode, 0, stderr || "CLI exited with a non-zero code.");
    assert.equal(server.requests.length, 0);
    assert.match(stdout, /Commands: \/help \/settings \/session \/resume \/forget \/system \/system reset \/clear \/exit/);
  } finally {
    await server.close();
  }
});

test("CLI persists a custom system prompt and resets history when it changes", async () => {
  const server = await startMockOpenAIServer([
    "Hello Ada.",
    "I do not know your name from this fresh session.",
  ]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-cli-"));

  try {
    const cliPath = path.resolve("src/index.ts");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: server.baseURL,
          OPENAI_MODEL: "mock-model",
          OPENAI_TIMEOUT_MS: "5000",
          SUPERRUN_CONFIG_DIR: tempDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

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

    child.stdin.write("My name is Ada.\n");
    child.stdin.write("/system\n");
    child.stdin.write("You are a strict coding reviewer. Be terse and skeptical.\n");
    child.stdin.write("/save\n");
    child.stdin.write("What is my name?\n");
    child.stdin.end("/exit\n");

    const [exitCode] = (await once(child, "close")) as [number | null];

    assert.equal(exitCode, 0, stderr || "CLI exited with a non-zero code.");
    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.requests[1]?.messages, [
      {
        role: "system",
        content: "You are a strict coding reviewer. Be terse and skeptical.",
      },
      { role: "user", content: "What is my name?" },
    ]);
    assert.match(stdout, /This prompt controls the agent's behavior on every turn\./);
    assert.match(stdout, /Conversation history cleared so the new behavior starts cleanly\./);
    assert.match(stdout, /This agent will now behave as: You are a strict coding reviewer\. Be terse and skeptical\./);

    const settingsContent = await readFile(path.join(tempDir, "settings.json"), "utf8");
    assert.match(settingsContent, /You are a strict coding reviewer\. Be terse and skeptical\./);
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI can resume a saved session across runs and forget it", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-cli-"));
  const cliPath = path.resolve("src/index.ts");

  const firstServer = await startMockOpenAIServer(["Hello Ada."]);

  try {
    const firstChild = spawn(
      process.execPath,
      ["--import", "tsx", cliPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: firstServer.baseURL,
          OPENAI_MODEL: "mock-model",
          OPENAI_TIMEOUT_MS: "5000",
          SUPERRUN_CONFIG_DIR: tempDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let firstStderr = "";
    firstChild.stderr.setEncoding("utf8");
    firstChild.stderr.on("data", (chunk: string) => {
      firstStderr += chunk;
    });

    firstChild.stdin.write("My name is Ada.\n");
    firstChild.stdin.end("/exit\n");

    const [firstExitCode] = (await once(firstChild, "close")) as [number | null];
    assert.equal(firstExitCode, 0, firstStderr || "CLI exited with a non-zero code.");
  } finally {
    await firstServer.close();
  }

  const secondServer = await startMockOpenAIServer(["Your name is Ada."]);

  try {
    const secondChild = spawn(
      process.execPath,
      ["--import", "tsx", cliPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: secondServer.baseURL,
          OPENAI_MODEL: "mock-model",
          OPENAI_TIMEOUT_MS: "5000",
          SUPERRUN_CONFIG_DIR: tempDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    secondChild.stdout.setEncoding("utf8");
    secondChild.stderr.setEncoding("utf8");
    secondChild.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    secondChild.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    secondChild.stdin.write("/session\n");
    secondChild.stdin.write("/resume\n");
    secondChild.stdin.write("What is my name?\n");
    secondChild.stdin.write("/forget\n");
    secondChild.stdin.end("/exit\n");

    const [secondExitCode] = (await once(secondChild, "close")) as [number | null];

    assert.equal(secondExitCode, 0, stderr || "CLI exited with a non-zero code.");
    assert.equal(secondServer.requests.length, 1);
    assert.deepEqual(secondServer.requests[0]?.messages, [
      {
        role: "system",
        content:
          "You are a helpful coding assistant. Be accurate, concise, and practical.",
      },
      { role: "user", content: "My name is Ada." },
      { role: "assistant", content: "Hello Ada." },
      { role: "user", content: "What is my name?" },
    ]);
    assert.match(stdout, /Saved session available:/);
    assert.match(stdout, /Saved session: 1 turns, 2 messages, 25 chars\./);
    assert.match(stdout, /Resumed saved session from /);
    assert.match(stdout, /Removed saved session at /);

    await assert.rejects(
      () => readFile(path.join(tempDir, "session.json"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await secondServer.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
