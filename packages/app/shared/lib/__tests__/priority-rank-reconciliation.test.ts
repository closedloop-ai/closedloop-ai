import { Priority } from "@repo/api/src/types/common";
import {
  PRIORITY_ORDINAL as PRIORITY_WIRE_ORDINAL,
  PRIORITY_VALUES as PRIORITY_WIRE_VALUES,
  priorityOrdinal,
} from "@repo/api/src/types/search-query";
import {
  PRIORITY_VALUES_LOWEST_FIRST,
  priorityRank,
} from "@repo/design-system/lib/priority-order";
import { describe, expect, it } from "vitest";

/**
 * ISS-9439. Two packages own a priority number under the same name and in
 * opposite directions, and neither can import the other: the design system's
 * RANK ascends toward less urgent so a default ascending sort files URGENT
 * first, while the search grammar's ORDINAL ascends toward more urgent so
 * `:priority>=medium` reads as written. This file is the only place both are
 * visible, so it is where the invariant is pinned.
 */

// Pinned literally, not derived from either map — an expectation read from the
// maps it reconciles agrees with them by construction and can never fail.
const EXPECTED = [
  { member: "LOW", sortRank: 3, wireOrdinal: 0 },
  { member: "MEDIUM", sortRank: 2, wireOrdinal: 1 },
  { member: "HIGH", sortRank: 1, wireOrdinal: 2 },
  { member: "URGENT", sortRank: 0, wireOrdinal: 3 },
] as const;

describe("priority rank reconciliation", () => {
  it("covers exactly the persisted vocabulary", () => {
    expect(Object.values(Priority).sort()).toEqual(
      EXPECTED.map((row) => row.member).sort()
    );
  });

  it("holds each ordinal at its pinned value", () => {
    for (const { member, sortRank, wireOrdinal } of EXPECTED) {
      expect(priorityRank(member)).toBe(sortRank);
      expect(priorityOrdinal(member)).toBe(wireOrdinal);
    }
  });

  it("keeps the two directions exact inverses", () => {
    const highest = EXPECTED.length - 1;
    for (const { member } of EXPECTED) {
      expect(priorityRank(member) + (priorityOrdinal(member) ?? -1)).toBe(
        highest
      );
    }
  });

  it("offers every member in the menu order", () => {
    // The menu array is a side inventory of the enum: nothing in the type
    // system stops it being short, and a missing member is invisible on screen
    // rather than loud.
    expect([...PRIORITY_VALUES_LOWEST_FIRST].sort()).toEqual(
      Object.values(Priority).sort()
    );
  });

  it("offers every member to the search typeahead", () => {
    expect([...PRIORITY_WIRE_VALUES].sort()).toEqual(
      Object.values(Priority).sort()
    );
  });

  it("gives every member a wire ordinal", () => {
    // Without this the member parses as an unknown value and the SQL CASE maps
    // it to NULL, so `:priority>=medium` silently drops rows that hold it.
    expect(Object.keys(PRIORITY_WIRE_ORDINAL).sort()).toEqual(
      Object.values(Priority).sort()
    );
  });
});
