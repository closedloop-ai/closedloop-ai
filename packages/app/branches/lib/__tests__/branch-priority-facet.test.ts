import { Priority } from "@repo/api/src/types/common";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { branchRow as row } from "@repo/app/branches/lib/__tests__/branch-row-fixture";
import { PRIORITY_LABEL_NONE } from "@repo/design-system/lib/priority-order";
import { describe, expect, it, vi } from "vitest";
import { branchFilterFacetGroups } from "../branch-filter-adapter";
import { BranchFilterFacet, DEFAULT_BRANCH_FILTERS } from "../branch-row";

/**
 * ISS-10332 (visual QA, 2026-09-22): the Branches priority facet lists exactly
 * the values its caller resolved, in the caller's order. The ORDER is the one
 * every priority menu offers and "No priority" rides the same key that gates
 * the editor's clear item, both resolved in `useBranchToolbarFacetGroups` —
 * so this builder must hold no vocabulary of its own that could drift from
 * the editor one click away.
 */

const HIGHEST_FIRST = [Priority.Urgent, Priority.High, Priority.Low];

function priorityOptions(values: readonly (Priority | "NONE")[]) {
  const group = branchFilterFacetGroups(
    [row({ id: "any" })],
    DEFAULT_BRANCH_FILTERS,
    vi.fn(),
    values
  ).find((candidate) => candidate.id === BranchFilterFacet.Priority);
  if (!group || group.kind === "range") {
    throw new Error("Missing priority facet");
  }
  return group.options;
}

describe("the Branches priority facet (ISS-10332)", () => {
  it("offers exactly the resolved values, in the resolved order", () => {
    expect(priorityOptions(HIGHEST_FIRST).map((option) => option.id)).toEqual(
      HIGHEST_FIRST
    );
  });

  it('offers "No priority" only when the caller resolved it in, named in words', () => {
    const options = priorityOptions([...HIGHEST_FIRST, PRIORITY_UNSET_VALUE]);

    expect(options.map((option) => option.id)).toEqual([
      ...HIGHEST_FIRST,
      PRIORITY_UNSET_VALUE,
    ]);
    // The unset option names the state in words, never by a glyph alone.
    expect(options.at(-1)?.label).toBe(PRIORITY_LABEL_NONE);
  });
});
