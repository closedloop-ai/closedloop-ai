import { describe, expect, it } from "vitest";
import {
  formatSessionTraceAgentLineage,
  formatSessionTraceCost,
  formatSessionTraceCount,
  formatSessionTraceDuration,
} from "../session-trace-format";

const NO_VALUE = "—";

describe("formatSessionTraceDuration", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    "renders %s as no value",
    (ms) => {
      expect(formatSessionTraceDuration(ms)).toBe(NO_VALUE);
    }
  );

  it.each([
    [0, "0ms"],
    [999.4, "999ms"],
    [999.5, "1.0s"],
    [1449, "1.4s"],
    [59_949, "59.9s"],
    [59_950, "1m 0s"],
    [126_000, "2m 6s"],
    [179_600, "3m 0s"],
    [3_599_499, "59m 59s"],
    [3_599_500, "1h 0m"],
    [3_718_003, "1h 1m"],
    [190_800_000, "53h 0m"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatSessionTraceDuration(ms)).toBe(expected);
  });
});

describe("formatSessionTraceCount", () => {
  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "renders %s as no value",
    (value) => {
      expect(formatSessionTraceCount(value)).toBe(NO_VALUE);
    }
  );

  it.each([
    [0, "0"],
    [1_234_567, "1,234,567"],
    [-42, "-42"],
  ])("formats %d as %s", (value, expected) => {
    expect(formatSessionTraceCount(value)).toBe(expected);
  });
});

describe("formatSessionTraceCost", () => {
  it.each([undefined, Number.NaN, Number.NEGATIVE_INFINITY])(
    "renders %s as no value",
    (value) => {
      expect(formatSessionTraceCost(value)).toBe(NO_VALUE);
    }
  );

  it("keeps four places on a sub-cent spend", () => {
    expect(formatSessionTraceCost(0.0049)).toBe("$0.0049");
  });

  it("keeps four places on any sub-dollar spend, including zero", () => {
    // pins current behavior; looks odd because the docstring promises four places only below one cent
    expect(formatSessionTraceCost(0.01)).toBe("$0.0100");
    expect(formatSessionTraceCost(0.0402)).toBe("$0.0402");
    expect(formatSessionTraceCost(0.5)).toBe("$0.5000");
    expect(formatSessionTraceCost(0)).toBe("$0.0000");
  });

  it("drops to two places from one dollar up", () => {
    expect(formatSessionTraceCost(1)).toBe("$1.00");
    expect(formatSessionTraceCost(12.5)).toBe("$12.50");
  });

  it("prints a negative spend after the dollar sign", () => {
    // pins current behavior; looks odd because the sign lands after the currency symbol
    expect(formatSessionTraceCost(-0.5)).toBe("$-0.5000");
  });
});

describe("formatSessionTraceAgentLineage", () => {
  it("renders no value when the agent is unknown, even with a parent", () => {
    expect(formatSessionTraceAgentLineage(undefined, undefined)).toBe(NO_VALUE);
    expect(formatSessionTraceAgentLineage(undefined, "ag-1")).toBe(NO_VALUE);
  });

  it("renders the bare agent when no parent was recorded", () => {
    expect(formatSessionTraceAgentLineage("ag-2", undefined)).toBe("ag-2");
  });

  it("names the parent the agent came from", () => {
    expect(formatSessionTraceAgentLineage("ag-2", "ag-1")).toBe(
      "ag-2 · from ag-1"
    );
  });
});
