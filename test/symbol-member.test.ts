import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  listFileSymbols,
  getSymbolSource,
  getSymbolMemberSource,
  resolveSymbolMemberRange,
  collectSymbolMembers,
  LARGE_SYMBOL_THRESHOLD,
} from "../src/tools/symbol-resolve.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fabricate an absolute path so ts-morph is happy. */
function absPath(name: string): string {
  return path.resolve("/tmp/test-symbols", name);
}

// ---------------------------------------------------------------------------
// collectSymbolMembers — class members
// ---------------------------------------------------------------------------

test("listFileSymbols returns class members for a class declaration", () => {
  const content = `
export class Greeter {
  name: string;
  greet() { return "hello"; }
  get upper() { return this.name.toUpperCase(); }
  set upper(v: string) { this.name = v.toLowerCase(); }
}
`.trim();

  const symbols = listFileSymbols(absPath("greeter.ts"), content);
  assert.equal(symbols.length, 1);
  const cls = symbols[0]!;
  assert.equal(cls.name, "Greeter");
  assert.ok(cls.members);
  assert.equal(cls.members!.length, 4);

  const names = cls.members!.map((m) => m.name);
  assert.deepEqual(names, ["name", "greet", "upper", "upper"]);

  const kinds = cls.members!.map((m) => m.kind);
  assert.deepEqual(kinds, ["property", "method", "getter", "setter"]);
});

// ---------------------------------------------------------------------------
// collectSymbolMembers — nested functions in a function
// ---------------------------------------------------------------------------

test("listFileSymbols returns nested function members for a function declaration", () => {
  const content = `
export function outer() {
  function helperA() { return 1; }
  function helperB() { return 2; }
  return helperA() + helperB();
}
`.trim();

  const symbols = listFileSymbols(absPath("outer.ts"), content);
  assert.equal(symbols.length, 1);
  const fn = symbols[0]!;
  assert.equal(fn.name, "outer");
  assert.ok(fn.members);
  assert.equal(fn.members!.length, 2);
  assert.deepEqual(fn.members!.map((m) => m.name), ["helperA", "helperB"]);
  assert.deepEqual(fn.members!.map((m) => m.kind), ["function", "function"]);
});

// ---------------------------------------------------------------------------
// collectSymbolMembers — arrow function with nested functions
// ---------------------------------------------------------------------------

test("listFileSymbols returns nested function members for an arrow function variable", () => {
  const content = `
export const handler = () => {
  function doA() { return "a"; }
  function doB() { return "b"; }
  return doA() + doB();
};
`.trim();

  const symbols = listFileSymbols(absPath("handler.ts"), content);
  assert.equal(symbols.length, 1);
  const v = symbols[0]!;
  assert.equal(v.name, "handler");
  assert.ok(v.members);
  assert.equal(v.members!.length, 2);
  assert.deepEqual(v.members!.map((m) => m.name), ["doA", "doB"]);
});

// ---------------------------------------------------------------------------
// collectSymbolMembers — no members
// ---------------------------------------------------------------------------

test("listFileSymbols omits members for a simple function", () => {
  const content = `
export function add(a: number, b: number) {
  return a + b;
}
`.trim();

  const symbols = listFileSymbols(absPath("add.ts"), content);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0]!.members, undefined);
});

// ---------------------------------------------------------------------------
// lineCount
// ---------------------------------------------------------------------------

test("listFileSymbols populates lineCount", () => {
  const content = `
export function multi() {
  const a = 1;
  const b = 2;
  const c = 3;
  return a + b + c;
}
`.trim();

  const symbols = listFileSymbols(absPath("multi.ts"), content);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0]!.lineCount, 6);
});

// ---------------------------------------------------------------------------
// getSymbolSource — truncation for large symbols
// ---------------------------------------------------------------------------

