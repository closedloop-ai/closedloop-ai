/**
 * @file db-helpers-local-day.test.ts
 * @description Unit tests for the LOCAL-day helpers in db-helpers.ts
 * (`formatLocalDayKey` / `localCutoffDay`, FEA-2430 / FEA-3006). These format a
 * JS Date into the same yyyy-MM-dd key the `localDay()` SQL bucket emits, so the
 * JS and SQL sides of every desktop Insights chart stay in lockstep. Pin a
 * non-UTC timezone so the local-vs-UTC day boundary is exercised deterministically
 * (mirrors component-model-analytics.test.ts / attribution-day-bucketing.test.ts),
 * and restore the caller's TZ afterward per AGENTS.md Test Practices.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  formatLocalDayKey,
  localCutoffDay,
} from "../src/main/database/db-helpers.js";

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Chicago";
after(() => {
  if (ORIGINAL_TZ === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

test("formatLocalDayKey formats the Date's LOCAL calendar day", () => {
  // 04:30 UTC on Mar 10 is 23:30 the PREVIOUS local day (CDT, UTC-5) — a
  // UTC-based formatter would drift a day forward here.
  assert.equal(
    formatLocalDayKey(new Date("2026-03-10T04:30:00.000Z")),
    "2026-03-09"
  );
  // Zero-pads month and day.
  assert.equal(
    formatLocalDayKey(new Date("2026-01-05T18:00:00.000Z")),
    "2026-01-05"
  );
});

test("localCutoffDay returns the inclusive LOCAL cutoff for the window", () => {
  const now = new Date("2026-06-15T12:00:00.000Z"); // 07:00 local (CDT)
  // windowDays=1 is just today's local day.
  assert.equal(localCutoffDay(1, now), "2026-06-15");
  // windowDays=7 reaches back 6 local days (today inclusive).
  assert.equal(localCutoffDay(7, now), "2026-06-09");
});

test("localCutoffDay buckets by LOCAL day across a UTC boundary", () => {
  // 02:00 UTC on Jul 1 is 21:00 Jun 30 local — the window's "today" is Jun 30.
  const now = new Date("2026-07-01T02:00:00.000Z");
  assert.equal(localCutoffDay(1, now), "2026-06-30");
});

test("localCutoffDay does not mutate the injected now", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");
  const before = now.getTime();
  localCutoffDay(30, now);
  assert.equal(now.getTime(), before);
});
