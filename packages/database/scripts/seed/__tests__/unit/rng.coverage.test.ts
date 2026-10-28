import { describe, expect, it } from "vitest";
import {
  buildLongTailIndexSequence,
  createSeedRng,
  distributeLongTail,
} from "../../rng";

describe("seed rng — uncovered error and boundary branches", () => {
  it("throws when integer() is called with max < min", () => {
    const rng = createSeedRng("integer-bounds");
    expect(() => rng.integer(10, 5)).toThrow(
      "SeedRng.integer: max 5 must be >= min 10"
    );
  });

  it("throws when pick() is called with an empty array", () => {
    const rng = createSeedRng("pick-empty");
    expect(() => rng.pick([])).toThrow(
      "SeedRng.pick: values must not be empty"
    );
  });

  it("throws when distributeLongTail is called with zero or negative buckets", () => {
    expect(() => distributeLongTail(10, 0)).toThrow(
      "distributeLongTail: buckets must be positive"
    );
    expect(() => distributeLongTail(10, -1)).toThrow(
      "distributeLongTail: buckets must be positive"
    );
  });

  it("throws when distributeLongTail is called with a negative total", () => {
    expect(() => distributeLongTail(-1, 3)).toThrow(
      "distributeLongTail: total must be non-negative"
    );
  });

  it("returns an all-zero allocation array when total is zero", () => {
    expect(distributeLongTail(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it("returns an empty index sequence when total is zero", () => {
    expect(buildLongTailIndexSequence(0, 4)).toEqual([]);
  });

  it("expands a non-zero total into one repeated bucket index per allocated unit", () => {
    // distributeLongTail(3, 2) allocates [3, 0] (all weight to the head
    // bucket), so bucket 0 repeats 3 times and bucket 1 contributes nothing.
    expect(buildLongTailIndexSequence(3, 2)).toEqual([0, 0, 0]);
  });
});
