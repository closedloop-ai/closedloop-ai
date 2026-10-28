import { describe, expect, it } from "vitest";
import { sessionsRangeReadout } from "../sessions-range-readout";

describe("sessionsRangeReadout", () => {
  it("returns null for a placeholder page regardless of the other inputs", () => {
    expect(
      sessionsRangeReadout({
        pageIndex: 9,
        pageSize: 25,
        rowsOnPage: 25,
        total: 240,
        isPlaceholderPage: true,
      })
    ).toBeNull();
  });

  it("returns a zero readout when the total is zero", () => {
    expect(
      sessionsRangeReadout({
        pageIndex: 0,
        pageSize: 25,
        rowsOnPage: 0,
        total: 0,
      })
    ).toBe("Showing 0 of 0 sessions");
  });

  it("returns a zero readout when rowsOnPage is zero but total is not", () => {
    expect(
      sessionsRangeReadout({
        pageIndex: 0,
        pageSize: 25,
        rowsOnPage: 0,
        total: 5,
      })
    ).toBe("Showing 0 of 5 sessions");
  });

  it("uses the singular unit for exactly one total session", () => {
    expect(
      sessionsRangeReadout({
        pageIndex: 0,
        pageSize: 25,
        rowsOnPage: 1,
        total: 1,
      })
    ).toBe("Showing 1-1 of 1 session");
  });

  it("states the first page's range", () => {
    expect(
      sessionsRangeReadout({
        pageIndex: 0,
        pageSize: 25,
        rowsOnPage: 25,
        total: 240,
      })
    ).toBe("Showing 1-25 of 240 sessions");
  });

  it("states a middle page's range using the page index, not a running count", () => {
    expect(
      sessionsRangeReadout({
        pageIndex: 1,
        pageSize: 25,
        rowsOnPage: 25,
        total: 240,
      })
    ).toBe("Showing 26-50 of 240 sessions");
  });

  it("clamps the upper bound to the rows actually rendered on the last page, not the arithmetic page-size bound", () => {
    expect(
      sessionsRangeReadout({
        pageIndex: 9,
        pageSize: 25,
        rowsOnPage: 15,
        total: 240,
      })
    ).toBe("Showing 226-240 of 240 sessions");
  });

  it("formats large totals with thousands separators via formatNumber", () => {
    expect(
      sessionsRangeReadout({
        pageIndex: 0,
        pageSize: 25,
        rowsOnPage: 25,
        total: 1234,
      })
    ).toBe("Showing 1-25 of 1,234 sessions");
  });
});
