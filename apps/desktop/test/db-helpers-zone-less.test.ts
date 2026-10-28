/**
 * @file db-helpers-zone-less.test.ts
 * @description ISS-5496 / ISS-8398 — `readZoneLessAsUtc`, the store's one
 * "a zone-less date-time means UTC" rule.
 *
 * It has two callers that must never disagree — `canonicalizeStoredTimestamp`
 * (the ISS-5496 heal) and `toLegacyAgentInstant` (the ISS-8398 legacy Agent
 * bucket arm) — and they differ deliberately in what they do with an
 * unparseable result. This suite pins the rule itself, so neither caller's
 * suite is where a change to it first shows up.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { readZoneLessAsUtc } from "../src/main/database/db-helpers.js";

test("ISS-5496: a zone-less date-time gains the zone its text omits", () => {
  for (const value of [
    "2026-06-22T10:00:00",
    "2026-06-22T10:00",
    "2026-06-22T10:00:00.5",
    "2026-06-22T10:00:00.123",
  ]) {
    assert.equal(readZoneLessAsUtc(value), `${value}Z`);
  }
});

test("ISS-5496: a value that already names a zone is returned untouched", () => {
  // The character class is POSITIVE, so every one of these falls out on its own
  // rather than by an enumerated exclusion — which is why an unlisted suffix
  // cannot be mistaken for a zone-less tail.
  for (const value of [
    "2026-06-22T10:00:00Z",
    "2026-06-22T10:00:00.000Z",
    "2026-06-22T10:00:00z",
    "2026-06-22T10:00:00+02:00",
    "2026-06-22T10:00:00-0500",
    "2026-06-22",
    "2026-06-22 10:00:00",
    "not-a-timestamp",
    "",
  ]) {
    assert.equal(readZoneLessAsUtc(value), value);
  }
});

test("ISS-8398: naming the zone makes the reading host-independent", () => {
  // The whole point. `Date.parse` of the raw text is HOST-LOCAL and so differs
  // by five hours between these two zones; the named-zone form does not.
  const previous = process.env.TZ;
  try {
    const named = readZoneLessAsUtc("2026-06-03T23:30:00");
    process.env.TZ = "UTC";
    const utc = new Date(Date.parse(named)).toISOString();
    process.env.TZ = "America/Chicago";
    const chicago = new Date(Date.parse(named)).toISOString();
    assert.equal(utc, "2026-06-03T23:30:00.000Z");
    assert.equal(chicago, utc, "the named zone is read the same on any host");
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "TZ");
    } else {
      process.env.TZ = previous;
    }
  }
});
