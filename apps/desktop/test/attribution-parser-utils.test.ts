/**
 * @file attribution-parser-utils.test.ts
 * @description toIso / parser-utils edge cases (FEA-1459).
 * Split out of the former fea1459-attribution-accuracy.test.ts (FEA-2235 D2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toIso } from "../src/main/collectors/parsing/parser-utils.js";

// ═══════════════════════════════════════════════════════════════════════════
// AREA 7: toIso / parser-utils edge cases
// ═══════════════════════════════════════════════════════════════════════════

test("toIso: epoch seconds (< 1e12) treated as seconds", () => {
  const result = toIso(1_710_000_000);
  assert.equal(result, "2024-03-09T16:00:00.000Z");
});

test("toIso: epoch milliseconds (>= 1e12) treated as milliseconds", () => {
  const result = toIso(1_710_000_000_000);
  assert.equal(result, "2024-03-09T16:00:00.000Z");
});

test("toIso: ISO string with Z suffix passed through", () => {
  const result = toIso("2026-06-07T10:00:00.000Z");
  assert.equal(result, "2026-06-07T10:00:00.000Z");
});

test("toIso: ISO string with offset parsed to UTC", () => {
  const result = toIso("2026-06-07T15:00:00.000+05:00");
  assert.equal(result, "2026-06-07T10:00:00.000Z");
});

test("toIso: garbage string returned as-is (invalid date)", () => {
  const result = toIso("not-a-date");
  assert.equal(result, "not-a-date");
});

test("toIso: null returns null", () => {
  assert.equal(toIso(null), null);
});

test("toIso: undefined returns null", () => {
  assert.equal(toIso(undefined), null);
});
