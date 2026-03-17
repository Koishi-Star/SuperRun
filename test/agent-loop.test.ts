import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  AgentToolLoopLimitError,
  createAgentSession,
  getAgentSessionStats,
  runAgentTurn,
} from "../src/agent/loop.js";
import { createTaskPlan, updateTaskPlanStep } from "../src/agent/plan.js";
import type { UserInputRequest, UserInputResponse } from "../src/tools/types.js";
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
    assert.equal(firstReply.reply, "First answer");
    assert.deepEqual(session.history, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "First answer" },
    ]);

    const secondReply = await runAgentTurn(session, "What did I say?");
    assert.equal(secondReply.reply, "Second answer");
    assert.equal(server.requests[1]?.messages?.[0]?.role, "system");
    assert.equal(server.requests[1]?.messages?.[0]?.content, "Test system prompt");
    assert.equal(server.requests[1]?.messages?.[1]?.role, "system");
    assert.match(String(server.requests[1]?.messages?.[1]?.content ?? ""), /Runtime environment:/);
    assert.match(String(server.requests[1]?.messages?.[1]?.content ?? ""), /run_command shell:/);
    assert.deepEqual(server.requests[1]?.messages?.slice(2), [
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

    assert.equal(thirdReply.reply, "Third answer");
    assert.equal(server.requests[2]?.messages?.[0]?.role, "system");
    assert.equal(server.requests[2]?.messages?.[0]?.content, "Test system prompt");
    assert.equal(server.requests[2]?.messages?.[1]?.role, "system");
    assert.match(String(server.requests[2]?.messages?.[1]?.content ?? ""), /Runtime environment:/);
    assert.deepEqual(server.requests[2]?.messages?.slice(2), [
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
    currentContextTokens: null,
    effectiveContextLimitTokens: null,
    contextUsageSource: null,
  });
});

test("runAgentTurn prefers official usage when the provider returns token counts", async () => {
  const server = await startMockOpenAIServer([
    {
      content: "usage response",
      usage: {
        promptTokens: 42,
        completionTokens: 7,
        totalTokens: 49,
      },
    },
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
    const session = createAgentSession({ systemPrompt: "Test system prompt" });
    const result = await runAgentTurn(session, "Hello");

    assert.equal(result.reply, "usage response");
    assert.equal(result.usage?.promptTokens, 42);
    assert.equal(result.contextBudgetSnapshot.lastPromptTokens, 42);
    assert.equal(result.contextBudgetSnapshot.lastTotalTokens, 49);
    assert.equal(result.contextBudgetSnapshot.usageSource, "response");
  } finally {
    restoreEnv(previousEnv);
    await server.close();
  }
});

test("runAgentTurn aborts cleanly without mutating session history", async () => {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      res.writeHead(404).end();
      return;
    }

    for await (const _chunk of req) {
      // Fully consume the request body before delaying the response.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "Cache-Control": "no-cache",
    });
    res.write('data: {"choices":[{"delta":{"content":"late answer"}}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const previousEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_TIMEOUT_MS: process.env.OPENAI_TIMEOUT_MS,
  };

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://${address.address}:${address.port}`;
  process.env.OPENAI_MODEL = "mock-model";
  process.env.OPENAI_TIMEOUT_MS = "5000";

  try {
    const session = createAgentSession({ systemPrompt: "Test system prompt" });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new Error("Cancelled the active AI request."));
    }, 50);

    await assert.rejects(
      () => runAgentTurn(session, "Hello", {
        abortSignal: controller.signal,
        onChunk: () => {},
      }),
      /Cancelled the active AI request\./,
    );
    assert.deepEqual(session.history, []);
  } finally {
    restoreEnv(previousEnv);
    server.close();
    await once(server, "close");
  }
});

