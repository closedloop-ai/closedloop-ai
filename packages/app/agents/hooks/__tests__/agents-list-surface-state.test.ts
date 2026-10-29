import { CompleteSurfaceState } from "@repo/app/shared/lib/complete-surface-contract";
import { describe, expect, it } from "vitest";
import {
  isAgentsPaginationVisible,
  selectAgentsListSurfaceState,
} from "../use-agents-list-surface-v2-view-model";

/**
 * ISS-9398 — the state `AgentsListSurfaceV2` selects, asserted directly.
 *
 * `AgentsGroupedList` decided this inline in its render tree, so the only way to
 * ask "what does an in-flight read over an empty page resolve to?" was to mount
 * the component and read the sentence it drew. Two of these cases are the ones
 * `packages/app/AGENTS.md` -> "Loading ≠ unavailable ≠ not-applicable ≠ real
 * zero" is about, and both are invisible in rendered copy today because the
 * loading and empty branches are the same grey paragraph.
 */

const SETTLED = { isError: false, isLoading: false } as const;

describe("selectAgentsListSurfaceState", () => {
  it("reports an in-flight read as Loading, never as an empty population", () => {
    expect(
      selectAgentsListSurfaceState({
        hasActiveFilters: false,
        isEmpty: true,
        isError: false,
        isLoading: true,
      })
    ).toBe(CompleteSurfaceState.Loading);
  });

  it("reports a rejected read as Error, never as an empty population", () => {
    expect(
      selectAgentsListSurfaceState({
        hasActiveFilters: false,
        isEmpty: true,
        isError: true,
        isLoading: false,
      })
    ).toBe(CompleteSurfaceState.Error);
  });

  it("keeps a rejected read as Error while a retry is in flight", () => {
    expect(
      selectAgentsListSurfaceState({
        hasActiveFilters: false,
        isEmpty: true,
        isError: true,
        isLoading: true,
      })
    ).toBe(CompleteSurfaceState.Error);
  });

  it("reports a populated page as Ready whether or not a filter is narrowing", () => {
    for (const hasActiveFilters of [false, true]) {
      expect(
        selectAgentsListSurfaceState({
          ...SETTLED,
          hasActiveFilters,
          isEmpty: false,
        })
      ).toBe(CompleteSurfaceState.Ready);
    }
  });

  /**
   * The two empties, which are the whole reason the ladder is a named function.
   * `GenuineEmpty` claims the underlying population is empty, so it is claimed
   * ONLY where nothing narrows — where the read is the whole population.
   */
  it("splits the settled empty on whether anything is narrowing the scope", () => {
    expect(
      selectAgentsListSurfaceState({
        ...SETTLED,
        hasActiveFilters: true,
        isEmpty: true,
      })
    ).toBe(CompleteSurfaceState.FilteredEmpty);
    expect(
      selectAgentsListSurfaceState({
        ...SETTLED,
        hasActiveFilters: false,
        isEmpty: true,
      })
    ).toBe(CompleteSurfaceState.GenuineEmpty);
  });
});

/**
 * ISS-9216 AC1/AC3 — the surface's single pagination rule, both halves pinned.
 *
 * Asserted here rather than only through a render because the two halves are
 * suppressed by different facts and a rendered case can only exercise one at a
 * time: an unresolved or rejected FIRST read has no rows, so `totalPages` is 1
 * and the page-count half alone hides the footer. The combination that needs the
 * `Ready` half is a rejected REFETCH, where the query retains the previous rows.
 */
describe("isAgentsPaginationVisible", () => {
  it("shows the footer only for a settled, multi-page population", () => {
    expect(
      isAgentsPaginationVisible({
        state: CompleteSurfaceState.Ready,
        totalPages: 2,
      })
    ).toBe(true);
  });

  it("hides it over a population that is not being shown, however many pages", () => {
    for (const state of [
      CompleteSurfaceState.Loading,
      CompleteSurfaceState.Error,
      CompleteSurfaceState.FilteredEmpty,
      CompleteSurfaceState.GenuineEmpty,
    ]) {
      expect(isAgentsPaginationVisible({ state, totalPages: 2 })).toBe(false);
    }
  });

  it("hides it when there is one page to page through", () => {
    expect(
      isAgentsPaginationVisible({
        state: CompleteSurfaceState.Ready,
        totalPages: 1,
      })
    ).toBe(false);
  });
});
