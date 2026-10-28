import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TIMEZONE_MODE,
  TimezoneMode,
} from "../date-window-timezone-mode";
import {
  getStableDateWindowForRange,
  getStableLocalDateWindowForRange,
  getStableUtcDateWindowForRange,
} from "../format-utils";

/**
 * ISS-9619 — the Local day boundary, pinned against the UTC one.
 *
 * Every case runs at an instant where the two boundaries genuinely DISAGREE, in
 * a fixed-offset zone (Honolulu, UTC-10, no DST) so the expected bounds are
 * arithmetic a reader can check rather than a value copied out of a failure.
 */
describe("getStableDateWindowForRange (ISS-9619)", () => {
  const originalTimezone = process.env.TZ;

  // Unconditional, and an `afterEach` rather than the last line of a case: an
  // assertion that throws mid-case would otherwise leak a frozen clock and a
  // rewritten timezone into every later test in this worker.
  afterEach(() => {
    vi.useRealTimers();
    if (originalTimezone === undefined) {
      Reflect.deleteProperty(process.env, "TZ");
      return;
    }
    process.env.TZ = originalTimezone;
  });

  function pin(instantIso: string, timeZone: string): void {
    process.env.TZ = timeZone;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(instantIso));
  }

  // 16:00 on Aug 7 in Honolulu is already Aug 8 in UTC, so the two modes are
  // reading two different calendar days at one instant.
  const ACROSS_UTC_MIDNIGHT = "2026-08-08T02:00:00.000Z";

  it("windows the reader's own calendar day, not the UTC one", () => {
    pin(ACROSS_UTC_MIDNIGHT, "Pacific/Honolulu");

    expect(getStableDateWindowForRange("7d", TimezoneMode.Local)).toEqual({
      startDate: "2026-08-01T10:00:00.000Z",
      endDate: "2026-08-08T09:59:59.999Z",
    });
    expect(getStableDateWindowForRange("7d", TimezoneMode.Utc)).toEqual({
      startDate: "2026-08-02T00:00:00.000Z",
      endDate: "2026-08-08T23:59:59.999Z",
    });
  });

  it("defaults to UTC, so an untaught caller keeps today's window", () => {
    pin(ACROSS_UTC_MIDNIGHT, "Pacific/Honolulu");

    expect(DEFAULT_TIMEZONE_MODE).toBe(TimezoneMode.Utc);
    expect(getStableDateWindowForRange("30d")).toEqual(
      getStableUtcDateWindowForRange("30d")
    );
  });

  it("holds a Local window stable ACROSS UTC midnight", () => {
    // Both instants are Aug 7 in Honolulu; UTC midnight falls between them.
    pin("2026-08-07T23:59:59.999Z", "Pacific/Honolulu");
    const beforeUtcMidnight = getStableLocalDateWindowForRange("7d");
    vi.setSystemTime(new Date("2026-08-08T00:00:00.001Z"));
    const afterUtcMidnight = getStableLocalDateWindowForRange("7d");

    expect(afterUtcMidnight).toEqual(beforeUtcMidnight);
    // The UTC window DID move across that same boundary, which is what makes
    // this a real distinction rather than a window that never advances.
    expect(getStableUtcDateWindowForRange("7d")).not.toEqual(
      getStableUtcDateWindowForRange("7d", new Date("2026-08-07T23:59:59.999Z"))
    );
  });

  it("advances a Local window at LOCAL midnight", () => {
    pin("2026-08-08T09:59:59.999Z", "Pacific/Honolulu");
    const lastMomentOfLocalDay = getStableLocalDateWindowForRange("7d");
    vi.setSystemTime(new Date("2026-08-08T10:00:00.000Z"));
    const firstMomentOfNextLocalDay = getStableLocalDateWindowForRange("7d");

    expect(
      Date.parse(firstMomentOfNextLocalDay.startDate ?? "") -
        Date.parse(lastMomentOfLocalDay.startDate ?? "")
    ).toBe(24 * 60 * 60 * 1000);
  });

  it("keeps All unbounded under either boundary", () => {
    pin(ACROSS_UTC_MIDNIGHT, "Pacific/Honolulu");

    expect(getStableDateWindowForRange("all", TimezoneMode.Local)).toEqual({});
    expect(getStableDateWindowForRange("all", TimezoneMode.Utc)).toEqual({});
  });
});
