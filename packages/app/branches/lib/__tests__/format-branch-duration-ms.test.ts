import { describe, expect, it } from "vitest";
import { formatBranchDurationMs } from "../format-branch-duration-ms";

/**
 * ISS-6958. Every expectation below is an independently written literal, NOT a
 * value derived by calling the formatter or by re-implementing its arithmetic:
 * re-deriving the expected string from the thing under test is what lets a
 * broken formatter agree with its own test. The duplication IS the test.
 */
describe("formatBranchDurationMs", () => {
  it("delegates sub-minute values, which are already legible", () => {
    expect(formatBranchDurationMs(null)).toBe("—");
    expect(formatBranchDurationMs(0)).toBe("0ms");
    expect(formatBranchDurationMs(999)).toBe("999ms");
    expect(formatBranchDurationMs(1000)).toBe("1.0s");
    expect(formatBranchDurationMs(59_000)).toBe("59.0s");
  });

  it("withholds impossible values crossing runtime boundaries", () => {
    expect(formatBranchDurationMs(-1)).toBe("—");
    expect(formatBranchDurationMs(Number.NaN)).toBe("—");
    expect(formatBranchDurationMs(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("drops a zero-valued trailing component instead of printing '0s'", () => {
    expect(formatBranchDurationMs(60_000)).toBe("1m");
    expect(formatBranchDurationMs(3_600_000)).toBe("1h");
    expect(formatBranchDurationMs(86_400_000)).toBe("1d");
  });

  it("keeps a non-zero trailing component", () => {
    expect(formatBranchDurationMs(90_000)).toBe("1m 30s");
    expect(formatBranchDurationMs(3_661_000)).toBe("1h 1m");
    expect(formatBranchDurationMs(333_601_000)).toBe("3d 20h");
  });

  it("changes unit exactly at the hour and day breaks", () => {
    expect(formatBranchDurationMs(3_599_000)).toBe("59m 59s");
    expect(formatBranchDurationMs(3_600_000)).toBe("1h");
    expect(formatBranchDurationMs(86_340_000)).toBe("23h 59m");
    expect(formatBranchDurationMs(86_400_000)).toBe("1d");
  });

  /**
   * The two durations the ticket photographed in production, and the canonical
   * populated story's primary metric. These are the regression: each rendered in
   * raw minutes before this formatter existed.
   */
  it("renders the reported production durations legibly", () => {
    // Was "3180m 0s" — 53 hours.
    expect(formatBranchDurationMs(190_800_000)).toBe("2d 5h");
    // Was "9259m 6s" — the Abandonment Duration headline, over six days.
    expect(formatBranchDurationMs(555_546_000)).toBe("6d 10h");
    // Was "120m 0s" — the canonical Storybook fixture's two hours.
    expect(formatBranchDurationMs(7_200_000)).toBe("2h");
  });

  it("carries a rounded-up remainder into the next unit, never printing a 60", () => {
    expect(formatBranchDurationMs(119_500)).toBe("2m");
    expect(formatBranchDurationMs(3_599_600)).toBe("1h");
  });
});
