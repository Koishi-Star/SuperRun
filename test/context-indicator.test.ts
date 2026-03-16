import assert from "node:assert/strict";
import test from "node:test";
import { buildContextIndicatorDisplay } from "../src/ui/context-indicator.js";

test("buildContextIndicatorDisplay stays muted at low usage", () => {
  const display = buildContextIndicatorDisplay(5_900, 262_100);

  assert.equal(display.usageText, "5.9k/262.1k");
  assert.equal(display.percentText, "2.3%");
  assert.equal(display.tone, "muted");
  assert.equal(display.isNearFull, false);
});

test("buildContextIndicatorDisplay warns at mid and high usage thresholds", () => {
  const notice = buildContextIndicatorDisplay(140_000, 262_100);
  const warning = buildContextIndicatorDisplay(210_000, 262_100);

  assert.equal(notice.tone, "notice");
  assert.equal(notice.percentText, "53.4%");
  assert.equal(warning.tone, "warning");
  assert.equal(warning.percentText, "80.1%");
});

test("buildContextIndicatorDisplay marks near-full context as critical", () => {
  const display = buildContextIndicatorDisplay(245_000, 262_100);

  assert.equal(display.tone, "critical");
  assert.equal(display.percentText, "93.5%");
  assert.equal(display.isNearFull, true);
});
