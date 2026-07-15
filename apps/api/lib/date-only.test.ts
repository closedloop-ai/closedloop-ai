/**
 * Unit tests for the shared timezone-aware date-only helpers, focused on
 * `canonicalizeTimeZone` (FEA-2881): offset-style zones that `Intl` accepts
 * (`+01:00`) must be rewritten to a canonical IANA name PostgreSQL's
 * `AT TIME ZONE` interprets identically, or dropped to UTC when they can't be.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalizeTimeZone,
  isValidTimeZone,
  toLocalDateOnly,
} from "./date-only";

// 23:30 UTC lands on the next calendar day in any positive whole-hour offset and
// on the same day in negative offsets — a discriminating instant for asserting
// that an offset zone and its Etc/GMT canonical form bucket to the same day.
const LATE_NIGHT_UTC = new Date("2024-01-01T23:30:00.000Z");

describe("canonicalizeTimeZone", () => {
  it("passes IANA names through unchanged", () => {
    expect(canonicalizeTimeZone("America/New_York")).toBe("America/New_York");
    expect(canonicalizeTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(canonicalizeTimeZone("UTC")).toBe("UTC");
    // Already-canonical Etc/GMT zones survive round-tripping.
    expect(canonicalizeTimeZone("Etc/GMT+5")).toBe("Etc/GMT+5");
  });

  it("rewrites positive offsets to the sign-inverted Etc/GMT zone", () => {
    // UTC+1 is Etc/GMT-1 (the Etc/GMT sign is inverted from the offset).
    expect(canonicalizeTimeZone("+01:00")).toBe("Etc/GMT-1");
    expect(canonicalizeTimeZone("+0100")).toBe("Etc/GMT-1");
    expect(canonicalizeTimeZone("+01")).toBe("Etc/GMT-1");
    expect(canonicalizeTimeZone("+14:00")).toBe("Etc/GMT-14");
  });

  it("rewrites negative offsets to the sign-inverted Etc/GMT zone", () => {
    // UTC-5 is Etc/GMT+5.
    expect(canonicalizeTimeZone("-05:00")).toBe("Etc/GMT+5");
    expect(canonicalizeTimeZone("-12:00")).toBe("Etc/GMT+12");
  });

  it("maps a zero offset to UTC", () => {
    expect(canonicalizeTimeZone("+00:00")).toBe("UTC");
    expect(canonicalizeTimeZone("-00:00")).toBe("UTC");
  });

  it("drops offsets that can't be a whole-hour Etc/GMT zone to fall back to UTC", () => {
    // Fractional offsets (India +05:30) have no whole-hour Etc/GMT equivalent.
    expect(canonicalizeTimeZone("+05:30")).toBeNull();
    expect(canonicalizeTimeZone("+13:45")).toBeNull();
    // Etc/GMT only spans -14…+12; +15:00 is out of range even though Intl
    // accepts it.
    expect(canonicalizeTimeZone("+15:00")).toBeNull();
  });

  it("rejects invalid or unparseable identifiers", () => {
    expect(canonicalizeTimeZone("garbage")).toBeNull();
    // Intl rejects the `UTC+1`/`GMT+1` forms outright; they stay rejected.
    expect(canonicalizeTimeZone("UTC+1")).toBeNull();
    expect(canonicalizeTimeZone("GMT+1")).toBeNull();
    expect(canonicalizeTimeZone("")).toBeNull();
  });

  it("is idempotent — canonicalizing its own output is a no-op", () => {
    for (const input of ["+01:00", "-05:00", "+00:00", "America/New_York"]) {
      const once = canonicalizeTimeZone(input);
      expect(once).not.toBeNull();
      expect(canonicalizeTimeZone(once as string)).toBe(once);
    }
  });

  it("produces an Etc/GMT zone that buckets to the same local day as the offset", () => {
    // The whole point: JS-side day labeling (toLocalDateOnly) and the SQL bucket
    // must agree. Since PG interprets Etc/GMT names correctly, asserting the
    // offset and its canonical form agree under Intl proves the alignment.
    for (const offset of ["+01:00", "-05:00", "+14:00", "-12:00"]) {
      const canonical = canonicalizeTimeZone(offset);
      expect(canonical).not.toBeNull();
      expect(isValidTimeZone(canonical as string)).toBe(true);
      expect(toLocalDateOnly(LATE_NIGHT_UTC, canonical)).toBe(
        toLocalDateOnly(LATE_NIGHT_UTC, offset)
      );
    }
    // Sanity: the offset actually shifts the day so the assertion isn't vacuous.
    expect(toLocalDateOnly(LATE_NIGHT_UTC, "+01:00")).toBe("2024-01-02");
    expect(toLocalDateOnly(LATE_NIGHT_UTC, "-05:00")).toBe("2024-01-01");
  });
});

describe("toLocalDateOnly (FEA-1459)", () => {
  it("formats date in UTC when timezone is null", () => {
    // 2026-06-08T02:30:00Z is still June 8 in UTC
    const date = new Date("2026-06-08T02:30:00.000Z");
    expect(toLocalDateOnly(date, null)).toBe("2026-06-08");
  });

  it("formats date in UTC when timezone is undefined", () => {
    const date = new Date("2026-06-08T02:30:00.000Z");
    expect(toLocalDateOnly(date, undefined)).toBe("2026-06-08");
  });

  it("shifts to previous calendar day for evening CDT session", () => {
    // 2026-06-08T02:30:00Z = 2026-06-07T21:30:00 CDT (America/Chicago is UTC-5 in summer)
    const date = new Date("2026-06-08T02:30:00.000Z");
    expect(toLocalDateOnly(date, "America/Chicago")).toBe("2026-06-07");
  });

  it("keeps same day when local time is still same calendar day", () => {
    // 2026-06-08T15:00:00Z = 2026-06-08T10:00:00 CDT
    const date = new Date("2026-06-08T15:00:00.000Z");
    expect(toLocalDateOnly(date, "America/Chicago")).toBe("2026-06-08");
  });

  it("handles positive-offset timezone (shifts forward)", () => {
    // 2026-06-07T23:30:00Z = 2026-06-08T08:30:00 Asia/Tokyo (UTC+9)
    const date = new Date("2026-06-07T23:30:00.000Z");
    expect(toLocalDateOnly(date, "Asia/Tokyo")).toBe("2026-06-08");
  });

  it("falls back to UTC for invalid timezone", () => {
    const date = new Date("2026-06-08T02:30:00.000Z");
    expect(toLocalDateOnly(date, "Invalid/Timezone")).toBe("2026-06-08");
  });
});
