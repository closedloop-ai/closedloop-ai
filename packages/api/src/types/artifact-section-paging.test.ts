import { describe, expect, it } from "vitest";
import {
  packSectionsIntoPages,
  planSectionPages,
  type SectionSize,
} from "./artifact-section-paging.ts";

const section = (
  key: string,
  count: number
): { key: string; ids: string[] } => ({
  key,
  ids: Array.from({ length: count }, (_, index) => `${key}${index + 1}`),
});

const pageIds = (
  sections: Array<{ key: string; ids: string[] }>,
  size: number
) => packSectionsIntoPages(sections, size).pages.map((page) => page.ids);

/**
 * `size` enters as `unknown` so a `bigint` reaches the planner. `SectionSize`
 * declares `number`, but `apps/api` plans from a raw `count(*)`, which is the
 * boundary these cases exist for.
 */
const rawSized = (key: string, size: unknown): SectionSize => ({
  key,
  size: size as number,
});

const UNCOUNTABLE_SIZES: Array<{ label: string; size: unknown }> = [
  { label: "NaN", size: Number.NaN },
  { label: "Infinity", size: Number.POSITIVE_INFINITY },
  { label: "fractional", size: 2.5 },
  { label: "negative", size: -3 },
  { label: "past the safe integers", size: Number.MAX_SAFE_INTEGER + 2 },
  { label: "bigint", size: 3n },
];

describe("planSectionPages", () => {
  it("keeps a section that exactly fills the remaining space on the open page", () => {
    // The boundary is `>`, not `>=`: 2 + 2 is not MORE than 4, so `b` belongs
    // on the page `a` opened. A `>=` here splits a page that was exactly full
    // and every later page shifts, which no other case in this file detects.
    expect(pageIds([section("a", 2), section("b", 2)], 4)).toEqual([
      ["a1", "a2", "b1", "b2"],
    ]);
  });

  it("opens a new page for a section that would overflow the open one", () => {
    expect(pageIds([section("a", 3), section("b", 2)], 4)).toEqual([
      ["a1", "a2", "a3"],
      ["b1", "b2"],
    ]);
  });

  it("spills only a section larger than a page, marking each spill continued", () => {
    const plan = packSectionsIntoPages([section("a", 5)], 2);
    expect(plan.pages.map((page) => page.ids)).toEqual([
      ["a1", "a2"],
      ["a3", "a4"],
      ["a5"],
    ]);
    expect(plan.pages.map((page) => [...page.continuedSectionKeys])).toEqual([
      [],
      ["a"],
      ["a"],
    ]);
  });

  it("reports each section's full size, not the slice a page took", () => {
    const plan = packSectionsIntoPages([section("a", 5), section("b", 1)], 2);
    expect(plan.sectionTotals.get("a")).toBe(5);
    expect(plan.sectionTotals.get("b")).toBe(1);
  });

  it("records an empty section's total and gives it no slice", () => {
    const plan = planSectionPages([{ key: "a", size: 0 }], 4);
    expect(plan.sectionTotals.get("a")).toBe(0);
    expect(plan.pages).toEqual([]);
  });

  it("floors a non-positive page size at one row rather than looping", () => {
    expect(pageIds([section("a", 2)], 0)).toEqual([["a1"], ["a2"]]);
  });

  it("slices each section at the offset the plan assigned it", () => {
    const plan = planSectionPages([{ key: "a", size: 3 }], 2);
    expect(plan.pages.map((page) => page.slices)).toEqual([
      [{ key: "a", skip: 0, take: 2 }],
      [{ key: "a", skip: 2, take: 1 }],
    ]);
  });
});

describe("planSectionPages input validation", () => {
  it("throws on two sections sharing one key instead of paging the last one's rows for both", () => {
    expect(() =>
      packSectionsIntoPages(
        [
          { ids: ["a1", "a2"], key: "dupe" },
          { ids: ["b1", "b2", "b3"], key: "dupe" },
        ],
        4
      )
    ).toThrow('duplicate section key "dupe"');
  });

  it("pages the same two sections once their keys differ", () => {
    // Positive control for the throw above: identical shape, distinct keys, so
    // a guard that fired on every multi-section call would fail here.
    const plan = packSectionsIntoPages(
      [
        { ids: ["a1", "a2"], key: "first" },
        { ids: ["b1", "b2", "b3"], key: "second" },
      ],
      4
    );
    expect(plan.pages.map((page) => page.ids)).toEqual([
      ["a1", "a2"],
      ["b1", "b2", "b3"],
    ]);
    expect([...plan.sectionTotals]).toEqual([
      ["first", 2],
      ["second", 3],
    ]);
  });

  it.each(UNCOUNTABLE_SIZES)("throws on a $label size", ({ size }) => {
    expect(() => planSectionPages([rawSized("a", size)], 4)).toThrow(
      'section "a" size must be a non-negative safe integer'
    );
  });
});
