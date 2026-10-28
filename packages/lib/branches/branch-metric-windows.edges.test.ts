/** Edge cases for branch-metric-windows. */
import { BranchMetricPeriod } from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  branchMetricWindowOverlapsInterval,
  buildAdjacentBranchMetricWindows,
  isTimestampInBranchMetricWindow,
} from "./branch-metric-windows";

const WINDOW = {
  startAt: "2026-08-01T00:00:00.000Z",
  endAt: "2026-08-08T00:00:00.000Z",
};

describe("isTimestampInBranchMetricWindow — NaN startMs", () => {
  it("returns false when the window startAt is an unparseable string", () => {
    // Date.parse("bad-date") → NaN → the NaN guard fires → return false.
    const result = isTimestampInBranchMetricWindow("2026-08-01T00:00:00.000Z", {
      startAt: "bad-date",
      endAt: "2026-08-03T00:00:00.000Z",
    });
    expect(result).toBe(false);
  });

  it("returns false when the timestamp itself is an unparseable string", () => {
    const result = isTimestampInBranchMetricWindow("not-a-date", {
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-08-03T00:00:00.000Z",
    });
    expect(result).toBe(false);
  });
});

describe("buildAdjacentBranchMetricWindows — validEpoch throws on invalid Date", () => {
  it("throws when the supplied end Date is invalid (NaN epoch)", () => {
    expect(() =>
      buildAdjacentBranchMetricWindows(
        BranchMetricPeriod.SevenDays,
        new Date("invalid")
      )
    ).toThrow("Branch metric window requires a valid end instant");
  });
});

describe("branchMetricWindowOverlapsInterval", () => {
  it("answers true for a window lying wholly inside the interval", () => {
    expect(
      branchMetricWindowOverlapsInterval(
        "2026-07-01T00:00:00.000Z",
        new Date("2026-09-01T00:00:00.000Z"),
        WINDOW
      )
    ).toBe(true);
  });

  it("answers false for an interval ending at the window start", () => {
    expect(
      branchMetricWindowOverlapsInterval(
        "2026-07-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
        WINDOW
      )
    ).toBe(false);
  });

  it("answers false for an interval starting at the window end", () => {
    expect(
      branchMetricWindowOverlapsInterval(
        "2026-08-08T00:00:00.000Z",
        "2026-09-01T00:00:00.000Z",
        WINDOW
      )
    ).toBe(false);
  });

  it("treats an open-start window as overlapping any interval before its end", () => {
    expect(
      branchMetricWindowOverlapsInterval(
        "2020-01-01T00:00:00.000Z",
        "2020-01-02T00:00:00.000Z",
        { startAt: null, endAt: WINDOW.endAt }
      )
    ).toBe(true);
  });

  it.each([
    ["missing start", null, "2026-08-02T00:00:00.000Z", WINDOW],
    ["unparseable end", "2026-07-01T00:00:00.000Z", "junk", WINDOW],
    [
      "unparseable window end",
      "2020-01-01T00:00:00.000Z",
      "2020-01-02T00:00:00.000Z",
      { startAt: WINDOW.startAt, endAt: "junk" },
    ],
    [
      "unparseable window start",
      "2020-01-01T00:00:00.000Z",
      "2020-01-02T00:00:00.000Z",
      { startAt: "junk", endAt: WINDOW.endAt },
    ],
  ])("answers true on %s", (_label, startAt, endAt, window) => {
    expect(branchMetricWindowOverlapsInterval(startAt, endAt, window)).toBe(
      true
    );
  });
});

describe("buildAdjacentBranchMetricWindows — non-finite now", () => {
  it("keeps the full-width prior window when now is an invalid Date", () => {
    const windows = buildAdjacentBranchMetricWindows(
      BranchMetricPeriod.SevenDays,
      new Date(WINDOW.endAt),
      new Date("invalid")
    );
    expect(windows.prior).toEqual({
      startAt: "2026-07-25T00:00:00.000Z",
      endAt: "2026-08-01T00:00:00.000Z",
    });
  });
});
