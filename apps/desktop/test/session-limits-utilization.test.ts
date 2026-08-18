import assert from "node:assert/strict";
import { test } from "node:test";
import { mapUtilizationResponse } from "../src/main/session-limits/utilization.js";

test("mapUtilizationResponse: maps snake_case windows + extra_usage credits", () => {
  const snapshot = mapUtilizationResponse(
    {
      five_hour: { utilization: 42, resets_at: "2026-07-19T15:00:00.000Z" },
      seven_day: { utilization: 70, resets_at: "2026-07-21T12:00:00.000Z" },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 55, resets_at: null },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 2000,
        used_credits: 350,
        utilization: 17.5,
      },
    },
    "2026-07-19T12:00:00.000Z"
  );
  assert.equal(snapshot.fiveHour?.utilization, 42);
  assert.equal(snapshot.fiveHour?.resetsAt, "2026-07-19T15:00:00.000Z");
  assert.equal(snapshot.sevenDayOpus, null);
  assert.equal(snapshot.sevenDaySonnet?.resetsAt, null);
  // Credits are cents in the payload → dollars in the snapshot.
  assert.equal(snapshot.extraUsage?.monthlyLimitUsd, 20);
  assert.equal(snapshot.extraUsage?.usedCreditsUsd, 3.5);
  assert.equal(snapshot.fetchedAt, "2026-07-19T12:00:00.000Z");
});

test("mapUtilizationResponse: tolerates empty/absent payload", () => {
  const snapshot = mapUtilizationResponse({}, "t");
  assert.equal(snapshot.fiveHour, null);
  assert.equal(snapshot.extraUsage, null);
});

test("mapUtilizationResponse: normalizes an epoch-seconds resets_at to ISO", () => {
  // The endpoint expresses `resets_at` as epoch SECONDS on some windows; the
  // renderer contract is ISO-8601, so the mapper must convert rather than drop.
  const snapshot = mapUtilizationResponse(
    { seven_day: { utilization: 12, resets_at: 1_785_849_600 } },
    "t"
  );
  assert.equal(
    snapshot.sevenDay?.resetsAt,
    new Date(1_785_849_600 * 1000).toISOString()
  );
});

test("mapUtilizationResponse: a genuine 0% is kept, an absent window is null", () => {
  const snapshot = mapUtilizationResponse(
    { five_hour: { utilization: 0, resets_at: null }, seven_day: null },
    "t"
  );
  assert.equal(snapshot.fiveHour?.utilization, 0);
  assert.equal(snapshot.sevenDay, null);
});
