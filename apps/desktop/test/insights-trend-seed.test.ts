/**
 * @file insights-trend-seed.test.ts
 * @description ISS-6268. The e2e dashboard chart specs seed through
 * `insightsTrendSeedAt`, and the property that matters is the one their old
 * literal date lost silently: the seed must land inside the ROLLING
 * `TREND_LOOKBACK_DAYS` window that `resolveRange` computes, on ANY run day.
 *
 * Asserted against `resolveRange` itself rather than against a re-derived
 * boundary — re-deriving the window here would reproduce the original bug's
 * shape, where the test's idea of "in range" and the app's had drifted apart.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { InsightsPeriod } from "@closedloop-ai/loops-api/insights";
import { resolveRange } from "../src/main/database/local-insights-range.js";
import { insightsTrendSeedAt } from "./e2e/helpers/insights-trend-seed.js";

/** Run days far enough apart to catch a seed pinned to any one of them. */
const RUN_DAYS = [
  new Date("2026-05-15T12:00:00.000Z"),
  new Date("2026-08-13T09:00:00.000Z"),
  new Date("2027-01-01T23:59:59.000Z"),
  new Date("2031-06-30T00:00:00.000Z"),
];

test("the seed lands inside the trend window on every run day", () => {
  for (const now of RUN_DAYS) {
    const seed = insightsTrendSeedAt(now);
    // "All time" is the range both specs select, and the one whose trend window
    // is capped despite the name — the exact case the literal seed assumed away.
    const range = resolveRange(InsightsPeriod.All, now);

    assert.ok(
      seed.toISOString() >= range.trendStartIso,
      `seed ${seed.toISOString()} fell before trendStart ${range.trendStartIso} for run day ${now.toISOString()}`
    );
    assert.ok(
      seed.toISOString() <= range.endIso,
      `seed ${seed.toISOString()} is in the future for run day ${now.toISOString()}`
    );
  }
});

test("the seed is strictly in the past, so it can never race the run clock", () => {
  for (const now of RUN_DAYS) {
    assert.ok(
      insightsTrendSeedAt(now).getTime() < now.getTime(),
      `seed must precede ${now.toISOString()}`
    );
  }
});

test("the replacement seeds in range on the day the literal one aged out", () => {
  // The regression, pinned to the hour. The retired constant was
  // 2026-05-15T12:00Z and the window is exactly 90 days, so it left range at
  // 2026-08-13T12:00Z — NOT at midnight. Runs earlier that morning still passed;
  // the first red one (31716263158) started 15:35Z, which is why this uses an
  // afternoon instant. A midnight `now` here would assert the opposite.
  const retiredLiteral = new Date("2026-05-15T12:00:00.000Z");
  const now = new Date("2026-08-13T15:35:00.000Z");
  const range = resolveRange(InsightsPeriod.All, now);

  assert.ok(
    retiredLiteral.toISOString() < range.trendStartIso,
    "the retired literal seed should be OUT of range on the day the suite went red"
  );
  assert.ok(
    insightsTrendSeedAt(now).toISOString() >= range.trendStartIso,
    "the replacement seed must be in range on that same day"
  );
});
