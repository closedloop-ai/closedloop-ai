import { describe, expect, it } from "vitest";
import type { RateLimit, SessionLimits } from "../../types";
import { selectSummaryBars } from "../summary-bars";
import {
  SessionLimitWindowLabel,
  SessionLimitWindowShortLabel,
} from "../window-labels";

const rateLimit = (utilization: number): RateLimit => ({
  utilization,
  resetsAt: "2026-08-25T12:00:00.000Z",
});

const EMPTY_LIMITS: SessionLimits = {
  fiveHour: null,
  sevenDay: null,
  sevenDayOpus: null,
  sevenDaySonnet: null,
  extraUsage: null,
  fetchedAt: null,
};

describe("selectSummaryBars", () => {
  it("returns a fiveHour bar with the short label when only fiveHour is present", () => {
    const limits: SessionLimits = {
      ...EMPTY_LIMITS,
      fiveHour: rateLimit(42),
    };

    expect(selectSummaryBars(limits)).toEqual([
      { title: SessionLimitWindowShortLabel.FiveHour, limit: limits.fiveHour },
    ]);
  });

  it("returns a sevenDay bar with the short label when only sevenDay is present", () => {
    const limits: SessionLimits = {
      ...EMPTY_LIMITS,
      sevenDay: rateLimit(17),
    };

    expect(selectSummaryBars(limits)).toEqual([
      { title: SessionLimitWindowShortLabel.SevenDay, limit: limits.sevenDay },
    ]);
  });

  it("returns both bars, fiveHour first, when both are present", () => {
    const limits: SessionLimits = {
      ...EMPTY_LIMITS,
      fiveHour: rateLimit(10),
      sevenDay: rateLimit(20),
    };

    expect(selectSummaryBars(limits)).toEqual([
      { title: SessionLimitWindowShortLabel.FiveHour, limit: limits.fiveHour },
      { title: SessionLimitWindowShortLabel.SevenDay, limit: limits.sevenDay },
    ]);
  });

  it("falls back to the sevenDaySonnet bar with its full label when the primary windows are absent", () => {
    const limits: SessionLimits = {
      ...EMPTY_LIMITS,
      sevenDaySonnet: rateLimit(55),
    };

    expect(selectSummaryBars(limits)).toEqual([
      {
        title: SessionLimitWindowLabel.SevenDaySonnet,
        limit: limits.sevenDaySonnet,
      },
    ]);
  });

  it("falls back to the sevenDayOpus bar with its full label when the primary windows are absent", () => {
    const limits: SessionLimits = {
      ...EMPTY_LIMITS,
      sevenDayOpus: rateLimit(33),
    };

    expect(selectSummaryBars(limits)).toEqual([
      {
        title: SessionLimitWindowLabel.SevenDayOpus,
        limit: limits.sevenDayOpus,
      },
    ]);
  });

  it("prefers sevenDaySonnet over sevenDayOpus when both subset windows are present (fixed precedence)", () => {
    const limits: SessionLimits = {
      ...EMPTY_LIMITS,
      sevenDaySonnet: rateLimit(55),
      sevenDayOpus: rateLimit(33),
    };

    expect(selectSummaryBars(limits)).toEqual([
      {
        title: SessionLimitWindowLabel.SevenDaySonnet,
        limit: limits.sevenDaySonnet,
      },
    ]);
  });

  it("ignores subset windows once a primary window bar exists", () => {
    const limits: SessionLimits = {
      ...EMPTY_LIMITS,
      sevenDay: rateLimit(20),
      sevenDaySonnet: rateLimit(55),
      sevenDayOpus: rateLimit(33),
    };

    expect(selectSummaryBars(limits)).toEqual([
      { title: SessionLimitWindowShortLabel.SevenDay, limit: limits.sevenDay },
    ]);
  });

  it("returns an extra-usage bar with a synthesized limit when enabled with a non-null utilization", () => {
    const limits: SessionLimits = {
      ...EMPTY_LIMITS,
      extraUsage: {
        isEnabled: true,
        monthlyLimitUsd: 100,
        usedCreditsUsd: 40,
        utilization: 40,
      },
    };

    expect(selectSummaryBars(limits)).toEqual([
      {
        title: SessionLimitWindowLabel.ExtraUsage,
        limit: { utilization: 40, resetsAt: null },
      },
    ]);
  });

  it("returns an empty array when extraUsage is disabled, even with a utilization value", () => {
    const limits: SessionLimits = {
      ...EMPTY_LIMITS,
      extraUsage: {
        isEnabled: false,
        monthlyLimitUsd: 100,
        usedCreditsUsd: 40,
        utilization: 40,
      },
    };

    expect(selectSummaryBars(limits)).toEqual([]);
  });

  it("returns an empty array when extraUsage is enabled but utilization is null", () => {
    const limits: SessionLimits = {
      ...EMPTY_LIMITS,
      extraUsage: {
        isEnabled: true,
        monthlyLimitUsd: null,
        usedCreditsUsd: null,
        utilization: null,
      },
    };

    expect(selectSummaryBars(limits)).toEqual([]);
  });

  it("returns an empty array when every window and extraUsage are absent", () => {
    expect(selectSummaryBars(EMPTY_LIMITS)).toEqual([]);
  });
});
