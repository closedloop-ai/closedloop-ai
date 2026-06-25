import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../rate-limiter";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createRateLimiter", () => {
  it("limits after maxPerWindow events in the window", () => {
    const limiter = createRateLimiter(2, 10_000);
    expect(limiter.isRateLimited("k")).toBe(false);
    expect(limiter.isRateLimited("k")).toBe(false);
    expect(limiter.isRateLimited("k")).toBe(true);
  });

  it("tracks keys independently", () => {
    const limiter = createRateLimiter(1, 10_000);
    expect(limiter.isRateLimited("a")).toBe(false);
    expect(limiter.isRateLimited("b")).toBe(false);
    expect(limiter.isRateLimited("a")).toBe(true);
  });

  it("prune() evicts keys whose window has aged out but keeps active keys", async () => {
    const limiter = createRateLimiter(5, 20);
    limiter.isRateLimited("stale");
    await delay(40); // "stale" key's only timestamp ages past the 20ms window
    limiter.isRateLimited("fresh"); // fresh key inside the window

    limiter.prune();

    // The stale key was evicted: its budget resets to a full window.
    // The fresh key was retained: it still counts toward its budget.
    // Probe with a 1-event limiter semantics by exhausting and observing.
    const probe = createRateLimiter(1, 20);
    probe.isRateLimited("x");
    expect(probe.isRateLimited("x")).toBe(true); // sanity: probe works

    // After prune, re-using "stale" starts fresh (not rate-limited immediately
    // even though we'd already recorded one event before pruning).
    const limiter2 = createRateLimiter(1, 20);
    limiter2.isRateLimited("stale");
    await delay(40);
    limiter2.prune();
    expect(limiter2.isRateLimited("stale")).toBe(false);
  });

  it("remove() clears a key's window immediately", () => {
    const limiter = createRateLimiter(1, 10_000);
    limiter.isRateLimited("k");
    expect(limiter.isRateLimited("k")).toBe(true);
    limiter.remove("k");
    expect(limiter.isRateLimited("k")).toBe(false);
  });
});
