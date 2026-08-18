import { describe, expect, it } from "vitest";
import { formatBranchLeadTimeMs } from "../format-branch-lead-time-ms";

describe("formatBranchLeadTimeMs", () => {
  it("preserves the existing formatter below one day", () => {
    expect(formatBranchLeadTimeMs(3_661_000)).toBe("61m 1s");
    expect(formatBranchLeadTimeMs(86_399_999)).toBe("1440m 0s");
  });

  it("uses compact elapsed days and hours for multi-day lead time", () => {
    expect(formatBranchLeadTimeMs(86_400_000)).toBe("1d");
    expect(formatBranchLeadTimeMs(3 * 86_400_000)).toBe("3d");
    expect(formatBranchLeadTimeMs(333_601_000)).toBe("3d 20h");
  });

  it("does not round a partial hour up", () => {
    expect(formatBranchLeadTimeMs(333_599_999)).toBe("3d 20h");
  });
});
