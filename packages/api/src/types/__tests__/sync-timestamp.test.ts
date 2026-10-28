import { describe, expect, it } from "vitest";
import {
  isBelowPgTimestampFloor,
  PG_TIMESTAMP_MIN_MS,
} from "../pg-timestamp-floor.ts";
import {
  pgRangedTimestampSchema,
  storableSyncTimestampSchema,
  syncTimestampSchema,
  TimestampRejection,
} from "../sync-timestamp.ts";
import { findIssue } from "../zod-issue.test-helpers.ts";

const BELOW_PG_FLOOR = "-271821-04-20T00:00:00.000Z";
const FAR_BELOW_PG_FLOOR = "-100000-01-01T00:00:00.000Z";

// Literal oracles, deliberately NOT derived from the imported constant: 4713 BC
// is astronomical year -4712 (there is a year zero), so the floor is the first
// instant of -004712 and the last instant of -004713 is below it. A constant
// written as the era year (-4713) would pass every derived case and fail these.
const FLOOR_INSTANT_LITERAL = "-004712-01-01T00:00:00.000Z";
const JUST_BELOW_FLOOR_LITERAL = "-004713-12-31T23:59:59.999Z";

describe("PG_TIMESTAMP_MIN_MS — the one Postgres floor (ISS-8735)", () => {
  it("is the first instant of astronomical year -4712, not the era year -4713", () => {
    expect(new Date(PG_TIMESTAMP_MIN_MS).toISOString()).toBe(
      FLOOR_INSTANT_LITERAL
    );
  });
});

describe("isBelowPgTimestampFloor", () => {
  it("is false at the floor and true one millisecond below it", () => {
    expect(isBelowPgTimestampFloor(PG_TIMESTAMP_MIN_MS)).toBe(false);
    expect(isBelowPgTimestampFloor(PG_TIMESTAMP_MIN_MS - 1)).toBe(true);
    expect(isBelowPgTimestampFloor(new Date(PG_TIMESTAMP_MIN_MS))).toBe(false);
    expect(isBelowPgTimestampFloor(new Date(PG_TIMESTAMP_MIN_MS - 1))).toBe(
      true
    );
  });

  it("treats NaN as NOT below the floor — malformed is a separate condition", () => {
    expect(isBelowPgTimestampFloor(Number.NaN)).toBe(false);
    expect(isBelowPgTimestampFloor(new Date("not-a-date"))).toBe(false);
  });

  it("is false for an ordinary instant and for the largest JS date", () => {
    expect(
      isBelowPgTimestampFloor(Date.parse("2026-08-30T00:00:00.000Z"))
    ).toBe(false);
    expect(isBelowPgTimestampFloor(8.64e15)).toBe(false);
  });
});

