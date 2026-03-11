import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
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
    assert.match(stdout, /Commands: \/help \/clear \/exit/);
  } finally {
    await server.close();
  }
});
