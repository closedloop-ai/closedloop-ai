/**
 * Edge cases for branch-list-metric-projection covering:
 * 1. branchMetricPeriodForRange — exactly 7 days with allowTolerance=false → SevenDays
 *    (matchesPeriod's difference===0 arm, not the tolerance arm)
 * 2. boundedEndFromStart — SevenDays branch (days = 7)
 * 3. boundedEndFromStart — ThirtyDays branch (days = 30)
 * 4. validDate — Date instance path (value instanceof Date → date = value directly)
 */
import { BranchMetricPeriod } from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  branchMetricPeriodForRange,
  resolveCanonicalBranchMetricWindows,
} from "./branch-list-metric-projection";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("branchMetricPeriodForRange edge cases", () => {
  it("classifies exactly-7-days range as SevenDays when tolerance is disabled", () => {
    const start = new Date("2026-07-27T00:00:00.000Z");
    const end = new Date(start.getTime() + 7 * DAY_MS);
    // allowStartOnlyTolerance = false (default) → difference must be exactly 0
    const period = branchMetricPeriodForRange(start, end, false);
    expect(period).toBe(BranchMetricPeriod.SevenDays);
  });

  it("classifies exactly-7-days range as SevenDays when allowTolerance is also false (omitted)", () => {
    const start = new Date("2026-07-27T00:00:00.000Z");
    const end = new Date(start.getTime() + 7 * DAY_MS);
    const period = branchMetricPeriodForRange(start, end);
    expect(period).toBe(BranchMetricPeriod.SevenDays);
  });

  it("classifies a 6-day-23h range as SevenDays when tolerance is enabled (exercises tolerance arm)", () => {
    const start = new Date("2026-07-27T00:00:00.000Z");
    const slightlyShort = new Date(
      start.getTime() + 7 * DAY_MS - 4 * 60 * 1000
    );
    // allowTolerance=true → within 5-minute tolerance → SevenDays
    const period = branchMetricPeriodForRange(start, slightlyShort, true);
    expect(period).toBe(BranchMetricPeriod.SevenDays);
  });

  it("returns All when start date is invalid", () => {
    const period = branchMetricPeriodForRange("not-a-date", new Date());
    expect(period).toBe(BranchMetricPeriod.All);
  });

  it("returns All when end date is null/invalid", () => {
    const period = branchMetricPeriodForRange(new Date(), "not-a-date");
    expect(period).toBe(BranchMetricPeriod.All);
  });
});

describe("resolveCanonicalBranchMetricWindows — boundedEndFromStart SevenDays + ThirtyDays paths", () => {
  it("uses SevenDays (7-day bound) when startDate resolves to a 7-day period and endDate is absent", () => {
    const now = new Date("2026-08-03T00:00:00.000Z");
    // Start is exactly 7 days before now; no endDate → resolves SevenDays,
    // then boundedEndFromStart(start, SevenDays) → start + 7*DAY = now
    const start = new Date(now.getTime() - 7 * DAY_MS);
    const windows = resolveCanonicalBranchMetricWindows({
      startDate: start,
      endDate: undefined,
      now,
    });
    expect(windows.period).toBe(BranchMetricPeriod.SevenDays);
    expect(windows.current.endAt).toBe(now.toISOString());
    expect(windows.current.startAt).toBe(
      new Date(now.getTime() - 7 * DAY_MS).toISOString()
    );
  });

  it("uses ThirtyDays (30-day bound) when startDate resolves to a 30-day period and endDate is absent", () => {
    const now = new Date("2026-08-03T00:00:00.000Z");
    const start = new Date(now.getTime() - 30 * DAY_MS);
    const windows = resolveCanonicalBranchMetricWindows({
      startDate: start,
      endDate: undefined,
      now,
    });
    expect(windows.period).toBe(BranchMetricPeriod.ThirtyDays);
    expect(windows.current.endAt).toBe(now.toISOString());
  });
});

describe("validDate — Date instance path", () => {
  it("accepts a Date instance directly (value instanceof Date path)", () => {
    const now = new Date("2026-08-03T00:00:00.000Z");
    const start = new Date(now.getTime() - 7 * DAY_MS);
    // Both startDate and endDate are Date instances → validDate takes the instanceof Date branch
    const period = branchMetricPeriodForRange(start, now, false);
    expect(period).toBe(BranchMetricPeriod.SevenDays);
  });
});

describe("resolveCanonicalBranchMetricWindows — boundedEndFromStart NinetyDays path", () => {
  it("uses NinetyDays bound when startDate is 90 days before now (else-if ThirtyDays is false — arm 1)", () => {
    const now = new Date("2026-08-03T00:00:00.000Z");
    const start = new Date(now.getTime() - 90 * DAY_MS);
    // period resolves to NinetyDays → boundedEndFromStart: SevenDays-if is false,
    // ThirtyDays-else-if is also false (arm 1) → days stays 90
    const windows = resolveCanonicalBranchMetricWindows({
      startDate: start,
      endDate: undefined,
      now,
    });
    expect(windows.period).toBe(BranchMetricPeriod.NinetyDays);
    expect(windows.current.endAt).toBe(now.toISOString());
  });
});
