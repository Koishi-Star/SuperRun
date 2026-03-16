import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { executeAgentTool, getAgentToolDefinitions } from "../src/tools/index.js";

test("default mode exposes fetch_webpage but strict mode does not", () => {
  assert.equal(
    getAgentToolDefinitions("default").some((tool) => tool.name === "fetch_webpage"),
    true,
  );
  assert.equal(
    getAgentToolDefinitions("strict").some((tool) => tool.name === "fetch_webpage"),
    false,
  );
});

test("fetch_webpage outline mode returns page metadata and heading structure", async () => {
  const server = createServer((req, res) => {
    if (req.url !== "/page") {
      res.writeHead(404).end();
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html>
        <head>
          <title>Example Docs</title>
          <meta name="description" content="Short page summary." />
        </head>
        <body>
          <nav><a href="/home">Home</a></nav>
          <main>
            <h1>Install Guide</h1>
            <h2>Quickstart</h2>
            <p>Helpful article body.</p>
          </main>
          <footer>Footer links</footer>
        </body>
      </html>`);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  try {
    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_1",
          name: "fetch_webpage",
          arguments: JSON.stringify({
            url: `http://${address.address}:${address.port}/page`,
          }),
        },
        "default",
      ),
    );

    assert.equal(result.ok, true);
    assert.equal(result.mode, "outline");
    assert.equal(result.extraction, "html-outline");
    assert.equal(result.title, "Example Docs");
    assert.equal(result.description, "Short page summary.");
    assert.deepEqual(result.headings, [
      { level: 1, text: "Install Guide" },
      { level: 2, text: "Quickstart" },
    ]);
    assert.match(String(result.content), /Title: Example Docs/);
    assert.match(String(result.content), /# Install Guide/);
    assert.doesNotMatch(String(result.content), /Footer links/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("fetch_webpage article mode prefers the configured reader template", async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/reader") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("# Clean Article\n\nReader-first content without page chrome.");
      return;
    }

    if (url.pathname === "/page") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
          <body>
            <nav>Top nav</nav>
            <main><p>Fallback article body.</p></main>
          </body>
        </html>`);
      return;
    }

    res.writeHead(404).end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const previousTemplate = process.env.SUPERRUN_WEB_READER_URL_TEMPLATE;
  process.env.SUPERRUN_WEB_READER_URL_TEMPLATE =
    `http://${address.address}:${address.port}/reader?target={url}`;

  try {
    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_1",
          name: "fetch_webpage",
          arguments: JSON.stringify({
            url: `http://${address.address}:${address.port}/page`,
            mode: "article",
          }),
        },
        "default",
      ),
    );

    assert.equal(result.ok, true);
    assert.equal(result.mode, "article");
    assert.equal(result.extraction, "reader");
    assert.equal(result.title, "Clean Article");
    assert.match(String(result.content), /Reader-first content/);
    assert.doesNotMatch(String(result.content), /Fallback article body/);
  } finally {
    if (previousTemplate === undefined) {
      delete process.env.SUPERRUN_WEB_READER_URL_TEMPLATE;
    } else {
      process.env.SUPERRUN_WEB_READER_URL_TEMPLATE = previousTemplate;
    }

    server.close();
    await once(server, "close");
  }
});
