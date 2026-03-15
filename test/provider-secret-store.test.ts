import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  clearPersistedProviderApiKey,
  loadPersistedProviderApiKeys,
  savePersistedProviderApiKey,
} from "../src/config/provider-secrets.js";

test("provider secret store persists obfuscated provider API keys and clears them", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-provider-secrets-"));
  const filePath = path.join(tempDir, "provider-secrets.json");
  const installSecretFilePath = path.join(tempDir, "provider-secrets.seed");

  try {
    await savePersistedProviderApiKey("kimi", "kimi-secret-value", {
      filePath,
      installSecretFilePath,
      installSecret: "fixed-test-secret",
    });

    const rawFile = await readFile(filePath, "utf8");
    assert.match(rawFile, /"format": "local-obfuscated-v1"/);
    assert.doesNotMatch(rawFile, /kimi-secret-value/);
    assert.match(rawFile, /"ciphertext":/);
    assert.match(rawFile, /"iv":/);
    assert.match(rawFile, /"tag":/);

    const loadedAfterFirstSave = await loadPersistedProviderApiKeys({
      filePath,
      installSecretFilePath,
      installSecret: "fixed-test-secret",
    });
    assert.equal(loadedAfterFirstSave.kimi, "kimi-secret-value");

    await savePersistedProviderApiKey("openai_compatible", "openai-secret-value", {
      filePath,
      installSecretFilePath,
      installSecret: "fixed-test-secret",
    });

    const loadedAfterSecondSave = await loadPersistedProviderApiKeys({
      filePath,
      installSecretFilePath,
      installSecret: "fixed-test-secret",
    });
    assert.equal(loadedAfterSecondSave.kimi, "kimi-secret-value");
    assert.equal(loadedAfterSecondSave.openai_compatible, "openai-secret-value");

    await clearPersistedProviderApiKey("kimi", { filePath });
    const loadedAfterClear = await loadPersistedProviderApiKeys({
      filePath,
      installSecretFilePath,
      installSecret: "fixed-test-secret",
    });
    assert.equal(loadedAfterClear.kimi, undefined);
    assert.equal(loadedAfterClear.openai_compatible, "openai-secret-value");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("provider secret store regenerates a legacy unsupported secret file on the next save", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-provider-secrets-"));
  const filePath = path.join(tempDir, "provider-secrets.json");
  const installSecretFilePath = path.join(tempDir, "provider-secrets.seed");

  try {
    await writeFile(
      filePath,
      `${JSON.stringify({
        format: "windows-dpapi-v1",
        keys: {
          kimi: {
            iv: "legacy",
            tag: "legacy",
            ciphertext: "legacy",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const loadedBeforeSave = await loadPersistedProviderApiKeys({
      filePath,
      installSecretFilePath,
      installSecret: "fixed-test-secret",
    });
    assert.deepEqual(loadedBeforeSave, {});

    await savePersistedProviderApiKey("kimi", "new-kimi-secret", {
      filePath,
      installSecretFilePath,
      installSecret: "fixed-test-secret",
    });

    const loadedAfterSave = await loadPersistedProviderApiKeys({
      filePath,
      installSecretFilePath,
      installSecret: "fixed-test-secret",
    });
    assert.equal(loadedAfterSave.kimi, "new-kimi-secret");

    const rewrittenFile = await readFile(filePath, "utf8");
    assert.match(rewrittenFile, /"format": "local-obfuscated-v1"/);
    assert.doesNotMatch(rewrittenFile, /windows-dpapi-v1/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
