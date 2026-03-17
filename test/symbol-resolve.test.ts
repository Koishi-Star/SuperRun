import assert from "node:assert/strict";
import test from "node:test";
import {
  listFileSymbols,
  getSymbolSource,
  resolveSymbolRange,
  computeBodyHash,
  isSupportedSourceFile,
  hasParseErrors,
} from "../src/tools/symbol-resolve.js";

// ---------------------------------------------------------------------------
// isSupportedSourceFile
// ---------------------------------------------------------------------------

test("isSupportedSourceFile accepts TS/JS extensions", () => {
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
    assert.equal(isSupportedSourceFile(`/tmp/file${ext}`), true, `Expected true for ${ext}`);
  }
});

test("isSupportedSourceFile rejects non-TS/JS extensions", () => {
  for (const ext of [".py", ".rs", ".json", ".md", ""]) {
    const path = ext ? `/tmp/file${ext}` : "/tmp/noext";
    assert.equal(isSupportedSourceFile(path), false, `Expected false for ${path}`);
  }
});

// ---------------------------------------------------------------------------
// computeBodyHash
// ---------------------------------------------------------------------------

test("computeBodyHash returns 8-char hex string", () => {
  const hash = computeBodyHash("export function hello() {}");
  assert.match(hash, /^[0-9a-f]{8}$/);
});

test("computeBodyHash is deterministic", () => {
  const a = computeBodyHash("const x = 1;");
  const b = computeBodyHash("const x = 1;");
  assert.equal(a, b);
});

test("computeBodyHash differs for different inputs", () => {
  const a = computeBodyHash("const x = 1;");
  const b = computeBodyHash("const x = 2;");
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// listFileSymbols
// ---------------------------------------------------------------------------

const SAMPLE_TS = `
import { foo } from "./foo.js";

export function greet(name: string): string {
  return "Hello, " + name;
}

export class Widget {
  render() {}
}

export interface Config {
  debug: boolean;
}

export type ID = string | number;

export enum Color {
  Red,
  Green,
  Blue,
}

export const MAX_SIZE = 100;
`.trimStart();

test("listFileSymbols extracts all top-level symbol kinds", () => {
  const symbols = listFileSymbols("/tmp/sample.ts", SAMPLE_TS);
  const names = symbols.map((s) => s.name);

  assert.ok(names.includes("greet"), "should include function greet");
  assert.ok(names.includes("Widget"), "should include class Widget");
  assert.ok(names.includes("Config"), "should include interface Config");
  assert.ok(names.includes("ID"), "should include type ID");
  assert.ok(names.includes("Color"), "should include enum Color");
  assert.ok(names.includes("MAX_SIZE"), "should include variable MAX_SIZE");
});

test("listFileSymbols returns correct SymbolKind values", () => {
  const symbols = listFileSymbols("/tmp/sample.ts", SAMPLE_TS);
  const byName = Object.fromEntries(symbols.map((s) => [s.name, s]));

  assert.equal(byName["greet"]?.kind, "function");
  assert.equal(byName["Widget"]?.kind, "class");
  assert.equal(byName["Config"]?.kind, "interface");
  assert.equal(byName["ID"]?.kind, "type");
  assert.equal(byName["Color"]?.kind, "enum");
  assert.equal(byName["MAX_SIZE"]?.kind, "variable");
});

test("listFileSymbols returns non-overlapping line ranges", () => {
  const symbols = listFileSymbols("/tmp/sample.ts", SAMPLE_TS);
  for (const s of symbols) {
    assert.ok(s.startLine <= s.endLine, `${s.name}: startLine <= endLine`);
    assert.ok(s.startLine >= 1, `${s.name}: startLine >= 1`);
  }
});

test("listFileSymbols returns empty array for non-TS file", () => {
  const result = listFileSymbols("/tmp/readme.md", "# Hello");
  assert.deepEqual(result, []);
});

test("listFileSymbols includes bodyHash for each symbol", () => {
  const symbols = listFileSymbols("/tmp/sample.ts", SAMPLE_TS);
  for (const s of symbols) {
    assert.match(s.bodyHash, /^[0-9a-f]{8}$/, `${s.name}: hash should be 8-char hex`);
  }
});

// ---------------------------------------------------------------------------
// getSymbolSource
// ---------------------------------------------------------------------------

test("getSymbolSource returns source and imports for an existing symbol", () => {
  const result = getSymbolSource("/tmp/sample.ts", SAMPLE_TS, "greet");
  assert.ok(result, "should find greet");
  assert.equal(result.name, "greet");
  assert.equal(result.kind, "function");
  assert.ok(result.source.includes("function greet"), "source should have function body");
  assert.ok(result.imports.length >= 1, "should include imports");
  assert.ok(result.imports[0]?.includes("foo"), "first import should reference foo");
  assert.match(result.bodyHash, /^[0-9a-f]{8}$/);
});

test("getSymbolSource returns null for a missing symbol", () => {
  const result = getSymbolSource("/tmp/sample.ts", SAMPLE_TS, "nonexistent");
  assert.equal(result, null);
});

test("getSymbolSource returns null for unsupported file type", () => {
  const result = getSymbolSource("/tmp/readme.md", "# Hello", "greet");
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// resolveSymbolRange
// ---------------------------------------------------------------------------

test("resolveSymbolRange returns range + hash for existing symbol", () => {
  const result = resolveSymbolRange("/tmp/sample.ts", SAMPLE_TS, "Widget");
  assert.ok(result, "should find Widget");
  assert.equal(result.name, "Widget");
  assert.equal(result.kind, "class");
  assert.ok(result.startLine >= 1);
  assert.ok(result.endLine >= result.startLine);
  assert.match(result.bodyHash, /^[0-9a-f]{8}$/);
});

test("resolveSymbolRange returns null for missing symbol", () => {
  const result = resolveSymbolRange("/tmp/sample.ts", SAMPLE_TS, "missing");
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// hasParseErrors
// ---------------------------------------------------------------------------

test("hasParseErrors returns false for valid source", () => {
  assert.equal(hasParseErrors("/tmp/valid.ts", "export const x = 1;"), false);
});

test("hasParseErrors returns false for unsupported file", () => {
  assert.equal(hasParseErrors("/tmp/readme.md", "not {{{ valid js"), false);
});

// ---------------------------------------------------------------------------
// Multi-declarator variable statements
// ---------------------------------------------------------------------------

test("listFileSymbols handles multi-declarator const export", () => {
  const content = `export const A = 1, B = 2;\n`;
  const symbols = listFileSymbols("/tmp/multi.ts", content);
  const names = symbols.map((s) => s.name);
  assert.ok(names.includes("A"), "should include A");
  assert.ok(names.includes("B"), "should include B");
});
