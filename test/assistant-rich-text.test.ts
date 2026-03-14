import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnsiRichTextStreamWriter,
  formatRichTextToAnsi,
  highlightAssistantCode,
  parseAssistantRichText,
  parseInlineSegments,
} from "../src/ui/assistant-rich-text.js";

test("parseInlineSegments detects bold and inline code spans", () => {
  assert.deepEqual(
    parseInlineSegments("Use **bold** and `code`."),
    [
      { kind: "text", text: "Use " },
      { kind: "bold", text: "bold" },
      { kind: "text", text: " and " },
      { kind: "code", text: "code" },
      { kind: "text", text: "." },
    ],
  );
});

test("parseInlineSegments leaves unmatched markdown markers as plain text", () => {
  assert.deepEqual(
    parseInlineSegments("Keep **unfinished and `open markers"),
    [
      {
        kind: "text",
        text: "Keep **unfinished and `open markers",
      },
    ],
  );
});

test("parseAssistantRichText extracts fenced code blocks and surrounding paragraphs", () => {
  assert.deepEqual(
    parseAssistantRichText("Before\n```ts\nconst answer = 42;\n```\nAfter"),
    [
      {
        kind: "paragraph",
        segments: [{ kind: "text", text: "Before" }],
      },
      {
        kind: "code_block",
        language: "ts",
        code: "const answer = 42;",
      },
      {
        kind: "paragraph",
        segments: [{ kind: "text", text: "After" }],
      },
    ],
  );
});

test("parseAssistantRichText keeps an unfinished fenced block during streaming", () => {
  assert.deepEqual(
    parseAssistantRichText("```js\nconsole.log('hi');"),
    [
      {
        kind: "code_block",
        language: "js",
        code: "console.log('hi');",
      },
    ],
  );
});

test("highlightAssistantCode preserves code content even when terminal coloring is unavailable", () => {
  const highlighted = highlightAssistantCode("const answer = 42;", "ts");

  assert.match(highlighted, /const/);
  assert.match(highlighted, /answer/);
});

test("formatRichTextToAnsi removes markdown markers while preserving content", () => {
  const rendered = formatRichTextToAnsi("Use **bold** and `code`.");

  assert.match(rendered, /Use /);
  assert.match(rendered, /bold/);
  assert.match(rendered, /code/);
  assert.doesNotMatch(rendered, /\*\*/);
});

test("createAnsiRichTextStreamWriter formats fenced blocks across streamed chunks", () => {
  let output = "";
  const writer = createAnsiRichTextStreamWriter((chunk) => {
    output += chunk;
  });

  writer.writeChunk("Before\n```ts\nconst ");
  writer.writeChunk("answer = 42;\n```\nAfter");
  writer.end();

  assert.match(output, /Before/);
  assert.match(output, /const/);
  assert.match(output, /answer/);
  assert.match(output, /After/);
  assert.doesNotMatch(output, /```ts\nconst answer = 42;\n```/);
});
