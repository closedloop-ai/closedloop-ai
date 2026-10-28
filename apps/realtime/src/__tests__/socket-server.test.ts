import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PING_TIMEOUT_MS,
  isAllowedOrigin,
  MAX_PING_TIMEOUT_MS,
  MIN_PING_TIMEOUT_MS,
  PING_TIMEOUT_CLAMPED_EVENT,
  resolvePingTimeoutMs,
} from "../edge/socket-server";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolvePingTimeoutMs", () => {
  it("uses the default when unset", () => {
    expect(resolvePingTimeoutMs(undefined)).toBe(DEFAULT_PING_TIMEOUT_MS);
  });

  it("keeps a value at or above the floor without warning", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(resolvePingTimeoutMs(MIN_PING_TIMEOUT_MS)).toBe(MIN_PING_TIMEOUT_MS);
    expect(warn).not.toHaveBeenCalled();
  });

  it("raises a value below the floor to it, with a warning", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(resolvePingTimeoutMs(MIN_PING_TIMEOUT_MS - 1)).toBe(
      MIN_PING_TIMEOUT_MS
    );
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: PING_TIMEOUT_CLAMPED_EVENT,
        value: MIN_PING_TIMEOUT_MS - 1,
        floorMs: MIN_PING_TIMEOUT_MS,
      })
    );
  });

  it("lowers a value above the timer ceiling to it, with a warning", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(resolvePingTimeoutMs(MAX_PING_TIMEOUT_MS)).toBe(MAX_PING_TIMEOUT_MS);
    expect(warn).not.toHaveBeenCalled();
    expect(resolvePingTimeoutMs(MAX_PING_TIMEOUT_MS + 1)).toBe(
      MAX_PING_TIMEOUT_MS
    );
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: PING_TIMEOUT_CLAMPED_EVENT,
        value: MAX_PING_TIMEOUT_MS + 1,
        ceilingMs: MAX_PING_TIMEOUT_MS,
      })
    );
  });
});

describe("isAllowedOrigin", () => {
  const allowed = ["https://app.example.test"];

  it("allows a request with no Origin, as desktop's main process sends none", () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
  });

  it("allows only an exact allow-list match otherwise", () => {
    expect(isAllowedOrigin("https://app.example.test", allowed)).toBe(true);
    expect(isAllowedOrigin("https://app.example.test.evil", allowed)).toBe(
      false
    );
    expect(isAllowedOrigin("null", allowed)).toBe(false);
  });
});
