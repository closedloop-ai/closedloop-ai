import { describe, expect, it } from "vitest";
import { penseroDeliveryWindow } from "../delivery-point-window";

const START = "2026-01-01T00:00:00.000Z";
const END = "2026-01-31T23:59:59.999Z";

describe("penseroDeliveryWindow", () => {
  it("is the ABSENT window when neither bound is set", () => {
    // Absent, not an open-ended pair: the fold's lifetime arm is the one branch
    // detail already ships, and it must stay reachable by construction.
    expect(penseroDeliveryWindow({})).toBeUndefined();
  });

  it("carries a closed window's BOTH bounds", () => {
    expect(penseroDeliveryWindow({ startDate: START, endDate: END })).toEqual({
      start: new Date(START),
      end: new Date(END),
    });
  });

  it("carries a half-open START window on the bound it sets, and no other", () => {
    const window = penseroDeliveryWindow({ startDate: START });

    expect(window).toEqual({ start: new Date(START) });
    expect(window).not.toHaveProperty("end");
  });

  it("carries a half-open END window on the bound it sets, and no other", () => {
    const window = penseroDeliveryWindow({ endDate: END });

    expect(window).toEqual({ end: new Date(END) });
    expect(window).not.toHaveProperty("start");
  });

  it("accepts a Date bound, which is what /branches/analytics parses to", () => {
    // `branch-list-query.ts:166` is `z.coerce.date()`; the cohort POST keeps the
    // ISO string. One parser has to take both or one entry point silently loses
    // its window.
    expect(
      penseroDeliveryWindow({
        startDate: new Date(START),
        endDate: new Date(END),
      })
    ).toEqual({ start: new Date(START), end: new Date(END) });
  });

  it("drops a bound that names no instant rather than guessing one", () => {
    expect(
      penseroDeliveryWindow({ startDate: "not-a-date", endDate: END })
    ).toEqual({ end: new Date(END) });
  });
});
