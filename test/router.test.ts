import assert from "node:assert/strict";
import test from "node:test";
import { chatOnce } from "../src/llm/router.js";
import { resolveProviderRuntimeConfig, resolveProviderSettings } from "../src/llm/provider.js";
import { startMockOpenAIServer } from "./helpers/mock-openai-server.js";

test("chatOnce forwards response usage from OpenAI-compatible providers", async () => {
  const server = await startMockOpenAIServer([
    {
      content: "usage response",
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    },
  ]);

  try {
    const response = await chatOnce(
      [
        { role: "system", content: "You are a test system." },
        { role: "user", content: "Hello" },
      ],
      {
        providerConfig: resolveProviderRuntimeConfig(
          resolveProviderSettings({
            activeProvider: "openai_compatible",
            openaiCompatible: {
              baseURL: server.baseURL,
              model: "mock-model",
            },
          }),
          {
            openai_compatible: "test-key",
          },
        ),
      },
    );

    assert.equal(response.content, "usage response");
    assert.deepEqual(response.usage, {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      source: "response",
    });
  } finally {
    await server.close();
  }
});

test("chatOnce repairs inline function-call markup into normalized tool calls", async () => {
  const server = await startMockOpenAIServer([
    {
      content: [
        "Let me inspect the repository first.",
        "<function_calls>",
        '<invoke name="search_workspace">',
        '<parameter name="pattern">/ciallo</parameter>',
        '<parameter name="path">src</parameter>',
        "</invoke>",
        "</function_calls>",
      ].join("\n"),
    },
  ]);

  try {
    const response = await chatOnce(
      [
        { role: "system", content: "You are a test system." },
        { role: "user", content: "Hello" },
      ],
      {
        providerConfig: resolveProviderRuntimeConfig(
          resolveProviderSettings({
            activeProvider: "openai_compatible",
            openaiCompatible: {
              baseURL: server.baseURL,
              model: "mock-model",
            },
          }),
          {
            openai_compatible: "test-key",
          },
        ),
      },
    );

    assert.equal(response.content, "Let me inspect the repository first.");
    assert.deepEqual(response.toolCalls, [
      {
        id: "inline_call_1",
        name: "search_workspace",
        arguments: JSON.stringify({
          pattern: "/ciallo",
          path: "src",
        }),
      },
    ]);
  } finally {
    await server.close();
  }
});

test("chatOnce strips orphaned tool_call_ids before sending the request to the provider", async () => {
  // Simulate a history where an assistant message carries 3 tool_calls but
  // only 2 matching tool-result messages are present (the third was
  // compressed or dropped upstream).  The serialization safeguard must strip
  // the orphaned tool_call before the request reaches the provider.
  const server = await startMockOpenAIServer(["Sanitized successfully."]);

  try {
    const response = await chatOnce(
      [
        { role: "system", content: "System." },
        { role: "user", content: "Do things." },
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            { id: "tc_1", name: "read_file", arguments: '{"path":"a.ts"}' },
            { id: "tc_2", name: "run_command", arguments: '{"command":"ls"}' },
            { id: "tc_3", name: "search_workspace", arguments: '{"pattern":"x"}' },
          ],
        },
        { role: "tool" as const, content: "file content", toolCallId: "tc_1", toolName: "read_file" },
        // tc_2 is missing — orphaned
        { role: "tool" as const, content: "3 matches", toolCallId: "tc_3", toolName: "search_workspace" },
        { role: "user", content: "Continue." },
      ],
      {
        providerConfig: resolveProviderRuntimeConfig(
          resolveProviderSettings({
            activeProvider: "openai_compatible",
            openaiCompatible: {
              baseURL: server.baseURL,
              model: "mock-model",
            },
          }),
          {
            openai_compatible: "test-key",
          },
        ),
      },
    );

    assert.equal(response.content, "Sanitized successfully.");

    // Verify the request that reached the mock server has no orphaned tool_call_ids.
    const sentMessages = server.requests[0]?.messages ?? [];
    const assistantMsg = sentMessages.find(
      (m: Record<string, unknown>) => m.role === "assistant" && Array.isArray(m.tool_calls),
    ) as { tool_calls?: Array<{ id: string }> } | undefined;

    assert.ok(assistantMsg, "Expected an assistant message with tool_calls");
    const sentIds = (assistantMsg?.tool_calls ?? []).map((tc) => tc.id);
    assert.deepEqual(sentIds, ["tc_1", "tc_3"], "Orphaned tc_2 should have been stripped");
  } finally {
    await server.close();
  }
});

test("chatOnce handles reused tool_call_ids across rounds without false matches", async () => {
  // Kimi reuses tool_call_ids like "read_file:1" across rounds.  If round N-1's
  // tool results are compressed away but round N uses the same ID, the
  // sanitizer must NOT let round N's result vouch for round N-1's assistant.
  const server = await startMockOpenAIServer(["Done."]);

  try {
    const response = await chatOnce(
      [
        { role: "system", content: "System." },
        { role: "user", content: "Do things." },
        // Round N-1 assistant — its tool results were compressed (absent)
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            { id: "read_file:1", name: "read_file", arguments: '{"path":"a.ts"}' },
            { id: "update_plan:0", name: "update_plan", arguments: '{}' },
          ],
        },
        // No tool results for round N-1 (they were compressed)
        // Round N assistant — same read_file:1 ID, different round
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            { id: "replace_lines:0", name: "replace_lines", arguments: '{}' },
            { id: "read_file:1", name: "read_file", arguments: '{"path":"b.ts"}' },
          ],
        },
        { role: "tool" as const, content: "replaced", toolCallId: "replace_lines:0", toolName: "replace_lines" },
        { role: "tool" as const, content: "file b", toolCallId: "read_file:1", toolName: "read_file" },
        { role: "user", content: "Continue." },
      ],
      {
        providerConfig: resolveProviderRuntimeConfig(
          resolveProviderSettings({
            activeProvider: "openai_compatible",
            openaiCompatible: {
              baseURL: server.baseURL,
              model: "mock-model",
            },
          }),
          {
            openai_compatible: "test-key",
          },
        ),
      },
    );

    assert.equal(response.content, "Done.");

    const sentMessages = server.requests[0]?.messages ?? [];
    // Round N-1 assistant should have ALL toolCalls stripped (no following tool results)
    const firstAssistant = sentMessages.filter(
      (m: Record<string, unknown>) => m.role === "assistant" && Array.isArray(m.tool_calls),
    ) as Array<{ tool_calls?: Array<{ id: string }> }>;

    if (firstAssistant.length >= 2) {
      // First assistant (round N-1): should have no tool_calls (both stripped)
      assert.fail("Round N-1 assistant should have had all tool_calls stripped and thus no tool_calls property");
    }

    // Only round N's assistant should survive with tool_calls
    assert.equal(firstAssistant.length, 1, "Only round N assistant should have tool_calls");
    const roundNIds = (firstAssistant[0]?.tool_calls ?? []).map((tc) => tc.id);
    assert.deepEqual(roundNIds, ["replace_lines:0", "read_file:1"]);
  } finally {
    await server.close();
  }
});
