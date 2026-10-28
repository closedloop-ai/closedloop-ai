import { describe, expect, it } from "vitest";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  computeNextRetryAt,
} from "@/lib/github/github-retry-backoff";

const NOW = new Date("2026-08-03T12:00:00.000Z");

describe("computeNextRetryAt", () => {
  it("returns now + 30min for the first failure", () => {
    const result = computeNextRetryAt(1, NOW);
    expect(result.getTime()).toBe(NOW.getTime() + BACKOFF_BASE_MS);
  });

  it("doubles the delay for each subsequent failure", () => {
    expect(computeNextRetryAt(2, NOW).getTime()).toBe(
      NOW.getTime() + BACKOFF_BASE_MS * 2
    );
    expect(computeNextRetryAt(3, NOW).getTime()).toBe(
      NOW.getTime() + BACKOFF_BASE_MS * 4
    );
  });

  it("caps the delay at 24 hours at the boundary (count=7)", () => {
    const uncapped = BACKOFF_BASE_MS * 2 ** 6;
    expect(uncapped).toBeGreaterThan(BACKOFF_MAX_MS);
    const result = computeNextRetryAt(7, NOW);
    expect(result.getTime()).toBe(NOW.getTime() + BACKOFF_MAX_MS);
  });

  it("stays capped for counts far above the boundary", () => {
    const result = computeNextRetryAt(20, NOW);
    expect(result.getTime()).toBe(NOW.getTime() + BACKOFF_MAX_MS);
  });

  it("treats non-positive counts as the first failure", () => {
    expect(computeNextRetryAt(0, NOW).getTime()).toBe(
      NOW.getTime() + BACKOFF_BASE_MS
    );
    expect(computeNextRetryAt(-1, NOW).getTime()).toBe(
      NOW.getTime() + BACKOFF_BASE_MS
    );
  });

  it("pins the absolute backoff values: 30 min base, 24 h cap", () => {
    expect(BACKOFF_BASE_MS).toBe(1_800_000);
    expect(BACKOFF_MAX_MS).toBe(86_400_000);
  });
});
