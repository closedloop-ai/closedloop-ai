import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMilestoneEarned } from "../milestone-display";

// FEA-4108: the earned-month label must read the server's UTC crossing instant
// in UTC, so a first-of-month timestamp does not slip into the previous month
// for viewers west of UTC (the wongk review case).

describe("formatMilestoneEarned (FEA-4108)", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    // Pin the process to a zone west of UTC so a naive local render of a
    // UTC-midnight first-of-month would show the previous month.
    process.env.TZ = "America/Chicago";
    vi.stubEnv("TZ", "America/Chicago");
  });

  afterEach(() => {
    if (originalTz === undefined) {
      Reflect.deleteProperty(process.env, "TZ");
    } else {
      process.env.TZ = originalTz;
    }
    vi.unstubAllEnvs();
  });

  it("labels a first-of-month UTC instant in UTC, not the viewer's local zone", () => {
    // 2026-06-01T00:00:00Z is 2026-05-31T19:00 in Chicago; must still read June.
    expect(formatMilestoneEarned(new Date("2026-06-01T00:00:00.000Z"))).toBe(
      "Jun 2026"
    );
  });

  it("accepts a raw ISO string as well as a revived Date", () => {
    expect(formatMilestoneEarned("2026-06-01T00:00:00.000Z")).toBe("Jun 2026");
  });

  it("returns an empty label for an unparseable value", () => {
    expect(formatMilestoneEarned("not-a-date")).toBe("");
    expect(formatMilestoneEarned(new Date(Number.NaN))).toBe("");
  });
});
