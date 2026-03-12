import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  createAgentSession,
  getAgentSessionStats,
  runAgentTurn,
} from "../src/agent/loop.js";
import { startMockOpenAIServer } from "./helpers/mock-openai-server.js";

test("runAgentTurn appends history and sends prior turns", async () => {
  const server = await startMockOpenAIServer(["First answer", "Second answer"]);
  const previousEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_TIMEOUT_MS: process.env.OPENAI_TIMEOUT_MS,
  };

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = server.baseURL;
  process.env.OPENAI_MODEL = "mock-model";
  process.env.OPENAI_TIMEOUT_MS = "5000";

  try {
    const session = createAgentSession({ systemPrompt: "Test system prompt" });

    const firstReply = await runAgentTurn(session, "  Hello  ");
    assert.equal(firstReply, "First answer");
    assert.deepEqual(session.history, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "First answer" },
    ]);

    const secondReply = await runAgentTurn(session, "What did I say?");
    assert.equal(secondReply, "Second answer");
    assert.deepEqual(server.requests[1]?.messages, [
      { role: "system", content: "Test system prompt" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "What did I say?" },
    ]);
    assert.deepEqual(session.history, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "What did I say?" },
      { role: "assistant", content: "Second answer" },
    ]);
  } finally {
    restoreEnv(previousEnv);
    await server.close();
  }
});

test("runAgentTurn rejects empty prompts", async () => {
  const session = createAgentSession();

  await assert.rejects(
    () => runAgentTurn(session, "   "),
    /User prompt must not be empty\./,
  );
});

test("runAgentTurn trims history to the most recent configured turns", async () => {
  const server = await startMockOpenAIServer([
    "First answer",
    "Second answer",
    "Third answer",
  ]);
  const previousEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_TIMEOUT_MS: process.env.OPENAI_TIMEOUT_MS,
  };

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = server.baseURL;
  process.env.OPENAI_MODEL = "mock-model";
  process.env.OPENAI_TIMEOUT_MS = "5000";

  try {
    const session = createAgentSession({
      systemPrompt: "Test system prompt",
      maxHistoryTurns: 1,
    });

    await runAgentTurn(session, "First");
    await runAgentTurn(session, "Second");
    const thirdReply = await runAgentTurn(session, "Third");

    assert.equal(thirdReply, "Third answer");
    assert.deepEqual(server.requests[2]?.messages, [
      { role: "system", content: "Test system prompt" },
      { role: "user", content: "Second" },
      { role: "assistant", content: "Second answer" },
      { role: "user", content: "Third" },
    ]);
    assert.deepEqual(session.history, [
      { role: "user", content: "Third" },
      { role: "assistant", content: "Third answer" },
    ]);
  } finally {
    restoreEnv(previousEnv);
    await server.close();
  }
});

test("getAgentSessionStats reports simple turn and character counts", () => {
  const session = createAgentSession({
    systemPrompt: "System",
    maxHistoryTurns: 3,
    history: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Bye" },
      { role: "assistant", content: "Later" },
    ],
  });

  assert.deepEqual(getAgentSessionStats(session), {
    historyTurnCount: 2,
    historyMessageCount: 4,
    historyCharCount: 15,
    systemPromptCharCount: 6,
    maxHistoryTurns: 3,
  });
});

test("runAgentTurn resolves a list_files tool call before producing the final answer", async () => {
  const server = await startMockOpenAIServer([
    {
      toolCalls: [
        {
          id: "call_1",
          name: "list_files",
          arguments: JSON.stringify({ path: ".", depth: 1 }),
        },
      ],
    },
    "The workspace includes alpha.ts and beta.txt.",
  ]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-agent-tool-"));
  const previousCwd = process.cwd();
  const previousEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_TIMEOUT_MS: process.env.OPENAI_TIMEOUT_MS,
  };

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = server.baseURL;
  process.env.OPENAI_MODEL = "mock-model";
  process.env.OPENAI_TIMEOUT_MS = "5000";

  try {
    await writeFile(path.join(tempDir, "alpha.ts"), "export const alpha = 1;\n", "utf8");
    await writeFile(path.join(tempDir, "beta.txt"), "beta\n", "utf8");
    process.chdir(tempDir);

    const session = createAgentSession({ systemPrompt: "Test system prompt" });
    const reply = await runAgentTurn(session, "What files are here?");

    assert.equal(reply, "The workspace includes alpha.ts and beta.txt.");
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0]?.tools?.[0]?.function?.name, "list_files");
    assert.deepEqual(server.requests[1]?.messages, [
      { role: "system", content: "Test system prompt" },
      { role: "user", content: "What files are here?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "list_files",
              arguments: "{\"path\":\".\",\"depth\":1}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content:
          "{\"ok\":true,\"path\":\".\",\"depth\":1,\"entries\":[{\"path\":\"alpha.ts\",\"type\":\"file\"},{\"path\":\"beta.txt\",\"type\":\"file\"}],\"truncated\":false}",
      },
    ]);
    assert.deepEqual(session.history, [
      { role: "user", content: "What files are here?" },
      { role: "assistant", content: "The workspace includes alpha.ts and beta.txt." },
    ]);
  } finally {
    process.chdir(previousCwd);
    restoreEnv(previousEnv);
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runAgentTurn preserves provider reasoning_content across tool calls", async () => {
  const server = await startMockOpenAIServer([
    {
      reasoningContent: "Need to inspect the workspace before answering.",
      toolCalls: [
        {
          id: "call_1",
          name: "list_files",
          arguments: JSON.stringify({ path: ".", depth: 0 }),
        },
      ],
    },
    "There is one file here.",
  ]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-agent-reasoning-"));
  const previousCwd = process.cwd();
  const previousEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_TIMEOUT_MS: process.env.OPENAI_TIMEOUT_MS,
  };

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = server.baseURL;
  process.env.OPENAI_MODEL = "mock-model";
  process.env.OPENAI_TIMEOUT_MS = "5000";

  try {
    await writeFile(path.join(tempDir, "alpha.ts"), "export const alpha = 1;\n", "utf8");
    process.chdir(tempDir);

    const session = createAgentSession({ systemPrompt: "Test system prompt" });
    const reply = await runAgentTurn(session, "What files are here?");

    assert.equal(reply, "There is one file here.");
    assert.equal(
      server.requests[1]?.messages[2] &&
        "reasoning_content" in server.requests[1].messages[2]
        ? (server.requests[1].messages[2] as Record<string, unknown>).reasoning_content
        : undefined,
      "Need to inspect the workspace before answering.",
    );
  } finally {
    process.chdir(previousCwd);
    restoreEnv(previousEnv);
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

function restoreEnv(previousEnv: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}