describe("storableSyncTimestampSchema — Postgres timestamp floor (ISS-8547)", () => {
  it.each([
    ["~267,000 years below the floor", BELOW_PG_FLOOR],
    ["~100,000 years below the floor", FAR_BELOW_PG_FLOOR],
  ])("degrades an instant %s to undefined", (_label, value) => {
    // The mutation this kills: before the bound, this value parsed through
    // intact and only failed at the INSERT, wedging the batch on every retry.
    const result = storableSyncTimestampSchema.safeParse(value);

    expect(result.success).toBe(true);
    expect(result.data).toBeUndefined();
  });

  it("keeps the floor instant itself and degrades the instant one ms below it (literal oracle)", () => {
    expect(
      storableSyncTimestampSchema.safeParse(FLOOR_INSTANT_LITERAL).data
    ).toBe(FLOOR_INSTANT_LITERAL);
    expect(
      storableSyncTimestampSchema.safeParse(JUST_BELOW_FLOOR_LITERAL).data
    ).toBeUndefined();
  });

  it("degrades at the floor boundary but keeps the boundary instant itself (derived)", () => {
    const atBoundary = new Date(PG_TIMESTAMP_MIN_MS).toISOString();
    const belowBoundary = new Date(PG_TIMESTAMP_MIN_MS - 1).toISOString();

    expect(storableSyncTimestampSchema.safeParse(atBoundary).data).toBe(
      atBoundary
    );
    expect(
      storableSyncTimestampSchema.safeParse(belowBoundary).data
    ).toBeUndefined();
  });

  it("passes an ordinary timestamp through unchanged", () => {
    // The mutation this catches is a bound written tight enough to swallow the
    // everyday case — nearly every synced timestamp looks like this one.
    const result = storableSyncTimestampSchema.safeParse(
      "2026-08-30T00:00:00.000Z"
    );

    expect(result.success).toBe(true);
    expect(result.data).toBe("2026-08-30T00:00:00.000Z");
  });

  it.each([
    ["an ISO end-of-day hour 24", "2026-06-03T24:00:00Z"],
    ["a year below 100", "0050-03-04T10:00:00Z"],
    ["a leap day", "2024-02-29T12:00:00Z"],
  ])(
    "keeps %s — awkward but legal, and inside the Postgres range",
    (_label, value) => {
      // Pinned so a future tightening (a calendar-validity check like
      // isRealCalendarInstant, which rejects two of these) fails loudly instead
      // of silently dropping rows Postgres accepts.
      const result = storableSyncTimestampSchema.safeParse(value);

      expect(result.success).toBe(true);
      expect(result.data).toBe(value);
    }
  );

  it("keeps year 10000 — inside the Postgres range though not RFC3339, because this bounds RANGE and not FORMAT", () => {
    const result = storableSyncTimestampSchema.safeParse(
      "+010000-01-01T00:00:00.000Z"
    );

    expect(result.data).toBe("+010000-01-01T00:00:00.000Z");
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["unparseable text", "not-a-date"],
  ])(
    "still REJECTS %s rather than degrading it — malformed is not out-of-range",
    (_label, value) => {
      // Deliberately distinct from the degrade path above. The desktop drops a
      // ref whose parse fails, so turning malformed into a degrade would change
      // which refs sync — behaviour ISS-8547 did not ask to touch.
      const result = storableSyncTimestampSchema.safeParse(value);

      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = findIssue(result.error.issues, []);
        expect(issue?.message).toBe("invalid_date");
      }
    }
  );
});

describe("syncTimestampSchema — unchanged by ISS-8547", () => {
  it("still accepts an out-of-range instant, because only the storable variant bounds it", () => {
    // Pins that the bound was added as a SEPARATE schema rather than by
    // tightening this one, which the desktop's local branch-activity read uses.
    const result = syncTimestampSchema.safeParse(BELOW_PG_FLOOR);

    expect(result.success).toBe(true);
    expect(result.data).toBe(BELOW_PG_FLOOR);
  });

  it("trims leading and trailing whitespace from a padded timestamp", () => {
    const result = syncTimestampSchema.safeParse(
      "  2026-08-30T00:00:00.000Z  "
    );

    expect(result.success).toBe(true);
    expect(result.data).toBe("2026-08-30T00:00:00.000Z");
  });

  it("still rejects unparseable text", () => {
    expect(syncTimestampSchema.safeParse("not-a-date").success).toBe(false);
  });
});

describe("pgRangedTimestampSchema — rejecting floor for hash-reconciled lanes (ISS-9174)", () => {
  it("accepts the floor instant and returns it unchanged", () => {
    const result = pgRangedTimestampSchema.safeParse(FLOOR_INSTANT_LITERAL);

    expect(result.success).toBe(true);
    expect(result.data).toBe(FLOOR_INSTANT_LITERAL);
  });

  it("rejects the instant one millisecond below the floor with date_below_timestamp_floor only", () => {
    const result = pgRangedTimestampSchema.safeParse(JUST_BELOW_FLOOR_LITERAL);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual([
        TimestampRejection.BelowTimestampFloor,
      ]);
    }
  });

  it("rejects a malformed value with invalid_date only", () => {
    const result = pgRangedTimestampSchema.safeParse("not-a-date");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual([
        TimestampRejection.InvalidDate,
      ]);
    }
  });

  it("does NOT trim: a padded timestamp is rejected, not rescued", () => {
    // `syncTimestampSchema` trims. This one must not: on the invocation lane the
    // producer hashed the exact bytes, so rescuing a padded value here would make
    // the server hash different bytes from the ones it verifies.
    const result = pgRangedTimestampSchema.safeParse(
      "  2026-08-30T00:00:00.000Z  "
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual([
        TimestampRejection.InvalidDate,
      ]);
    }
  });
});
