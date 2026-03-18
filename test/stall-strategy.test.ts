import assert from "node:assert/strict";
import test from "node:test";
import { buildStallStrategyHint } from "../src/agent/loop.js";

// ---------------------------------------------------------------------------
// No recent calls — returns null
// ---------------------------------------------------------------------------

test("buildStallStrategyHint returns null when no recent calls", () => {
  assert.equal(buildStallStrategyHint([], 1), null);
});

test("buildStallStrategyHint returns null when stalled rounds are empty", () => {
  assert.equal(buildStallStrategyHint([[], []], 2), null);
});

// ---------------------------------------------------------------------------
// Repeated get_symbol_source → member drill hint
// ---------------------------------------------------------------------------

test("buildStallStrategyHint detects repeated get_symbol_source", () => {
  const recent: string[][] = [
    ["get_symbol_source"],
    ["get_symbol_source"],
  ];
  const hint = buildStallStrategyHint(recent, 2);
  assert.ok(hint);
  assert.ok(hint.includes("member"));
  assert.ok(hint.includes("get_symbol_source") || hint.includes("large symbol"));
});

// ---------------------------------------------------------------------------
// Repeated search_workspace → narrow search hint
// ---------------------------------------------------------------------------

test("buildStallStrategyHint detects repeated search_workspace", () => {
  const recent: string[][] = [
    ["search_workspace"],
    ["search_workspace"],
  ];
  const hint = buildStallStrategyHint(recent, 2);
  assert.ok(hint);
  assert.ok(hint.includes("search") || hint.includes("narrow"));
});

// ---------------------------------------------------------------------------
// Repeated read_file → proceed to edit hint
// ---------------------------------------------------------------------------

test("buildStallStrategyHint detects repeated read_file", () => {
  const recent: string[][] = [
    ["read_file"],
    ["read_file"],
    ["read_file"],
  ];
  const hint = buildStallStrategyHint(recent, 3);
  assert.ok(hint);
  assert.ok(hint.includes("re-reading") || hint.includes("proceed"));
});

// ---------------------------------------------------------------------------
// Mixed calls below threshold — returns null
// ---------------------------------------------------------------------------

test("buildStallStrategyHint returns null for diverse tool calls", () => {
  const recent: string[][] = [
    ["get_symbols", "read_file"],
    ["search_workspace", "write_file"],
  ];
  const hint = buildStallStrategyHint(recent, 2);
  assert.equal(hint, null);
});

// ---------------------------------------------------------------------------
// Only considers stalled rounds slice
// ---------------------------------------------------------------------------

test("buildStallStrategyHint only looks at the last N stalled rounds", () => {
  // 5 rounds total but only last 2 are stalled.
  const recent: string[][] = [
    ["get_symbol_source"],
    ["get_symbol_source"],
    ["get_symbol_source"],
    ["read_file"],
    ["write_file"],
  ];
  // stalledRounds=2 → only the last 2 rounds (read_file, write_file).
  const hint = buildStallStrategyHint(recent, 2);
  assert.equal(hint, null);
});
