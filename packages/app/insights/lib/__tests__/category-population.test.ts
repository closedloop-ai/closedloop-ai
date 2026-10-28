import type {
  CategoryBucket,
  CategoryPopulation,
} from "@closedloop-ai/loops-api/insights";
import { describe, expect, it } from "vitest";
import { categoryPopulation } from "../category-population";

/**
 * ISS-9842: the reader of the `population` a capped breakdown carries. Every
 * rejection below is a payload the desktop producer cannot emit today; they are
 * pinned because the field crosses IPC and a wire boundary, where the type
 * does not constrain what arrives.
 */

const POPULATION: CategoryPopulation = { total: 100, categories: 9 };

function bucket(
  key: string,
  value: number,
  population: CategoryPopulation = POPULATION
): CategoryBucket {
  return { key, label: key, value, population };
}

/** A bucket as an uncapped producer emits it: no population at all. */
function bareBucket(key: string, value: number): CategoryBucket {
  return { key, label: key, value };
}

// Four of nine categories, summing to 70 of 100: five omitted categories with
// 30 units between them, so the population is consistent with the prefix.
const PREFIX = [
  bucket("bash", 30),
  bucket("read", 20),
  bucket("edit", 12),
  bucket("grep", 8),
];
const PREFIX_SUM = 70;

const IMPOSSIBLE_COUNTS = [
  ["fractional", 1.5],
  ["negative", -1],
  ["NaN", Number.NaN],
  ["infinite", Number.POSITIVE_INFINITY],
  ["past the safe-integer range", 2 ** 53],
] as const;

describe("categoryPopulation (ISS-9842)", () => {
  it("returns the population every bucket agrees on", () => {
    expect(categoryPopulation(PREFIX)).toEqual(POPULATION);
  });

  it("returns undefined for an empty list", () => {
    expect(categoryPopulation([])).toBeUndefined();
  });

  it("returns undefined when any bucket lacks it", () => {
    const buckets = [...PREFIX.slice(0, 3), bareBucket("grep", 8)];
    expect(categoryPopulation(buckets)).toBeUndefined();
  });

  it("returns undefined when the buckets disagree", () => {
    const buckets = [
      ...PREFIX.slice(0, 3),
      bucket("grep", 8, { total: 101, categories: 9 }),
    ];
    expect(categoryPopulation(buckets)).toBeUndefined();
  });

  it.each(IMPOSSIBLE_COUNTS)(
    "returns undefined for a %s total",
    (_name, total) => {
      const buckets = PREFIX.map((entry) =>
        bucket(entry.key, entry.value, { total, categories: 9 })
      );
      expect(categoryPopulation(buckets)).toBeUndefined();
    }
  );

  it.each(IMPOSSIBLE_COUNTS)(
    "returns undefined for a %s category count",
    (_name, categories) => {
      const buckets = PREFIX.map((entry) =>
        bucket(entry.key, entry.value, { total: 100, categories })
      );
      expect(categoryPopulation(buckets)).toBeUndefined();
    }
  );

  it.each(IMPOSSIBLE_COUNTS)(
    "returns undefined for a %s bucket value",
    (_name, value) => {
      const buckets = [...PREFIX.slice(0, 3), bucket("grep", value)];
      expect(categoryPopulation(buckets)).toBeUndefined();
    }
  );

  it("returns undefined when impossible bucket values offset to a plausible slice sum", () => {
    // 80 + -10 = 70 leaves 30 units for seven omitted categories, so every
    // prefix check passes; only the per-value check can reject it.
    const buckets = [bucket("bash", 80), bucket("read", -10)];
    expect(categoryPopulation(buckets)).toBeUndefined();
  });

  it("returns undefined when there are fewer categories than buckets", () => {
    const buckets = PREFIX.map((entry) =>
      bucket(entry.key, entry.value, { total: 100, categories: 3 })
    );
    expect(categoryPopulation(buckets)).toBeUndefined();
  });

  it("returns undefined when every category is present but the total is not the slice sum", () => {
    // The shape that would render an "Other tools (0)" wedge: nothing is
    // omitted, yet the total claims units the slices do not account for.
    const buckets = PREFIX.map((entry) =>
      bucket(entry.key, entry.value, { total: PREFIX_SUM + 1, categories: 4 })
    );
    expect(categoryPopulation(buckets)).toBeUndefined();
  });

  it("returns the population when every category is present and the total is the slice sum", () => {
    const whole = { total: PREFIX_SUM, categories: 4 };
    const buckets = PREFIX.map((entry) =>
      bucket(entry.key, entry.value, whole)
    );
    expect(categoryPopulation(buckets)).toEqual(whole);
  });

  it("returns undefined when the omitted categories cannot fit in the remainder", () => {
    // Five omitted categories need at least five units; 74 leaves four.
    const buckets = PREFIX.map((entry) =>
      bucket(entry.key, entry.value, { total: PREFIX_SUM + 4, categories: 9 })
    );
    expect(categoryPopulation(buckets)).toBeUndefined();
  });

  it("accepts the minimal remainder of one unit per omitted category", () => {
    const minimal = { total: PREFIX_SUM + 5, categories: 9 };
    const buckets = PREFIX.map((entry) =>
      bucket(entry.key, entry.value, minimal)
    );
    expect(categoryPopulation(buckets)).toEqual(minimal);
  });
});
