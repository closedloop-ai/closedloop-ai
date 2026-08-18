import { describe, expect, it, vi } from "vitest";
import type { CodexRateLimitWindowView } from "../../components/detail/detail-content";
import {
  formatCodexRateLimitWindow,
  formatCodexRateLimitWindowLabel,
  formatMinutesSpan,
} from "../codex-rate-limit-format";

const NOW_EPOCH_SECONDS = 1_800_000_000;

function windowFixture(
  overrides: Partial<CodexRateLimitWindowView> = {}
): CodexRateLimitWindowView {
  return {
    usedPercent: 42,
    windowMinutes: 300,
    resetsAtEpochSeconds: null,
    ...overrides,
  };
}

describe("formatMinutesSpan", () => {
  it.each([
    { minutes: -1, expected: "0m" },
    { minutes: 0.49, expected: "0m" },
    { minutes: 0.5, expected: "1m" },
    { minutes: 59.49, expected: "59m" },
    { minutes: 59.5, expected: "1h" },
    { minutes: 60, expected: "1h" },
    { minutes: 61, expected: "1h 1m" },
    { minutes: 1439, expected: "23h 59m" },
    { minutes: 1440, expected: "1d" },
    { minutes: 1501, expected: "1d 1h" },
    { minutes: 10_080, expected: "7d" },
  ])("formats $minutes minutes as $expected at minute/hour/day/week boundaries", ({
    minutes,
    expected,
  }) => {
    expect(formatMinutesSpan(minutes)).toBe(expected);
  });
});

describe("formatCodexRateLimitWindowLabel", () => {
  it("returns null when the duration is absent", () => {
    expect(formatCodexRateLimitWindowLabel(null)).toBeNull();
  });

  it("names exactly seven days as weekly", () => {
    expect(formatCodexRateLimitWindowLabel(10_080)).toBe("weekly");
  });

  it("keeps a non-week duration as components", () => {
    expect(formatCodexRateLimitWindowLabel(10_079)).toBe("6d 23h");
  });
});

describe("formatCodexRateLimitWindow", () => {
  it("omits a missing reset fragment without inventing reset timing", () => {
    expect(formatCodexRateLimitWindow(windowFixture(), NOW_EPOCH_SECONDS)).toBe(
      "42% used"
    );
  });

  it("omits a missing usage fragment while preserving a future reset", () => {
    expect(
      formatCodexRateLimitWindow(
        windowFixture({
          usedPercent: null,
          resetsAtEpochSeconds: NOW_EPOCH_SECONDS + 90 * 60,
        }),
        NOW_EPOCH_SECONDS
      )
    ).toBe("resets in 1h 30m");
  });

  it("clamps an elapsed reset to now", () => {
    expect(
      formatCodexRateLimitWindow(
        windowFixture({
          usedPercent: 88,
          resetsAtEpochSeconds: NOW_EPOCH_SECONDS - 10 * 60,
        }),
        NOW_EPOCH_SECONDS
      )
    ).toBe("88% used | resets now");
  });

  it.each([
    { secondsUntilReset: 59, expected: "resets now" },
    { secondsUntilReset: 60, expected: "resets in 1m" },
    { secondsUntilReset: 25 * 60 * 60, expected: "resets in 1d 1h" },
  ])("formats a reset $secondsUntilReset seconds away as $expected", ({
    secondsUntilReset,
    expected,
  }) => {
    expect(
      formatCodexRateLimitWindow(
        windowFixture({
          usedPercent: null,
          resetsAtEpochSeconds: NOW_EPOCH_SECONDS + secondsUntilReset,
        }),
        NOW_EPOCH_SECONDS
      )
    ).toBe(expected);
  });

  it("uses the injected clock instead of the ambient clock", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date((NOW_EPOCH_SECONDS + 86_400) * 1000));
      expect(
        formatCodexRateLimitWindow(
          windowFixture({
            resetsAtEpochSeconds: NOW_EPOCH_SECONDS + 2 * 60 * 60,
          }),
          NOW_EPOCH_SECONDS
        )
      ).toBe("42% used | resets in 2h");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads Date.now when no clock is injected", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(NOW_EPOCH_SECONDS * 1000));
      expect(
        formatCodexRateLimitWindow(
          windowFixture({
            resetsAtEpochSeconds: NOW_EPOCH_SECONDS + 90 * 60,
          })
        )
      ).toBe("42% used | resets in 1h 30m");
    } finally {
      vi.useRealTimers();
    }
  });
});
