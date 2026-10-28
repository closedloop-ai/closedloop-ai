import assert from "node:assert/strict";
import { test } from "vitest";
import {
  mapStatuslineRateLimits,
  mapStatuslineSnapshotFile,
} from "../src/main/session-limits/mappers.js";

// 2026-07-21T15:00:00Z as epoch seconds, used across the reset assertions.
const RESET_EPOCH_SECONDS = 1_784_646_000;
const RESET_ISO = "2026-07-21T15:00:00.000Z";

test("mapStatuslineRateLimits: RICH windows pass 0–100 through, epoch→ISO", () => {
  const snapshot = mapStatuslineRateLimits(
    {
      five_hour: { used_percentage: 42, resets_at: RESET_EPOCH_SECONDS },
      seven_day: { used_percentage: 70, resets_at: null },
      seven_day_sonnet: { used_percentage: 55, resets_at: RESET_EPOCH_SECONDS },
    },
    "2026-07-19T12:00:00.000Z"
  );
  assert.equal(snapshot.fiveHour?.utilization, 42);
  assert.equal(snapshot.fiveHour?.resetsAt, RESET_ISO);
  // Absent reset → null; absent window → null.
  assert.equal(snapshot.sevenDay?.resetsAt, null);
  assert.equal(snapshot.sevenDayOpus, null);
  assert.equal(snapshot.sevenDaySonnet?.utilization, 55);
  assert.equal(snapshot.extraUsage, null);
  assert.equal(snapshot.fetchedAt, "2026-07-19T12:00:00.000Z");
});

test("mapStatuslineRateLimits: clamps out-of-range percentages", () => {
  const snapshot = mapStatuslineRateLimits(
    {
      five_hour: { used_percentage: 140, resets_at: RESET_EPOCH_SECONDS },
      seven_day: { used_percentage: -5, resets_at: RESET_EPOCH_SECONDS },
    },
    "t"
  );
  assert.equal(snapshot.fiveHour?.utilization, 100);
  assert.equal(snapshot.sevenDay?.utilization, 0);
});

test("mapStatuslineRateLimits: maps the observed primary/secondary shape", () => {
  // The shape the harness records today: primary (shortest window) → fiveHour,
  // secondary (longer window) → sevenDay, percentage field is `used_percent`.
  const snapshot = mapStatuslineRateLimits(
    {
      primary: {
        used_percent: 4,
        window_minutes: 300,
        resets_at: RESET_EPOCH_SECONDS,
      },
      secondary: { used_percent: 1, window_minutes: 10_080, resets_at: null },
    },
    "t"
  );
  assert.equal(snapshot.fiveHour?.utilization, 4);
  assert.equal(snapshot.fiveHour?.resetsAt, RESET_ISO);
  assert.equal(snapshot.sevenDay?.utilization, 1);
  assert.equal(snapshot.sevenDay?.resetsAt, null);
});

test("mapStatuslineRateLimits: explicit per-window keys win over primary/secondary", () => {
  const snapshot = mapStatuslineRateLimits(
    {
      five_hour: { used_percentage: 42, resets_at: RESET_EPOCH_SECONDS },
      primary: { used_percent: 4, resets_at: RESET_EPOCH_SECONDS },
    },
    "t"
  );
  // Keyed layout takes precedence; the positional pair never double-maps.
  assert.equal(snapshot.fiveHour?.utilization, 42);
});

test("mapStatuslineRateLimits: tolerates empty/absent payload", () => {
  const snapshot = mapStatuslineRateLimits(undefined, "t");
  assert.equal(snapshot.fiveHour, null);
  assert.equal(snapshot.extraUsage, null);
  assert.equal(snapshot.fetchedAt, "t");
});

test("mapStatuslineSnapshotFile: an unparseable file fetchedAt falls back to the caller-supplied one", () => {
  const snapshot = mapStatuslineSnapshotFile(
    {
      fiveHour: { utilization: 30, resetsAt: null },
      // Non-empty but not a valid date — must NOT be preferred.
      fetchedAt: "not-a-date",
    },
    "2026-07-19T09:00:00.000Z"
  );
  assert.equal(snapshot.fetchedAt, "2026-07-19T09:00:00.000Z");
});

test("mapStatuslineSnapshotFile: maps the on-disk camelCase file shape, prefers file fetchedAt", () => {
  const snapshot = mapStatuslineSnapshotFile(
    {
      fiveHour: { utilization: 42, resetsAt: RESET_ISO },
      sevenDay: { utilization: 7, resetsAt: null },
      totalCostUsd: 12.5,
      fetchedAt: "2026-07-19T09:00:00.000Z",
    },
    "fallback-ts"
  );
  assert.equal(snapshot.fiveHour?.utilization, 42);
  assert.equal(snapshot.fiveHour?.resetsAt, RESET_ISO);
  assert.equal(snapshot.sevenDay?.utilization, 7);
  assert.equal(snapshot.sevenDay?.resetsAt, null);
  assert.equal(snapshot.sevenDayOpus, null);
  // The file's own fetchedAt wins over the caller fallback.
  assert.equal(snapshot.fetchedAt, "2026-07-19T09:00:00.000Z");
});

test("mapStatuslineSnapshotFile: clamps percentages; falls back to caller fetchedAt", () => {
  const snapshot = mapStatuslineSnapshotFile(
    { fiveHour: { utilization: 140, resetsAt: RESET_ISO } },
    "fallback-ts"
  );
  assert.equal(snapshot.fiveHour?.utilization, 100);
  // No valid file fetchedAt → caller's fallback is used.
  assert.equal(snapshot.fetchedAt, "fallback-ts");
});

test("mapStatuslineSnapshotFile: tolerates non-object / empty payloads", () => {
  const snapshot = mapStatuslineSnapshotFile(null, "t");
  assert.equal(snapshot.fiveHour, null);
  assert.equal(snapshot.sevenDay, null);
  assert.equal(snapshot.fetchedAt, "t");
});
