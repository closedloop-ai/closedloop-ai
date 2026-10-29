import { TablePriority } from "@closedloop-ai/design-system/components/ui/table-cell-semantic-primitives";
import {
  comparePriorityByRank,
  isPriorityValue,
  PRIORITY_LABEL_NONE,
  PRIORITY_LABEL_UNKNOWN,
  PRIORITY_LABELS,
  PRIORITY_ORDINAL,
  PRIORITY_RANK_NONE,
  PRIORITY_VALUES_HIGHEST_FIRST,
  PRIORITY_VALUES_LOWEST_FIRST,
  priorityLabel,
  priorityRank,
} from "@closedloop-ai/design-system/lib/vocabulary/priority-order";
import { describe, expect, it } from "vitest";

// Pinned literally, not read from the module under test: an expectation taken
// from the array it polices cannot fail when that array is reordered.
const EXPECTED_ORDER_HIGHEST_FIRST = ["URGENT", "HIGH", "MEDIUM", "LOW"];

// Already lexicographic, so a comparator falling back to the value spelling
// returns it unchanged.
const ALPHABETICAL_ORDER = ["HIGH", "LOW", "MEDIUM", "URGENT"] as const;

describe("priority semantic order", () => {
  it("declares the whole vocabulary most urgent first", () => {
    expect([...PRIORITY_VALUES_HIGHEST_FIRST]).toEqual(
      EXPECTED_ORDER_HIGHEST_FIRST
    );
  });

  it("declares the menu order lowest first", () => {
    expect([...PRIORITY_VALUES_LOWEST_FIRST]).toEqual([
      "LOW",
      "MEDIUM",
      "HIGH",
      "URGENT",
    ]);
  });

  it("ranks exactly the declared priority values", () => {
    expect(Object.keys(PRIORITY_ORDINAL).sort()).toEqual(
      [...PRIORITY_VALUES_HIGHEST_FIRST].sort()
    );
  });

  it("re-orders a lexicographically sorted input into semantic rank", () => {
    expect([...ALPHABETICAL_ORDER].sort(comparePriorityByRank)).toEqual(
      EXPECTED_ORDER_HIGHEST_FIRST
    );
  });

  it("ranks URGENT above HIGH in both directions", () => {
    expect(priorityRank("URGENT")).toBeLessThan(priorityRank("HIGH"));
    expect(comparePriorityByRank("URGENT", "HIGH")).toBeLessThan(0);
    expect(comparePriorityByRank("HIGH", "URGENT")).toBeGreaterThan(0);
    expect(comparePriorityByRank("URGENT", "URGENT")).toBe(0);
  });

  it("files an unset priority after every ranked value", () => {
    expect(priorityRank(null)).toBe(PRIORITY_RANK_NONE);
    expect(priorityRank(undefined)).toBe(PRIORITY_RANK_NONE);
    for (const value of PRIORITY_VALUES_HIGHEST_FIRST) {
      expect(priorityRank(value)).toBeLessThan(PRIORITY_RANK_NONE);
    }
    expect(
      ["LOW", null, "URGENT", "HIGH", "MEDIUM"].sort(comparePriorityByRank)
    ).toEqual(["URGENT", "HIGH", "MEDIUM", "LOW", null]);
  });

  it("spells labels lowest-first, the order menus render them in", () => {
    expect(Object.keys(PRIORITY_LABELS)).toEqual([
      "LOW",
      "MEDIUM",
      "HIGH",
      "URGENT",
    ]);
    expect({ ...PRIORITY_LABELS }).toEqual({
      LOW: "Low",
      MEDIUM: "Medium",
      HIGH: "High",
      URGENT: "Urgent",
    });
  });

  it("labels a ranked value from the map and an unset one explicitly", () => {
    expect(priorityLabel("URGENT")).toBe("Urgent");
    expect(priorityLabel(null)).toBe(PRIORITY_LABEL_NONE);
    expect(priorityLabel("CRITICAL")).toBe(PRIORITY_LABEL_UNKNOWN);
  });

  it("narrows only the ranked vocabulary", () => {
    expect(isPriorityValue("URGENT")).toBe(true);
    expect(isPriorityValue("LOW")).toBe(true);
    expect(isPriorityValue("no-priority")).toBe(false);
    expect(isPriorityValue("")).toBe(false);
    expect(isPriorityValue("urgent")).toBe(false);
    // `Object.hasOwn`, not `in`: the latter answers true for prototype keys.
    expect(isPriorityValue("toString")).toBe(false);
  });

  it("ranks an unrecognised value as unset and labels it unknown", () => {
    expect(priorityRank("CRITICAL")).toBe(PRIORITY_RANK_NONE);
    expect(priorityLabel("CRITICAL")).toBe(PRIORITY_LABEL_UNKNOWN);
    expect(priorityLabel(null)).toBe(PRIORITY_LABEL_NONE);
  });

  // `TablePriority`'s `satisfies` clause constrains its values but cannot
  // require it to cover the vocabulary, so a dropped accessor is caught here.
  it("exposes a named accessor for every ranked value", () => {
    expect(Object.values(TablePriority).sort()).toEqual(
      [...PRIORITY_VALUES_HIGHEST_FIRST].sort()
    );
  });
});