test("runAgentTurn retries provider request timeouts without consuming the turn", async () => {
  const server = await startMockOpenAIServer([
    {
      content: "slow first reply",
      delayMs: 80,
    },
    "Recovered after retry.",
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
  process.env.OPENAI_TIMEOUT_MS = "20";

  try {
    const session = createAgentSession({ systemPrompt: "Test system prompt" });
    const reply = await runAgentTurn(session, "Retry if the provider stalls.");

    assert.equal(reply.reply, "Recovered after retry.");
    assert.equal(server.requests.length, 2);
    assert.equal(
      server.requests[1]?.messages?.some((message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        /previous provider request timed out/i.test(message.content)
      ),
      true,
    );
  } finally {
    restoreEnv(previousEnv);
    await server.close();
  }
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

    const session = createAgentSession({
      mode: "strict",
      systemPrompt: "Test system prompt",
    });
    const reply = await runAgentTurn(session, "What files are here?");

    assert.equal(reply.reply, "The workspace includes alpha.ts and beta.txt.");
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0]?.tools?.[0]?.function?.name, "list_files");
    assert.equal(server.requests[1]?.messages?.[0]?.role, "system");
    assert.equal(server.requests[1]?.messages?.[0]?.content, "Test system prompt");
    assert.equal(server.requests[1]?.messages?.[1]?.role, "system");
    assert.match(String(server.requests[1]?.messages?.[1]?.content ?? ""), /Runtime environment:/);
    assert.deepEqual(server.requests[1]?.messages?.slice(2), [
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
        name: "list_files",
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

test("runAgentTurn uses the plan-mode prompt and plan-only tools", async () => {
  const server = await startMockOpenAIServer([
    {
      toolCalls: [
        {
          id: "call_1",
          name: "request_user_input",
          arguments: JSON.stringify({
            title: "Rendering boundary",
            question: "Which rendering boundary should stay fixed?",
            options: [
              {
                value: "keep-renderer",
                label: "Keep renderer boundary",
                description: "Preserve the current offscreen renderer and screen diff path.",
              },
              {
                value: "refactor-shell",
                label: "Refactor shell only",
                description: "Reshape shell state but keep the diff driver intact.",
              },
            ],
          }),
        },
      ],
    },
    "Plan mode can now continue with the clarified constraint.",
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
      mode: "plan",
      systemPrompt: "Test system prompt",
    });
    const reply = await runAgentTurn(session, "Design the plan mode.", {
      toolContext: {
        userInput: {
          requestUserInput: async () => ({
            kind: "option",
            value: "keep-renderer",
            label: "Keep renderer boundary",
            answer: "Keep renderer boundary",
          }),
        },
      },
    });

    assert.equal(reply.reply, "Plan mode can now continue with the clarified constraint.");
    assert.match(String(server.requests[0]?.messages[0]?.content ?? ""), /currently in plan mode/i);
    assert.match(String(server.requests[0]?.messages[1]?.content ?? ""), /Runtime environment:/);
    assert.deepEqual(
      server.requests[0]?.tools?.map((tool) => tool.function?.name),
      ["list_files", "search_workspace", "read_file", "request_user_input"],
    );
    const toolMessage = server.requests[1]?.messages[4];
    assert.equal(toolMessage?.role, "tool");
    assert.match(String(toolMessage?.content ?? ""), /"kind":"option"/);
    assert.match(String(toolMessage?.content ?? ""), /"value":"keep-renderer"/);
  } finally {
    restoreEnv(previousEnv);
    await server.close();
  }
});

test("runAgentTurn exposes request_user_input in default mode when interactive input is available", async () => {
  const server = await startMockOpenAIServer([
    {
      toolCalls: [
        {
          id: "call_1",
          name: "request_user_input",
          arguments: JSON.stringify({
            title: "First target",
            question: "Which file should I inspect first?",
            options: [
              {
                value: "cli",
                label: "cli.ts",
                description: "Inspect the main command entrypoint first.",
              },
              {
                value: "shell",
                label: "interactive-shell.tsx",
                description: "Start from the Ink shell renderer instead.",
              },
            ],
          }),
        },
      ],
    },
    "I will inspect cli.ts first.",
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
    const session = createAgentSession({ systemPrompt: "Test system prompt" });
    const reply = await runAgentTurn(session, "Add the new command.", {
      toolContext: {
        userInput: {
          requestUserInput: async () => ({
            kind: "option",
            value: "cli",
            label: "cli.ts",
            answer: "cli.ts",
          }),
        },
      },
    });

    assert.equal(reply.reply, "I will inspect cli.ts first.");
    assert.equal(
      server.requests[0]?.tools?.some((tool) => tool.function?.name === "request_user_input"),
      true,
    );
    assert.match(findLastToolMessageContent(server.requests[1]?.messages), /"kind":"option"/);
  } finally {
    restoreEnv(previousEnv);
    await server.close();
  }
});

test("runAgentTurn requires request_user_input when the model asks a plain-text clarifying question during an incomplete plan", async () => {
  const server = await startMockOpenAIServer([
    "Can you tell me which file owns slash-command handling?",
    JSON.stringify({ kind: "clarifying_question" }),
    {
      toolCalls: [
        {
          id: "call_1",
          name: "request_user_input",
          arguments: JSON.stringify({
            title: "Slash-command handler",
            question: "Which file should I inspect for slash-command handling?",
            options: [
              {
                value: "cli",
                label: "cli.ts",
                description: "Inspect the main CLI command router first.",
              },
              {
                value: "shell",
                label: "interactive-shell.tsx",
                description: "Start from the Ink shell instead.",
              },
            ],
          }),
        },
      ],
    },
    {
      toolCalls: [
        {
          id: "call_2",
          name: "update_plan",
          arguments: JSON.stringify({
            step_id: "step_1",
            status: "completed",
          }),
        },
      ],
    },
    "I found the handler and can continue.",
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
      activePlan: createClarificationPlan(),
    });
    const chunks: string[] = [];
    const reply = await runAgentTurn(session, "Add the /ciallo command.", {
      toolContext: createPlanAwareInteractiveToolContext(session, async () => ({
        kind: "option",
        value: "cli",
        label: "cli.ts",
        answer: "cli.ts",
      })),
      onChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    assert.equal(reply.reply, "I found the handler and can continue.");
    assert.equal(server.requests.length, 5);
    assert.equal(
      server.requests[2]?.messages?.some((message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        /call request_user_input instead of asking the user in plain text/i.test(message.content)
      ),
      true,
    );
    assert.equal(
      chunks.some((chunk) => /which file owns slash-command handling/i.test(chunk)),
      false,
    );
  } finally {
    restoreEnv(previousEnv);
    await server.close();
  }
});

test("runAgentTurn continues after the user dismisses a clarification request", async () => {
  const server = await startMockOpenAIServer([
    {
      toolCalls: [
        {
          id: "call_1",
          name: "request_user_input",
          arguments: JSON.stringify({
            title: "Target handler",
            question: "Which command handler should I inspect first?",
            options: [
              {
                value: "cli",
                label: "cli.ts",
                description: "Use the main CLI entrypoint as the default target.",
              },
              {
                value: "shell",
                label: "interactive-shell.tsx",
                description: "Use the Ink shell as the default target.",
              },
            ],
          }),
        },
      ],
    },
    "I cannot continue without your answer.",
    JSON.stringify({ kind: "depends_on_user_input" }),
    {
      toolCalls: [
        {
          id: "call_2",
          name: "update_plan",
          arguments: JSON.stringify({
            step_id: "step_1",
            status: "completed",
            note: "Assumed the existing CLI command handler was the right target.",
          }),
        },
      ],
    },
    "I assumed the existing CLI command handler was the right target and kept going.",
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
      activePlan: createClarificationPlan(),
    });
    const reply = await runAgentTurn(session, "Add the /ciallo command.", {
      toolContext: createPlanAwareInteractiveToolContext(session, async () => ({
        kind: "dismissed",
        value: null,
        label: null,
        answer: "",
      })),
    });

    assert.equal(
      reply.reply,
      "I assumed the existing CLI command handler was the right target and kept going.",
    );
    assert.equal(server.requests.length, 5);
    assert.equal(
      server.requests[3]?.messages?.some((message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        /user already declined a clarification request/i.test(message.content)
      ),
      true,
    );
  } finally {
    restoreEnv(previousEnv);
    await server.close();
  }
});

test("runAgentTurn keeps incomplete-plan retry drafts out of streamed assistant output", async () => {
  const server = await startMockOpenAIServer([
    "Let me search for where slash commands are processed in the file.",
    JSON.stringify({ kind: "other" }),
    {
      toolCalls: [
        {
          id: "call_1",
          name: "update_plan",
          arguments: JSON.stringify({
            step_id: "step_1",
            status: "completed",
            note: "Finished the initial inspection after the retry reminder.",
          }),
        },
      ],
    },
    "I completed the inspection step and can continue.",
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
      activePlan: createClarificationPlan(),
    });
    const chunks: string[] = [];
    const reply = await runAgentTurn(session, "Add the /ciallo command.", {
      toolContext: createPlanAwareInteractiveToolContext(session, async () => ({
        kind: "dismissed",
        value: null,
        label: null,
        answer: "",
      })),
      onChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    assert.equal(reply.reply, "I completed the inspection step and can continue.");
    assert.equal(
      chunks.some((chunk) => /Let me search for where slash commands are processed/i.test(chunk)),
      false,
    );
    assert.equal(
      server.requests.some((request) =>
        request.messages?.some((message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          /retry reason:/i.test(message.content) &&
          /attempted to finish before the remaining plan steps were completed or blocked/i.test(message.content)
        )
      ),
      true,
    );
  } finally {
    restoreEnv(previousEnv);
    await server.close();
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

    const session = createAgentSession({
      mode: "strict",
      systemPrompt: "Test system prompt",
    });
    const reply = await runAgentTurn(session, "What files are here?");

    assert.equal(reply.reply, "There is one file here.");
    assert.equal(
      server.requests[1]?.messages[3] &&
        "reasoning_content" in server.requests[1].messages[3]
        ? (server.requests[1].messages[3] as Record<string, unknown>).reasoning_content
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

test("runAgentTurn resolves a run_command tool call in default mode", async () => {
  const server = await startMockOpenAIServer([
    {
      toolCalls: [
        {
          id: "call_1",
          name: "run_command",
          arguments: JSON.stringify({
            command: "node -p \"process.cwd()\"",
          }),
        },
      ],
    },
    "The command printed the workspace path.",
  ]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-agent-command-"));
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
    process.chdir(tempDir);

    const session = createAgentSession({ systemPrompt: "Test system prompt" });
    const reply = await runAgentTurn(session, "Where am I?");

    assert.equal(reply.reply, "The command printed the workspace path.");
    assert.equal(
      server.requests[0]?.tools?.some((tool) => tool.function?.name === "run_command"),
      true,
    );

    assert.match(String(server.requests[0]?.messages?.[1]?.content ?? ""), /Runtime environment:/);

    const toolMessage = server.requests[1]?.messages[4];
    assert.equal(toolMessage?.role, "tool");
    assert.equal(toolMessage?.name, "run_command");
    assert.equal(
      typeof toolMessage?.content === "string" &&
        toolMessage.content.includes(`\"stdout\":\"${tempDir.replace(/\\/g, "\\\\")}`),
      true,
    );
  } finally {
    process.chdir(previousCwd);
    restoreEnv(previousEnv);
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runAgentTurn enforces outline-before-article for fetch_webpage", async () => {
  const pageHits = { count: 0 };
  const pageServer = createServer((req, res) => {
    if (req.url !== "/page") {
      res.writeHead(404).end();
      return;
    }

    pageHits.count += 1;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html>
        <head>
          <title>Policy Test</title>
          <meta name="description" content="Outline first." />
        </head>
        <body>
          <main>
            <h1>Overview</h1>
            <p>Detailed article body.</p>
          </main>
        </body>
      </html>`);
  });

  pageServer.listen(0, "127.0.0.1");
  await once(pageServer, "listening");
  const pageAddress = pageServer.address() as AddressInfo;
  const pageUrl = `http://${pageAddress.address}:${pageAddress.port}/page`;
  const server = await startMockOpenAIServer([
    {
      toolCalls: [
        {
          id: "call_1",
          name: "fetch_webpage",
          arguments: JSON.stringify({
            url: pageUrl,
            mode: "article",
          }),
        },
      ],
    },
    {
      toolCalls: [
        {
          id: "call_2",
          name: "fetch_webpage",
          arguments: JSON.stringify({
            url: pageUrl,
            mode: "article",
          }),
        },
      ],
    },
    "Finished staged web retrieval.",
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
    const session = createAgentSession({ systemPrompt: "Test system prompt" });
    const reply = await runAgentTurn(session, "Read the page.");

    assert.equal(reply.reply, "Finished staged web retrieval.");
    assert.equal(pageHits.count, 2);
    assert.equal(server.requests.length, 3);

    const firstToolContent = findLastToolMessageContent(server.requests[1]?.messages);
    assert.match(firstToolContent, /"mode":"outline"/);
    assert.match(firstToolContent, /"requestedMode":"article"/);
    assert.match(firstToolContent, /"policyApplied":"outline_before_article"/);
    assert.match(
      String(server.requests[1]?.messages.at(-1)?.content ?? ""),
      /outline-before-article retrieval/,
    );

    const secondToolContent = findLastToolMessageContent(server.requests[2]?.messages);
    assert.match(secondToolContent, /"mode":"article"/);
    assert.doesNotMatch(secondToolContent, /"policyApplied":"outline_before_article"/);
  } finally {
    restoreEnv(previousEnv);
    await server.close();
    pageServer.close();
    await once(pageServer, "close");
  }
});

test("runAgentTurn reuses cached fetch_webpage results across turns in the same session", async () => {
  const pageHits = { count: 0 };
  const pageServer = createServer((req, res) => {
    if (req.url !== "/page") {
      res.writeHead(404).end();
      return;
    }

    pageHits.count += 1;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html>
        <head><title>Cache Test</title></head>
        <body><main><h1>Cached Outline</h1></main></body>
      </html>`);
  });

  pageServer.listen(0, "127.0.0.1");
  await once(pageServer, "listening");
  const pageAddress = pageServer.address() as AddressInfo;
  const pageUrl = `http://${pageAddress.address}:${pageAddress.port}/page`;
  const server = await startMockOpenAIServer([
    {
      toolCalls: [
        {
          id: "call_1",
          name: "fetch_webpage",
          arguments: JSON.stringify({
            url: pageUrl,
            mode: "outline",
          }),
        },
      ],
    },
    "First web answer.",
    {
      toolCalls: [
        {
          id: "call_2",
          name: "fetch_webpage",
          arguments: JSON.stringify({
            url: pageUrl,
            mode: "outline",
          }),
        },
      ],
    },
    "Second web answer.",
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
    const session = createAgentSession({ systemPrompt: "Test system prompt" });
    const firstReply = await runAgentTurn(session, "Read the page once.");
    const secondReply = await runAgentTurn(session, "Read the same page again.");

    assert.equal(firstReply.reply, "First web answer.");
    assert.equal(secondReply.reply, "Second web answer.");
    assert.equal(pageHits.count, 1);

    const cachedToolContent = findLastToolMessageContent(server.requests[3]?.messages);
    assert.match(cachedToolContent, /"mode":"outline"/);
    assert.match(cachedToolContent, /"cacheHit":true/);
  } finally {
    restoreEnv(previousEnv);
    await server.close();
    pageServer.close();
    await once(pageServer, "close");
  }
});

test("runAgentTurn tolerates multi-step tool loops that exceed three rounds", async () => {
  const server = await startMockOpenAIServer([
    {
      toolCalls: [
        {
          id: "call_1",
          name: "list_files",
          arguments: JSON.stringify({ path: ".", depth: 0 }),
        },
      ],
    },
    {
      toolCalls: [
        {
          id: "call_2",
          name: "list_files",
          arguments: JSON.stringify({ path: ".", depth: 0 }),
        },
      ],
    },
    {
      toolCalls: [
        {
          id: "call_3",
          name: "list_files",
          arguments: JSON.stringify({ path: ".", depth: 0 }),
        },
      ],
    },
    {
      toolCalls: [
        {
          id: "call_4",
          name: "list_files",
          arguments: JSON.stringify({ path: ".", depth: 0 }),
        },
      ],
    },
    "Completed after several tool rounds.",
  ]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-agent-tool-rounds-"));
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

    const session = createAgentSession({
      mode: "strict",
      systemPrompt: "Test system prompt",
    });
    const reply = await runAgentTurn(session, "Inspect the workspace carefully.");

    assert.equal(reply.reply, "Completed after several tool rounds.");
    assert.equal(server.requests.length, 5);
  } finally {
    process.chdir(previousCwd);
    restoreEnv(previousEnv);
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runAgentTurn forces a final no-tool answer after repeated tool rounds", async () => {
  const server = await startMockOpenAIServer([
    ...Array.from({ length: 8 }, (_, index) => ({
      toolCalls: [
        {
          id: `call_${index + 1}`,
          name: "list_files",
          arguments: JSON.stringify({ path: ".", depth: 0 }),
        },
      ],
    })),
    "Final answer without more tools.",
  ]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-agent-final-answer-"));
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

    const session = createAgentSession({
      mode: "strict",
      systemPrompt: "Test system prompt",
    });
    const reply = await runAgentTurn(session, "Inspect carefully, then stop looping.");

    assert.equal(reply.reply, "Final answer without more tools.");
    assert.equal(server.requests.length, 9);
    assert.equal(server.requests[8]?.tools, undefined);
    assert.match(
      String(server.requests[8]?.messages.at(-1)?.content ?? ""),
      /Do not call more tools\./,
    );
  } finally {
    process.chdir(previousCwd);
    restoreEnv(previousEnv);
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runAgentTurn leaves history untouched when the model exceeds the tool-round limit", async () => {
  const server = await startMockOpenAIServer(
    Array.from({ length: 9 }, (_, index) => ({
      toolCalls: [
        {
          id: `call_${index + 1}`,
          name: "list_files",
          arguments: JSON.stringify({ path: ".", depth: 0 }),
        },
      ],
    })),
  );
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-agent-tool-limit-"));
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

    const session = createAgentSession({
      mode: "strict",
      systemPrompt: "Test system prompt",
    });

    await assert.rejects(
      () => runAgentTurn(session, "Keep trying forever."),
      (error) => error instanceof AgentToolLoopLimitError,
    );
    assert.deepEqual(session.history, []);
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

function createClarificationPlan() {
  return updateTaskPlanStep(
    createTaskPlan({
      title: "Clarify the command target",
      sourcePrompt: "Add the /ciallo command.",
      steps: [
        {
          title: "Clarify the target command path",
          details: "Confirm where slash-command handling should be updated first.",
        },
      ],
    }),
    "step_1",
    { status: "in_progress" },
  );
}

function createPlanAwareInteractiveToolContext(
  session: ReturnType<typeof createAgentSession>,
  requestUserInput: (request: UserInputRequest) => Promise<UserInputResponse>,
) {
  return {
    userInput: {
      requestUserInput,
    },
    plan: {
      updatePlan: async (request: {
        stepId: string;
        status?: "pending" | "in_progress" | "completed" | "blocked";
        note?: string | null;
      }) => {
        if (!session.activePlan) {
          throw new Error("Expected an active plan in the test context.");
        }

        const nextPlan = updateTaskPlanStep(session.activePlan, request.stepId, {
          ...(request.status ? { status: request.status } : {}),
          ...(request.note !== undefined ? { note: request.note } : {}),
        });
        session.activePlan = nextPlan;
        const nextStep = nextPlan.steps.find((step) => step.id === request.stepId);
        if (!nextStep) {
          throw new Error(`Unknown test plan step: ${request.stepId}`);
        }

        return {
          planId: nextPlan.id,
          stepId: nextStep.id,
          status: nextStep.status,
        };
      },
    },
  };
}

function findLastToolMessageContent(messages: Array<Record<string, unknown>> | undefined): string {
  if (!messages) {
    return "";
  }

  const toolMessage = [...messages]
    .reverse()
    .find((message) => message.role === "tool" && typeof message.content === "string");

  return typeof toolMessage?.content === "string" ? toolMessage.content : "";
}
