import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import test from "node:test";
import { startMockOpenAIServer } from "./helpers/mock-openai-server.js";

test("CLI interactive mode preserves history across turns", async () => {
  const server = await startMockOpenAIServer([
    "Hello Ada.",
    "Your name is Ada.",
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
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI handles local slash commands and rejects unknown slash commands without calling the model", async () => {
  const server = await startMockOpenAIServer([]);
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

    child.stdin.write("/help\n");
    child.stdin.write("/sessiojn\n");
    child.stdin.end("/exit\n");

    const [exitCode] = (await once(child, "close")) as [number | null];

    assert.equal(exitCode, 0, stderr || "CLI exited with a non-zero code.");
    assert.equal(server.requests.length, 0);
    assert.match(stdout, /Commands: \/help \/settings \/session \/history \[id\|index\|title\] \/sessions \[query\] \/new \/switch <id\|index\|title> \/rename <title> \/delete \[id\|index\|title\] \/system \/system reset \/clear \/exit/);
    assert.match(stderr, /error: Unknown command: \/sessiojn\. Type \/help\./);
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI accepts exit aliases in interactive mode", async () => {
  const server = await startMockOpenAIServer([]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-cli-"));

  try {
    const cliPath = path.resolve("src/index.ts");

    for (const exitCommand of ["exit", "exit()"]) {
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

      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.stdin.end(`${exitCommand}\n`);

      const [exitCode] = (await once(child, "close")) as [number | null];
      assert.equal(exitCode, 0, stderr || `CLI exited with a non-zero code for ${exitCommand}.`);
    }

    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
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
    assert.match(stdout, /This prompt controls the default behavior for the current conversation\./);
    assert.match(stdout, /Conversation history cleared so the new behavior starts cleanly\./);
    assert.match(stdout, /This agent will now behave as: You are a strict coding reviewer\. Be terse and skeptical\./);

    const settingsContent = await readFile(path.join(tempDir, "settings.json"), "utf8");
    assert.match(settingsContent, /You are a strict coding reviewer\. Be terse and skeptical\./);
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI can rename sessions, show previews, and switch by list index", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-cli-"));
  const cliPath = path.resolve("src/index.ts");

  const firstServer = await startMockOpenAIServer([
    "Hello Ada.",
    "Hello Grace.",
  ]);

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
    firstChild.stdin.write("/new\n");
    firstChild.stdin.write("My name is Grace.\n");
    firstChild.stdin.end("/exit\n");

    const [firstExitCode] = (await once(firstChild, "close")) as [number | null];
    assert.equal(firstExitCode, 0, firstStderr || "CLI exited with a non-zero code.");
  } finally {
    await firstServer.close();
  }

  const indexPath = path.join(tempDir, "sessions", "index.json");
  const sessionFiles = await readdir(path.join(tempDir, "sessions"));
  const storedSessionIds = sessionFiles
    .filter((name) => name.endsWith(".json") && name !== "index.json")
    .map((name) => name.replace(/\.json$/, ""));
  assert.equal(storedSessionIds.length, 2);

  let adaSessionId = "";

  for (const sessionId of storedSessionIds) {
    const content = await readFile(
      path.join(tempDir, "sessions", `${sessionId}.json`),
      "utf8",
    );
    if (content.includes("My name is Ada.")) {
      adaSessionId = sessionId;
      break;
    }
  }

  assert.ok(adaSessionId, "Expected to find a saved session containing Ada.");

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

    secondChild.stdin.write("/sessions\n");
    secondChild.stdin.write("/switch 2\n");
    secondChild.stdin.write("/rename Ada Session\n");
    secondChild.stdin.write("What is my name?\n");
    secondChild.stdin.write("/sessions\n");
    secondChild.stdin.write("/delete Ada Session\n");
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
    assert.match(stdout, new RegExp(`Current session: .*Saved sessions: 2\\.`));
    assert.match(stdout, /Use "\/switch <index>", "\/switch <id>", or "\/switch <title>" to load a session\./);
    assert.match(stdout, /\* 1\. My name is Grace\./);
    assert.match(stdout, / 2\. My name is Ada\./);
    assert.match(stdout, new RegExp(`Switched to session: My name is Ada\\. \\[${adaSessionId}\\]`));
    assert.match(stdout, new RegExp(`Renamed session: Ada Session \\[${adaSessionId}\\]`));
    assert.match(stdout, new RegExp(`\\* 1\\. Ada Session \\[${adaSessionId}\\]`));
    assert.match(stdout, /Assistant: Your name is Ada\./);
    assert.match(stdout, new RegExp(`Deleted session: ${adaSessionId}`));

    const indexContent = await readFile(indexPath, "utf8");
    assert.doesNotMatch(indexContent, new RegExp(adaSessionId));
  } finally {
    await secondServer.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI can show current and selected session history without calling the model again", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-cli-"));
  const cliPath = path.resolve("src/index.ts");
  const firstServer = await startMockOpenAIServer([
    "Hello Ada.",
    "Hello Grace.",
  ]);

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
    firstChild.stdin.write("/new\n");
    firstChild.stdin.write("My name is Grace.\n");
    firstChild.stdin.end("/exit\n");

    const [firstExitCode] = (await once(firstChild, "close")) as [number | null];
    assert.equal(firstExitCode, 0, firstStderr || "CLI exited with a non-zero code.");
  } finally {
    await firstServer.close();
  }

  const sessionFiles = await readdir(path.join(tempDir, "sessions"));
  const storedSessionIds = sessionFiles
    .filter((name) => name.endsWith(".json") && name !== "index.json")
    .map((name) => name.replace(/\.json$/, ""));

  let adaSessionId = "";

  for (const sessionId of storedSessionIds) {
    const content = await readFile(
      path.join(tempDir, "sessions", `${sessionId}.json`),
      "utf8",
    );
    if (content.includes("My name is Ada.")) {
      adaSessionId = sessionId;
      break;
    }
  }

  assert.ok(adaSessionId, "Expected to find a saved session containing Ada.");

  const secondServer = await startMockOpenAIServer([]);

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

    secondChild.stdin.write("/history\n");
    secondChild.stdin.write("/history 2\n");
    secondChild.stdin.end("exit()\n");

    const [secondExitCode] = (await once(secondChild, "close")) as [number | null];

    assert.equal(secondExitCode, 0, stderr || "CLI exited with a non-zero code.");
    assert.equal(secondServer.requests.length, 0);
    assert.match(stdout, /History\r?\nSession: My name is Grace\./);
    assert.match(stdout, /Viewing the current conversation\./);
    assert.match(stdout, /1\. You\r?\n   My name is Grace\./);
    assert.match(stdout, /2\. Assistant\r?\n   Hello Grace\./);
    assert.match(stdout, new RegExp(`History\\r?\\nSession: My name is Ada\\. \\[${adaSessionId}\\]`));
    assert.match(stdout, /1\. You\r?\n   My name is Ada\./);
    assert.match(stdout, /2\. Assistant\r?\n   Hello Ada\./);
  } finally {
    await secondServer.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI can filter saved sessions by title or preview text", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-cli-"));
  const cliPath = path.resolve("src/index.ts");
  const firstServer = await startMockOpenAIServer([
    "Blue heron.",
    "Basalt flow.",
  ]);

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

    firstChild.stdin.write("Ornithology note.\n");
    firstChild.stdin.write("/new\n");
    firstChild.stdin.write("Volcanology note.\n");
    firstChild.stdin.end("/exit\n");

    const [firstExitCode] = (await once(firstChild, "close")) as [number | null];
    assert.equal(firstExitCode, 0, firstStderr || "CLI exited with a non-zero code.");
  } finally {
    await firstServer.close();
  }

  const secondServer = await startMockOpenAIServer([]);

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

    secondChild.stdin.write("/sessions basalt\n");
    secondChild.stdin.write("/sessions missing-term\n");
    secondChild.stdin.end("/exit\n");

    const [secondExitCode] = (await once(secondChild, "close")) as [number | null];

    assert.equal(secondExitCode, 0, stderr || "CLI exited with a non-zero code.");
    assert.equal(secondServer.requests.length, 0);
    assert.match(stdout, /Sessions\r?\nFilter: "basalt" \(1 match\)\./);
    assert.match(stdout, /Volcanology note\./);
    assert.match(stdout, /Assistant: Basalt flow\./);
    assert.match(stdout, /No saved sessions match "missing-term"\./);
  } finally {
    await secondServer.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
