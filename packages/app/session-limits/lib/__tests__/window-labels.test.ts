import { describe, expect, it } from "vitest";
import {
  SessionLimitWindowLabel,
  SessionLimitWindowShortLabel,
} from "../window-labels";

describe("SessionLimitWindowLabel", () => {
  it("has a non-empty full label for every window key", () => {
    const keys = [
      "FiveHour",
      "SevenDay",
      "SevenDaySonnet",
      "SevenDayOpus",
      "ExtraUsage",
    ] as const;

    for (const key of keys) {
      expect(typeof SessionLimitWindowLabel[key]).toBe("string");
      expect(SessionLimitWindowLabel[key].length).toBeGreaterThan(0);
    }
  });

  it("pins the exact full-label wording", () => {
    expect(SessionLimitWindowLabel).toEqual({
      FiveHour: "Current session (5 hours)",
      SevenDay: "Current week, all models",
      SevenDaySonnet: "Current week, Sonnet",
      SevenDayOpus: "Current week, Opus",
      ExtraUsage: "Extra usage",
    });
  });
});

describe("SessionLimitWindowShortLabel", () => {
  it("only defines short forms for FiveHour and SevenDay", () => {
    expect(Object.keys(SessionLimitWindowShortLabel).sort()).toEqual([
      "FiveHour",
      "SevenDay",
    ]);
  });

  it("has a non-empty short label for each of its keys", () => {
    for (const value of Object.values(SessionLimitWindowShortLabel)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("pins the exact short-label wording", () => {
    expect(SessionLimitWindowShortLabel).toEqual({
      FiveHour: "Current session",
      SevenDay: "Current week",
    });
  });

  it("is a prefix of the corresponding full label for each shortened window", () => {
    expect(
      SessionLimitWindowLabel.FiveHour.startsWith(
        SessionLimitWindowShortLabel.FiveHour
      )
    ).toBe(true);
    expect(
      SessionLimitWindowLabel.SevenDay.startsWith(
        SessionLimitWindowShortLabel.SevenDay
      )
    ).toBe(true);
  });
});
