import { describe, expect, it } from "vitest";
import { createConcurrencyLimiter } from "../concurrency-limiter";

describe("createConcurrencyLimiter", () => {
  it("grants up to `max` slots then refuses", () => {
    const limiter = createConcurrencyLimiter(2);
    expect(limiter.max).toBe(2);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.inFlight()).toBe(2);
    // At capacity: refuse without changing the count.
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.inFlight()).toBe(2);
  });

  it("frees a slot on release so a later acquire succeeds", () => {
    const limiter = createConcurrencyLimiter(1);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    limiter.release();
    expect(limiter.inFlight()).toBe(0);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it("never drops below zero on over-release (no phantom capacity)", () => {
    const limiter = createConcurrencyLimiter(2);
    limiter.release();
    limiter.release();
    expect(limiter.inFlight()).toBe(0);
    // Still only `max` slots available, not more.
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it.each([
    0,
    -5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("clamps a non-positive/non-finite max (%s) to at least 1 so it is never a no-op", (bad) => {
    const limiter = createConcurrencyLimiter(bad as number);
    expect(limiter.max).toBe(1);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it("floors a fractional max", () => {
    const limiter = createConcurrencyLimiter(2.9);
    expect(limiter.max).toBe(2);
  });
});
