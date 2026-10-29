import { Priority } from "@repo/api/src/types/common";
import { PRIORITY_VALUES_HIGHEST_FIRST } from "@repo/design-system/lib/priority-order";
import { describe, expect, it } from "vitest";
import {
  comparePriorityValues,
  comparePriorityValuesForSort,
} from "../priority-sort";
import { type SortConfig, sortTableData } from "../table-utils";

describe("comparePriorityValues", () => {
  it("returns 0 when both priorities are absent", () => {
    expect(comparePriorityValues(null, null)).toBe(0);
    expect(comparePriorityValues(undefined, undefined)).toBe(0);
    expect(comparePriorityValues(null, undefined)).toBe(0);
  });

  it("sorts an absent priority after a present one", () => {
    expect(comparePriorityValues(null, Priority.Low)).toBeGreaterThan(0);
    expect(comparePriorityValues(undefined, Priority.Urgent)).toBeGreaterThan(
      0
    );
  });

  it("sorts a present priority before an absent one", () => {
    expect(comparePriorityValues(Priority.Low, null)).toBeLessThan(0);
    expect(comparePriorityValues(Priority.Urgent, undefined)).toBeLessThan(0);
  });

  it("orders Urgent < High < Medium < Low (negative means a sorts first)", () => {
    expect(comparePriorityValues(Priority.Urgent, Priority.Low)).toBeLessThan(
      0
    );
    expect(
      comparePriorityValues(Priority.Low, Priority.Urgent)
    ).toBeGreaterThan(0);
    expect(comparePriorityValues(Priority.High, Priority.Medium)).toBeLessThan(
      0
    );
  });

  it("returns 0 for equal priorities", () => {
    expect(comparePriorityValues(Priority.Medium, Priority.Medium)).toBe(0);
  });

  // Seeded in lexicographic order — what a comparator reading the value
  // spelling rather than its rank would hand back untouched.
  it("orders the raw persisted values most urgent first", () => {
    const alphabetical = ["HIGH", "LOW", "MEDIUM", "URGENT"] as const;

    expect([...alphabetical].sort(comparePriorityValues)).toEqual([
      "URGENT",
      "HIGH",
      "MEDIUM",
      "LOW",
    ]);
  });

  it("sorts a list highest-priority-first with absent values last", () => {
    const sorted = [
      Priority.Low,
      null,
      Priority.Urgent,
      Priority.Medium,
      undefined,
      Priority.High,
    ].sort(comparePriorityValues);

    expect(sorted).toEqual([
      Priority.Urgent,
      Priority.High,
      Priority.Medium,
      Priority.Low,
      null,
      undefined,
    ]);
  });

  // The design system cannot import `Priority`, so it re-spells the vocabulary
  // and no annotation catches the two sets diverging. Compare them directly:
  // a value ranked but not persisted becomes selectable in the priority editor
  // and is written through an API that never declared it.
  it("ranks exactly the values the persisted enum declares", () => {
    expect([...PRIORITY_VALUES_HIGHEST_FIRST].sort()).toEqual(
      Object.values(Priority).sort()
    );
  });
  it("keeps absent priorities last through sortTableData in both directions", () => {
    type Row = { id: string; priority: Priority | null };
    const rows: Row[] = [
      { id: "none", priority: null },
      { id: "low", priority: Priority.Low },
      { id: "urgent", priority: Priority.Urgent },
      { id: "medium", priority: Priority.Medium },
    ];
    const configs: Record<string, SortConfig<Row>> = {
      priority: {
        key: "priority",
        directedComparator: (a, b, direction) =>
          comparePriorityValuesForSort(a.priority, b.priority, direction),
      },
    };

    expect(
      sortTableData(rows, "priority", configs, "asc").map((r) => r.id)
    ).toEqual(["urgent", "medium", "low", "none"]);
    expect(
      sortTableData(rows, "priority", configs, "desc").map((r) => r.id)
    ).toEqual(["low", "medium", "urgent", "none"]);
  });
});
