import { describe, expect, it } from "vitest";
import { formatDurationMs } from "../format-duration-ms";

describe("formatDurationMs", () => {
  it("renders an em dash for null", () => {
    expect(formatDurationMs(null)).toBe("—");
  });

  it("renders sub-second values in milliseconds", () => {
    expect(formatDurationMs(0)).toBe("0ms");
    expect(formatDurationMs(1)).toBe("1ms");
    expect(formatDurationMs(999)).toBe("999ms");
  });

  it("renders sub-minute values in seconds with one decimal", () => {
    expect(formatDurationMs(1000)).toBe("1.0s");
    expect(formatDurationMs(1500)).toBe("1.5s");
    expect(formatDurationMs(30_000)).toBe("30.0s");
    // 59_999ms rounds up to 60.0s at one decimal (still the seconds branch).
    expect(formatDurationMs(59_999)).toBe("60.0s");
  });

  it("renders minute-plus values as minutes and seconds", () => {
    expect(formatDurationMs(60_000)).toBe("1m 0s");
    expect(formatDurationMs(90_000)).toBe("1m 30s");
    expect(formatDurationMs(119_000)).toBe("1m 59s");
    expect(formatDurationMs(3_661_000)).toBe("61m 1s");
  });

  it("rounds the remaining seconds within the minute branch", () => {
    // 1500ms remainder rounds to 2s.
    expect(formatDurationMs(61_500)).toBe("1m 2s");
  });

  it("carries a rounded-up sub-minute remainder into the minute", () => {
    // 119_500ms: the 59.5s remainder must carry to 2m 0s, never render "1m 60s".
    expect(formatDurationMs(119_500)).toBe("2m 0s");
    expect(formatDurationMs(119_900)).toBe("2m 0s");
    // Just below the carry threshold stays within the same minute.
    expect(formatDurationMs(119_400)).toBe("1m 59s");
  });
});
