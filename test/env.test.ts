import assert from "node:assert/strict";
import test from "node:test";
import { getOpenAICompatibleConfig } from "../src/utils/env.js";

test("getOpenAICompatibleConfig returns trimmed values and defaults", () => {
  const previousEnv = snapshotEnv();

  process.env.OPENAI_API_KEY = "  test-key  ";
  process.env.OPENAI_BASE_URL = "https://example.com/v1///";
  process.env.OPENAI_MODEL = "  test-model  ";
  process.env.OPENAI_TIMEOUT_MS = "9000";

  try {
    assert.deepEqual(getOpenAICompatibleConfig(), {
      apiKey: "test-key",
      baseURL: "https://example.com/v1",
      model: "test-model",
      timeoutMs: 9000,
    });
  } finally {
    restoreEnv(previousEnv);
  }
});

test("getOpenAICompatibleConfig throws when API key is missing", () => {
  const previousEnv = snapshotEnv();

  delete process.env.OPENAI_API_KEY;

  try {
    assert.throws(
      () => getOpenAICompatibleConfig(),
      /Missing OPENAI_API_KEY in environment variables\./,
    );
  } finally {
    restoreEnv(previousEnv);
  }
});

test("getOpenAICompatibleConfig throws on invalid timeout", () => {
  const previousEnv = snapshotEnv();

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_TIMEOUT_MS = "0";

  try {
    assert.throws(
      () => getOpenAICompatibleConfig(),
      /OPENAI_TIMEOUT_MS must be a positive integer when set\./,
    );
  } finally {
    restoreEnv(previousEnv);
  }
});

function snapshotEnv(): Record<string, string | undefined> {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_TIMEOUT_MS: process.env.OPENAI_TIMEOUT_MS,
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
