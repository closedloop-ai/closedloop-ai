/**
 * ISS-9665 — the flag-OFF path renders exactly what shipped.
 *
 * The API now reports an unset priority honestly, so the ONLY thing standing
 * between a rolled-back flag and a screen full of blanks is this substitution.
 * It is applied to the row model rather than at the cell so the priority cell,
 * the "No priority" group header, the constant-column collapse rule and the sort
 * comparator cannot end up describing one row two different ways.
 */
import { Priority } from "@repo/api/src/types/common";
import { describe, expect, test } from "vitest";
import {
  priorityDisplayFallback,
  withPriorityDisplayFallback,
} from "../priority-display-fallback";

const UNSET = { id: "a", priority: null } as const;
const URGENT = { id: "b", priority: Priority.Urgent } as const;

describe("withPriorityDisplayFallback", () => {
  test("substitutes the retired coercion's value for an unset priority", () => {
    // MEDIUM specifically, because that is the literal `toDocument` folded to.
    // Written out rather than read from `DEFAULT_PRIORITY` so a change to that
    // constant surfaces here instead of silently redefining "what shipped".
    expect(withPriorityDisplayFallback([UNSET])).toEqual([
      { id: "a", priority: Priority.Medium },
    ]);
  });

  test("leaves a row that HAS a priority untouched, object identity included", () => {
    // The sibling: a helper that rebuilt every row would pass the case above
    // and quietly break the memoized row identity the tables depend on.
    const rows = [URGENT];
    const result = withPriorityDisplayFallback(rows);

    expect(result[0]).toBe(URGENT);
    expect(result[0].priority).toBe(Priority.Urgent);
  });

  test("carries every other field of a substituted row through unchanged", () => {
    const row = {
      id: "c",
      priority: null,
      title: "Keep me",
      assigneeId: "user-1",
    };

    expect(withPriorityDisplayFallback([row])).toEqual([
      {
        id: "c",
        priority: Priority.Medium,
        title: "Keep me",
        assigneeId: "user-1",
      },
    ]);
  });

  test("does not mutate its input", () => {
    const rows = [{ id: "d", priority: null }];
    withPriorityDisplayFallback(rows);

    expect(rows[0].priority).toBe(null);
  });
});

describe("priorityDisplayFallback (single row)", () => {
  test("agrees with the array form on both an unset and a set row", () => {
    // The two forms exist because some surfaces hold a list and some hold one
    // artifact; a screen where the list said MEDIUM and the detail row said
    // nothing would be the ISS-9665 defect reintroduced on the client.
    // No cast: any row carrying the field qualifies, a project included
    // (ISS-9441).
    expect(priorityDisplayFallback({ ...UNSET })).toEqual({
      id: "a",
      priority: Priority.Medium,
    });
    expect(priorityDisplayFallback({ ...URGENT })).toEqual({
      id: "b",
      priority: Priority.Urgent,
    });
  });
});
