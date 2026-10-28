import { describe, expect, it } from "vitest";
import { tokenTrendWindowReadout } from "../token-trend-window-readout";

// Pinned as an independent literal rather than derived from the helper's own
// MS_PER_DAY: the duplication IS the test.
const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const NINETY_DAYS_EARLIER = "2026-06-08T12:00:00.000Z";

describe("tokenTrendWindowReadout", () => {
  it("names the window the producer applied", () => {
    expect(
      tokenTrendWindowReadout(
        { appliedWindow: { since: NINETY_DAYS_EARLIER } },
        NOW
      )
    ).toBe("Last 90 days");
  });

  it("reports truncation alongside the window it applies inside", () => {
    expect(
      tokenTrendWindowReadout(
        { appliedWindow: { since: NINETY_DAYS_EARLIER }, truncated: true },
        NOW
      )
    ).toBe("Last 90 days · most recent sessions only");
  });

  it("closes the window at an explicit until rather than the caller's clock", () => {
    expect(
      tokenTrendWindowReadout(
        {
          appliedWindow: {
            since: "2026-09-01T12:00:00.000Z",
            until: "2026-09-08T12:00:00.000Z",
          },
        },
        NOW
      )
    ).toBe("Last 7 days");
  });

  // The distinction that matters: an older producer stating no window is
  // UNKNOWN scope, never all-time. Asserting a bound it never sent would swap
  // one confident wrong number for another.
  it("says nothing when the producer discloses no window", () => {
    expect(tokenTrendWindowReadout({}, NOW)).toBeNull();
    expect(tokenTrendWindowReadout(undefined, NOW)).toBeNull();
  });

  it("still reports truncation when the window itself is undisclosed", () => {
    expect(tokenTrendWindowReadout({ truncated: true }, NOW)).toBe(
      "Most recent sessions only"
    );
  });

  it("treats an unparseable or inverted window as undisclosed, not as zero", () => {
    expect(
      tokenTrendWindowReadout({ appliedWindow: { since: "not-a-date" } }, NOW)
    ).toBeNull();
    expect(
      tokenTrendWindowReadout(
        {
          appliedWindow: {
            since: "2026-09-06T12:00:00.000Z",
            until: "2026-08-06T12:00:00.000Z",
          },
        },
        NOW
      )
    ).toBeNull();
  });

  it("floors a sub-day window at one day instead of reporting none", () => {
    expect(
      tokenTrendWindowReadout(
        {
          appliedWindow: {
            since: "2026-09-06T11:00:00.000Z",
            until: "2026-09-06T12:00:00.000Z",
          },
        },
        NOW
      )
    ).toBe("Last 1 day");
  });
});
