import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  attachProviderCatalogMetadata,
  createProviderCatalogState,
  refreshProviderCatalog,
  summarizeProviderCatalogRefresh,
} from "../src/llm/provider-catalog.js";
import { resolveProviderRuntimeConfig, resolveProviderSettings } from "../src/llm/provider.js";

test("refreshProviderCatalog parses Kimi models and falls back to registry context lengths", async () => {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/models") {
      res.writeHead(404).end();
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: [
        { id: "kimi-latest" },
        { id: "kimi-thinking-preview", context_length: "256k" },
      ],
    }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address() as AddressInfo;
    const provider = resolveProviderRuntimeConfig(
      resolveProviderSettings({
        activeProvider: "kimi",
        kimi: {
          baseURL: `http://${address.address}:${address.port}`,
          model: "kimi-latest",
        },
      }),
      { kimi: "test-key" },
    );

    const catalog = await refreshProviderCatalog(provider);
    assert.equal(catalog.status, "ready");
    assert.equal(catalog.models.length, 2);
    assert.equal(catalog.models[0]?.contextTokens, 256_000);

    const state = createProviderCatalogState();
    state.kimi = catalog;
    const runtime = attachProviderCatalogMetadata(provider, state);
    assert.equal(runtime.modelContextTokens, 256_000);
    assert.equal(runtime.modelContextSource, "registry");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("refreshProviderCatalog returns an error state when the Kimi model request fails", async () => {
  const server = createServer((_, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "upstream down" } }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address() as AddressInfo;
    const provider = resolveProviderRuntimeConfig(
      resolveProviderSettings({
        activeProvider: "kimi",
        kimi: {
          baseURL: `http://${address.address}:${address.port}`,
          model: "custom-kimi-model",
        },
      }),
      { kimi: "test-key" },
    );

    const catalog = await refreshProviderCatalog(provider);
    assert.equal(catalog.status, "error");
    assert.match(catalog.errorMessage ?? "", /upstream down/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("summarizeProviderCatalogRefresh warns when the current Kimi model is not accessible", () => {
  const provider = resolveProviderRuntimeConfig(
    resolveProviderSettings({
      activeProvider: "kimi",
      kimi: {
        baseURL: "https://api.moonshot.cn/v1",
        model: "kimi-latest",
      },
    }),
    { kimi: "test-key" },
  );

  const feedback = summarizeProviderCatalogRefresh(provider, {
    status: "ready",
    models: [
      {
        id: "moonshot-v1-128k",
        contextTokens: 131_072,
        contextSource: "response",
      },
    ],
    errorMessage: null,
    fetchedAt: "2026-03-16T00:00:00.000Z",
  });

  assert.equal(feedback?.level, "warning");
  assert.match(feedback?.message ?? "", /Current model kimi-latest is not in the accessible list/);
  assert.match(feedback?.message ?? "", /Use "\/model" to switch/);
});

test("summarizeProviderCatalogRefresh confirms when the current Kimi model is accessible", () => {
  const provider = resolveProviderRuntimeConfig(
    resolveProviderSettings({
      activeProvider: "kimi",
      kimi: {
        baseURL: "https://api.moonshot.cn/v1",
        model: "moonshot-v1-128k",
      },
    }),
    { kimi: "test-key" },
  );

  const feedback = summarizeProviderCatalogRefresh(provider, {
    status: "ready",
    models: [
      {
        id: "moonshot-v1-128k",
        contextTokens: 131_072,
        contextSource: "response",
      },
    ],
    errorMessage: null,
    fetchedAt: "2026-03-16T00:00:00.000Z",
  });

  assert.equal(feedback?.level, "info");
  assert.match(feedback?.message ?? "", /Loaded 1 Kimi model/);
  assert.match(feedback?.message ?? "", /Current model moonshot-v1-128k is available/);
});
