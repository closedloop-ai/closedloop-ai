import { describe, expect, it } from "vitest";
import { NON_WORK_PHASE_GREY } from "../non-work-phase-colors";

const COLOR_MIX_MUTED_FOREGROUND_PATTERN =
  /^color-mix\(in oklab, var\(--muted-foreground\) \d+%, transparent\)$/;

describe("NON_WORK_PHASE_GREY", () => {
  it("exports exactly the idle, other, and unattributed keys", () => {
    expect(Object.keys(NON_WORK_PHASE_GREY).sort()).toEqual([
      "idle",
      "other",
      "unattributed",
    ]);
  });

  it("every value is a color-mix over the shared muted-foreground variable", () => {
    for (const value of Object.values(NON_WORK_PHASE_GREY)) {
      expect(value).toMatch(COLOR_MIX_MUTED_FOREGROUND_PATTERN);
    }
  });

  it("pins the exact per-bucket weights so the three never share a swatch", () => {
    expect(NON_WORK_PHASE_GREY).toEqual({
      idle: "color-mix(in oklab, var(--muted-foreground) 34%, transparent)",
      other: "color-mix(in oklab, var(--muted-foreground) 48%, transparent)",
      unattributed:
        "color-mix(in oklab, var(--muted-foreground) 64%, transparent)",
    });
  });
});
