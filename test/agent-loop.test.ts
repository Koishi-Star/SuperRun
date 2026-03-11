import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentSession,
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

function restoreEnv(previousEnv: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}