test("getSymbolSource truncates large symbols and includes member summary", () => {
  // Build a class with enough lines to exceed LARGE_SYMBOL_THRESHOLD.
  const methodLines: string[] = [];
  for (let i = 0; i < LARGE_SYMBOL_THRESHOLD + 50; i++) {
    methodLines.push(`  line${i}() { return ${i}; }`);
  }
  const content = `export class BigClass {\n${methodLines.join("\n")}\n}`;
  const fp = absPath("big.ts");

  const result = getSymbolSource(fp, content, "BigClass");
  assert.ok(result);
  assert.equal(result.truncated, true);
  assert.ok(result.source.includes("lines truncated"));
  assert.ok(result.source.includes("Named members"));
  assert.ok(result.members);
  assert.ok(result.members!.length > 0);
});

test("getSymbolSource returns full source with full=true even for large symbols", () => {
  const methodLines: string[] = [];
  for (let i = 0; i < LARGE_SYMBOL_THRESHOLD + 10; i++) {
    methodLines.push(`  m${i}() { return ${i}; }`);
  }
  const content = `export class Big {\n${methodLines.join("\n")}\n}`;
  const fp = absPath("big2.ts");

  const result = getSymbolSource(fp, content, "Big", { full: true });
  assert.ok(result);
  assert.equal(result.truncated, undefined);
  assert.ok(!result.source.includes("lines truncated"));
});

// ---------------------------------------------------------------------------
// getSymbolSource — member parameter
// ---------------------------------------------------------------------------

test("getSymbolSource with member parameter returns only that member", () => {
  const content = `
export class Svc {
  init() { console.log("init"); }
  run() { console.log("run"); }
}
`.trim();
  const fp = absPath("svc.ts");

  const result = getSymbolSource(fp, content, "Svc", { memberName: "run" });
  assert.ok(result);
  assert.ok(result.source.includes("run"));
  assert.ok(!result.source.includes("init"));
});

test("getSymbolSource with nonexistent member returns null", () => {
  const content = `
export class Svc {
  init() { console.log("init"); }
}
`.trim();
  const fp = absPath("svc2.ts");

  const result = getSymbolSource(fp, content, "Svc", { memberName: "missing" });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// getSymbolMemberSource
// ---------------------------------------------------------------------------

test("getSymbolMemberSource returns source of a class method", () => {
  const content = `
export class Api {
  fetch() {
    return "data";
  }
  save() {
    return "ok";
  }
}
`.trim();
  const fp = absPath("api.ts");

  const result = getSymbolMemberSource(fp, content, "Api", "save");
  assert.ok(result);
  assert.equal(result.memberName, "save");
  assert.equal(result.symbolName, "Api");
  assert.ok(result.source.includes("save"));
  assert.ok(!result.source.includes("fetch"));
  assert.ok(result.bodyHash);
});

test("getSymbolMemberSource returns null for missing member", () => {
  const content = `export class X { a() {} }`;
  const fp = absPath("x.ts");
  const result = getSymbolMemberSource(fp, content, "X", "b");
  assert.equal(result, null);
});

test("getSymbolMemberSource returns null for missing symbol", () => {
  const content = `export class X { a() {} }`;
  const fp = absPath("y.ts");
  const result = getSymbolMemberSource(fp, content, "Y", "a");
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// resolveSymbolMemberRange
// ---------------------------------------------------------------------------

test("resolveSymbolMemberRange returns correct range and hash for a class method", () => {
  const content = `
export class Ctrl {
  handle() {
    return 42;
  }
  other() {
    return 0;
  }
}
`.trim();
  const fp = absPath("ctrl.ts");

  const range = resolveSymbolMemberRange(fp, content, "Ctrl", "handle");
  assert.ok(range);
  assert.equal(range.memberName, "handle");
  assert.equal(range.symbolName, "Ctrl");
  assert.ok(range.startLine > 0);
  assert.ok(range.endLine >= range.startLine);
  assert.ok(range.bodyHash);

  // Verify hash matches the member source.
  const src = getSymbolMemberSource(fp, content, "Ctrl", "handle");
  assert.ok(src);
  assert.equal(range.bodyHash, src.bodyHash);
});

test("resolveSymbolMemberRange returns null for missing member", () => {
  const content = `export class C { a() {} }`;
  const fp = absPath("c.ts");
  const result = resolveSymbolMemberRange(fp, content, "C", "z");
  assert.equal(result, null);
});
