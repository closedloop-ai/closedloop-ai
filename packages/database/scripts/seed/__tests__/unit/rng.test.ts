import { describe, expect, it } from "vitest";
import { createSeedRng, distributeLongTail, seedDate } from "../../rng";

describe("seed rng", () => {
  it("repeats deterministic values for the same seed", () => {
    const first = createSeedRng("fixed-seed");
    const second = createSeedRng("fixed-seed");
    expect([first.next(), first.next(), first.integer(1, 10)]).toEqual([
      second.next(),
      second.next(),
      second.integer(1, 10),
    ]);
  });

  it("allocates long-tail distributions with a larger head bucket", () => {
    const allocation = distributeLongTail(100, 5);
    expect(allocation.reduce((sum, count) => sum + count, 0)).toBe(100);
    expect(allocation[0]).toBeGreaterThan(allocation[4]);
  });

  it("derives dates from the fixed seed clock", () => {
    expect(
      seedDate(
        { baseDate: new Date("2026-01-01T00:00:00.000Z") },
        1000
      ).toISOString()
    ).toBe("2026-01-01T00:00:01.000Z");
  });
});
