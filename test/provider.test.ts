import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSafeProcessEnv,
  resolveProviderRuntimeConfig,
  resolveProviderSettings,
} from "../src/llm/provider.js";

test("resolveProviderSettings keeps OpenAI-compatible as the default provider", () => {
  const previousEnv = snapshotEnv();

  try {
    delete process.env.SUPERRUN_PROVIDER;
    delete process.env.OPENAI_MODEL;
    const settings = resolveProviderSettings();

    assert.equal(settings.activeProvider, "openai_compatible");
    assert.equal(settings.openaiCompatible.model, "gpt-4o-mini");
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveProviderRuntimeConfig prefers runtime Kimi keys over environment values", () => {
  const previousEnv = snapshotEnv();
  process.env.MOONSHOT_API_KEY = "env-kimi-key";

  try {
    const runtime = resolveProviderRuntimeConfig(
      resolveProviderSettings({
        activeProvider: "kimi",
        kimi: {
          model: "kimi-test-model",
        },
      }),
      {
        kimi: "runtime-kimi-key",
      },
    );

    assert.equal(runtime.id, "kimi");
    assert.equal(runtime.apiKey, "runtime-kimi-key");
    assert.equal(runtime.apiKeySource, "runtime");
    assert.equal(runtime.apiKeyPlaceholder, "__kimi_token__");
  } finally {
    restoreEnv(previousEnv);
  }
});

test("buildSafeProcessEnv redacts provider API keys before subprocesses inherit them", () => {
  const safeEnv = buildSafeProcessEnv({
    ...process.env,
    OPENAI_API_KEY: "openai-secret",
    MOONSHOT_API_KEY: "kimi-secret",
  });

  assert.equal(safeEnv.OPENAI_API_KEY, "__provider_token__");
  assert.equal(safeEnv.MOONSHOT_API_KEY, "__kimi_token__");
});

function snapshotEnv(): Record<string, string | undefined> {
  return {
    SUPERRUN_PROVIDER: process.env.SUPERRUN_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    MOONSHOT_MODEL: process.env.MOONSHOT_MODEL,
  };
}

function restoreEnv(previousEnv: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}
