import { describe, expect, it } from "vitest";
import {
  FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS,
  FIXED_WINDOW_RATE_LIMIT_WINDOW_MS,
  FixedWindowRateLimiter,
  fixedWindowRetryAfterSeconds,
} from "./fixed-window-rate-limiter";

describe("FixedWindowRateLimiter", () => {
  it("allows exactly the request budget before denying the key", () => {
    const limiter = new FixedWindowRateLimiter({
      maxRequests: 3,
      windowMs: 100,
    });

    expect(limiter.attempt("key", 0)).toBe(true);
    expect(limiter.attempt("key", 1)).toBe(true);
    expect(limiter.attempt("key", 2)).toBe(true);
    expect(limiter.attempt("key", 3)).toBe(false);
    expect(limiter.attempt("key", 99)).toBe(false);
  });

  it("allows the key again exactly when its window resets", () => {
    const limiter = new FixedWindowRateLimiter({
      maxRequests: 1,
      windowMs: 100,
    });

    expect(limiter.attempt("key", 1000)).toBe(true);
    expect(limiter.attempt("key", 1099)).toBe(false);
    expect(limiter.attempt("key", 1100)).toBe(true);
    expect(limiter.attempt("key", 1101)).toBe(false);
  });

  it("prunes entries at their expiration boundary", () => {
    const limiter = new FixedWindowRateLimiter({
      maxEntries: 3,
      windowMs: 10,
    });

    limiter.attempt("expired", 0);
    limiter.attempt("unexpired", 1);
    limiter.attempt("new", 10);

    const entries = rateLimiterEntries(limiter);
    expect([...entries.keys()]).toEqual(["unexpired", "new"]);
    expect(entries.size).toBe(2);
  });

  it("evicts the oldest entry when distinct keys exceed the entry cap", () => {
    const limiter = new FixedWindowRateLimiter({
      maxEntries: 2,
      windowMs: 100,
    });

    limiter.attempt("first", 0);
    limiter.attempt("second", 0);
    limiter.attempt("third", 0);

    const entries = rateLimiterEntries(limiter);
    expect([...entries.keys()]).toEqual(["second", "third"]);
    expect(entries.size).toBe(2);
  });

  it("ISS-11946: charges the cost against the budget, up to exactly the max", () => {
    const limiter = new FixedWindowRateLimiter({
      maxRequests: 100,
      windowMs: 100,
    });

    expect(limiter.attempt("key", 0, 60)).toBe(true);
    expect(limiter.attempt("key", 1, 41)).toBe(false);
    expect(limiter.attempt("key", 2, 40)).toBe(true);
    expect(limiter.attempt("key", 3, 1)).toBe(false);
    expect(limiter.attempt("other", 3, 100)).toBe(true);
    expect(limiter.attempt("key", 100, 100)).toBe(true);
  });
});

function rateLimiterEntries(
  limiter: FixedWindowRateLimiter
): ReadonlyMap<string, unknown> {
  return (
    limiter as unknown as {
      entries: Map<string, unknown>;
    }
  ).entries;
}

describe("fixedWindowRetryAfterSeconds", () => {
  it("ISS-10014: rounds a non-second-aligned window UP to a whole delta-seconds value", () => {
    // RFC 9110 delta-seconds is an integer; `1.5` is unparseable to the desktop
    // and would be dropped, and `1` would name a wait shorter than the window.
    expect(fixedWindowRetryAfterSeconds(1500)).toBe(2);
    expect(fixedWindowRetryAfterSeconds(60_000)).toBe(60);
  });

  it("ISS-10014: never states zero, even for a sub-second window", () => {
    expect(fixedWindowRetryAfterSeconds(1)).toBe(1);
  });

  it("ISS-10014: the exported constant is the default window, rounded the same way", () => {
    expect(FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS).toBe(
      fixedWindowRetryAfterSeconds(FIXED_WINDOW_RATE_LIMIT_WINDOW_MS)
    );
  });
});
