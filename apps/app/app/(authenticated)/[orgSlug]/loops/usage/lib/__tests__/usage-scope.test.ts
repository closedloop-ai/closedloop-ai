import { describe, expect, it } from "vitest";
import {
  formatAsOf,
  getUsageScopeStartIso,
  parseUsageScope,
  USAGE_SCOPE_LABELS,
  USAGE_SCOPES,
  type UsageScope,
} from "../usage-scope";

const NOW = new Date("2026-07-20T12:00:00.000Z");

describe("usage-scope windows (FEA-1541)", () => {
  it("exposes an exhaustive label for every scope", () => {
    for (const scope of USAGE_SCOPES) {
      expect(USAGE_SCOPE_LABELS[scope]).toBeTruthy();
    }
    expect(Object.keys(USAGE_SCOPE_LABELS).sort()).toEqual(
      [...USAGE_SCOPES].sort()
    );
  });

  it("keeps `all` as an unbounded (undefined start) window so the prior all-time total is preserved", () => {
    expect(getUsageScopeStartIso("all", NOW)).toBeUndefined();
  });

  it("scopes `today` to exactly the trailing 24h", () => {
    expect(getUsageScopeStartIso("today", NOW)).toBe(
      "2026-07-19T12:00:00.000Z"
    );
  });

  it("computes 7d/30d/90d boundaries via day-subtraction with no off-by-one drift", () => {
    expect(getUsageScopeStartIso("7d", NOW)).toBe("2026-07-13T12:00:00.000Z");
    expect(getUsageScopeStartIso("30d", NOW)).toBe("2026-06-20T12:00:00.000Z");
    expect(getUsageScopeStartIso("90d", NOW)).toBe("2026-04-21T12:00:00.000Z");
  });

  it("orders the day windows monotonically (today >= 7d >= 30d >= 90d start)", () => {
    const starts = (["today", "7d", "30d", "90d"] as UsageScope[]).map(
      (s) => getUsageScopeStartIso(s, NOW) as string
    );
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i - 1] > starts[i]).toBe(true);
    }
  });

  it("parses known scopes and falls back to 30d for junk", () => {
    expect(parseUsageScope("today")).toBe("today");
    expect(parseUsageScope("all")).toBe("all");
    expect(parseUsageScope("7d")).toBe("7d");
    expect(parseUsageScope(null)).toBe("30d");
    expect(parseUsageScope("bogus")).toBe("30d");
  });

  it("formats an `as of` stamp deterministically as date + time", () => {
    const stamp = formatAsOf(NOW);
    expect(stamp).toContain("2026");
    expect(stamp.length).toBeGreaterThan(0);
  });
});
