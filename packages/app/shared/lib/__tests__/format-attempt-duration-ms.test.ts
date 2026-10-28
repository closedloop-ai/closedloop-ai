import { describe, expect, it } from "vitest";
import { formatAttemptDurationMs } from "../format-attempt-duration-ms";

describe("formatAttemptDurationMs", () => {
  it("renders a sub-second attempt in whole milliseconds", () => {
    expect(formatAttemptDurationMs(0)).toBe("0ms");
    expect(formatAttemptDurationMs(999)).toBe("999ms");
  });

  it("switches to one decimal place of seconds at the second boundary", () => {
    expect(formatAttemptDurationMs(1000)).toBe("1.0s");
    expect(formatAttemptDurationMs(1500)).toBe("1.5s");
    expect(formatAttemptDurationMs(59_950)).toBe("60.0s");
  });

  /**
   * The load-bearing difference from `formatDurationMs`, which would render
   * "3m 5s" here. An attempt trail is a column compared against itself, so the
   * unit stays fixed and a slow attempt reads as a large number rather than
   * being rounded into a coarser unit.
   */
  it("keeps seconds past a minute instead of rolling up", () => {
    expect(formatAttemptDurationMs(185_300)).toBe("185.3s");
  });
});
