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
