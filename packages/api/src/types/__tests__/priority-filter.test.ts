import { describe, expect, it } from "vitest";
import { Priority } from "../common";
import {
  matchesPriorityFilter,
  PRIORITY_FILTER_VALUES,
  splitPriorityFilter,
} from "../priority-filter";
import { PRIORITY_UNSET_VALUE } from "../search-query";

describe("priority filter (ISS-10332)", () => {
  it("offers every priority member low to high, then the unset token", () => {
    expect(PRIORITY_FILTER_VALUES).toEqual([
      Priority.Low,
      Priority.Medium,
      Priority.High,
      Priority.Urgent,
      PRIORITY_UNSET_VALUE,
    ]);
  });

  it("splits a selection into de-duplicated members and the unset arm", () => {
    expect(
      splitPriorityFilter([
        Priority.High,
        PRIORITY_UNSET_VALUE,
        Priority.High,
        Priority.Low,
      ])
    ).toEqual({ members: [Priority.High, Priority.Low], includesUnset: true });
    expect(splitPriorityFilter([Priority.Urgent])).toEqual({
      members: [Priority.Urgent],
      includesUnset: false,
    });
    expect(splitPriorityFilter(undefined)).toEqual({
      members: [],
      includesUnset: false,
    });
  });

  it("matches a row: empty admits all, unset matches null but NOT an omitted priority, a member matches only itself", () => {
    expect(matchesPriorityFilter(Priority.Low, undefined)).toBe(true);
    expect(matchesPriorityFilter(null, [])).toBe(true);

    expect(matchesPriorityFilter(null, [PRIORITY_UNSET_VALUE])).toBe(true);
    // Omitted is "this producer does not know", which no arm may claim.
    expect(matchesPriorityFilter(undefined, [PRIORITY_UNSET_VALUE])).toBe(
      false
    );
    expect(matchesPriorityFilter(undefined, [Priority.Low])).toBe(false);
    expect(matchesPriorityFilter(undefined, [])).toBe(true);
    expect(matchesPriorityFilter(Priority.Low, [PRIORITY_UNSET_VALUE])).toBe(
      false
    );

    expect(matchesPriorityFilter(Priority.Low, [Priority.Low])).toBe(true);
    expect(matchesPriorityFilter(Priority.High, [Priority.Low])).toBe(false);
    expect(matchesPriorityFilter(null, [Priority.Low])).toBe(false);
  });
});
