import { ListEmptyReason } from "@repo/api/src/list-empty-state";
import { CompleteSurfaceState } from "@repo/app/shared/lib/complete-surface-contract";
import { describe, expect, it } from "vitest";
import {
  BranchesListStateKind,
  type BranchesListStateSignals,
  branchFiltersAreActive,
  resolveBranchesListState,
  selectBranchesListSurfaceState,
} from "../branch-list-state";
import { DEFAULT_BRANCH_FILTERS } from "../branch-row";

/**
 * ISS-9429. The expected column below is written by hand, case by case, from
 * what a reader must be told — NOT derived from the resolver, because the
 * duplication is the test. Every row names one of the five no-data states the
 * surface has to keep distinguishable (loading, unavailable, filtered-empty,
 * true zero, and rows), so a change that collapses two of them into one reddens
 * here rather than shipping a screen that lies about which one it is.
 */
const SETTLED: BranchesListStateSignals = {
  hasActiveFilters: false,
  hasWindow: false,
  isError: false,
  isPending: false,
  visibleRowCount: 0,
};

describe("resolveBranchesListState precedence (ISS-9429)", () => {
  it("reports loading before anything else, even over an errored read with rows", () => {
    const state = resolveBranchesListState({
      ...SETTLED,
      isError: true,
      isPending: true,
      visibleRowCount: 4,
    });

    expect(state.kind).toBe(BranchesListStateKind.Loading);
  });

  it("renders rows whenever any are visible", () => {
    const state = resolveBranchesListState({
      ...SETTLED,
      visibleRowCount: 1,
    });

    expect(state.kind).toBe(BranchesListStateKind.Rows);
  });

  it("keeps retained rows on screen when a background read fails", () => {
    const state = resolveBranchesListState({
      ...SETTLED,
      hasActiveFilters: true,
      hasWindow: true,
      isError: true,
      visibleRowCount: 7,
    });

    expect(state.kind).toBe(BranchesListStateKind.Rows);
  });

  // The exact permutation that shipped the defect: an error arriving while a
  // filter or window has already emptied the visible page. The old per-body
  // ladder gated its error branch on `!hasRows`, so held stale rows sent this
  // input to "No matching branches" — a settled, confident empty about a read
  // that never landed.
  it("calls an errored read unavailable even when a filter emptied the page", () => {
    const state = resolveBranchesListState({
      ...SETTLED,
      hasActiveFilters: true,
      hasWindow: true,
      isError: true,
      visibleRowCount: 0,
    });

    expect(state).toEqual({
      kind: BranchesListStateKind.Empty,
      offerShowAllTime: false,
      reason: ListEmptyReason.Unavailable,
    });
  });

  it("calls an errored read unavailable with nothing narrowing either", () => {
    const state = resolveBranchesListState({ ...SETTLED, isError: true });

    expect(state).toEqual({
      kind: BranchesListStateKind.Empty,
      offerShowAllTime: false,
      reason: ListEmptyReason.Unavailable,
    });
  });

  // The web-only half of the defect: on the all-time range, a facet filter that
  // emptied the list used to render "No branches yet" over a populated org.
  it("calls a facet-narrowed empty filtered, and offers no date reset", () => {
    const state = resolveBranchesListState({
      ...SETTLED,
      hasActiveFilters: true,
    });

    expect(state).toEqual({
      kind: BranchesListStateKind.Empty,
      offerShowAllTime: false,
      reason: ListEmptyReason.Filtered,
    });
  });

  it("offers the date reset when the window alone is narrowing", () => {
    const state = resolveBranchesListState({ ...SETTLED, hasWindow: true });

    expect(state).toEqual({
      kind: BranchesListStateKind.Empty,
      offerShowAllTime: true,
      reason: ListEmptyReason.Filtered,
    });
  });

  // Resetting the range cannot promise a row back while a facet is also
  // narrowing, so the action that claims it would is withheld.
  it("withholds the date reset when a facet is narrowing alongside the window", () => {
    const state = resolveBranchesListState({
      ...SETTLED,
      hasActiveFilters: true,
      hasWindow: true,
    });

    expect(state).toEqual({
      kind: BranchesListStateKind.Empty,
      offerShowAllTime: false,
      reason: ListEmptyReason.Filtered,
    });
  });

  it("claims a genuine zero only on a settled, successful, unnarrowed read", () => {
    const state = resolveBranchesListState(SETTLED);

    expect(state).toEqual({
      kind: BranchesListStateKind.Empty,
      offerShowAllTime: false,
      reason: ListEmptyReason.Empty,
    });
  });

  it("treats zero visible rows with a positive total as filtered, not genuinely empty", () => {
    const state = resolveBranchesListState({ ...SETTLED, totalRows: 3 });

    expect(state).toEqual({
      kind: BranchesListStateKind.Empty,
      offerShowAllTime: false,
      reason: ListEmptyReason.Filtered,
    });
  });

  it("keeps failed zero-row reads unavailable even when the producer reports a positive total", () => {
    const state = resolveBranchesListState({
      ...SETTLED,
      isError: true,
      totalRows: 3,
    });

    expect(state).toEqual({
      kind: BranchesListStateKind.Empty,
      offerShowAllTime: false,
      reason: ListEmptyReason.Unavailable,
    });
  });
});

describe("selectBranchesListSurfaceState", () => {
  it("maps a pending read to the complete-surface loading state", () => {
    expect(
      selectBranchesListSurfaceState({
        ...SETTLED,
        isPending: true,
        visibleRowCount: 3,
      })
    ).toBe(CompleteSurfaceState.Loading);
  });

  it("keeps visible rows ready when the population is complete", () => {
    expect(
      selectBranchesListSurfaceState({
        ...SETTLED,
        hasCompletePopulation: true,
        visibleRowCount: 3,
      })
    ).toBe(CompleteSurfaceState.Ready);
  });

  it("keeps visible rows partial when completeness is unknown", () => {
    expect(
      selectBranchesListSurfaceState({
        ...SETTLED,
        visibleRowCount: 3,
      })
    ).toBe(CompleteSurfaceState.Partial);
  });

  it("maps failed empty reads to error", () => {
    expect(selectBranchesListSurfaceState({ ...SETTLED, isError: true })).toBe(
      CompleteSurfaceState.Error
    );
  });

  it("maps failed retained-row reads to error", () => {
    expect(
      selectBranchesListSurfaceState({
        ...SETTLED,
        hasCompletePopulation: true,
        isError: true,
        visibleRowCount: 3,
      })
    ).toBe(CompleteSurfaceState.Error);
  });

  it("maps zero visible rows with a positive total to partial", () => {
    expect(selectBranchesListSurfaceState({ ...SETTLED, totalRows: 3 })).toBe(
      CompleteSurfaceState.Partial
    );
  });

  it("maps narrowed zero rows to filtered empty", () => {
    expect(
      selectBranchesListSurfaceState({ ...SETTLED, hasWindow: true })
    ).toBe(CompleteSurfaceState.FilteredEmpty);
  });

  it("maps settled unnarrowed zero rows to genuine empty", () => {
    expect(selectBranchesListSurfaceState(SETTLED)).toBe(
      CompleteSurfaceState.GenuineEmpty
    );
  });
});

describe("branchFiltersAreActive", () => {
  it("reports no narrowing for the default selection", () => {
    expect(branchFiltersAreActive(DEFAULT_BRANCH_FILTERS)).toBe(false);
  });

  it.each([
    ["names", { names: ["feature/a"] }],
    ["statuses", { statuses: ["open"] }],
    ["owners", { owners: ["ada"] }],
    ["collaborators", { collaborators: ["grace"] }],
    ["repos", { repos: ["acme/app"] }],
    ["pullRequests", { pullRequests: ["123"] }],
    ["lastActiveRanges", { lastActiveRanges: ["7d"] }],
    ["tags", { tags: ["release"] }],
    ["sessionPresence", { sessionPresence: ["with-sessions"] }],
  ])("reports narrowing when %s is selected", (_field, overrides) => {
    expect(
      branchFiltersAreActive({ ...DEFAULT_BRANCH_FILTERS, ...overrides })
    ).toBe(true);
  });

  // Zero is a real LOC bound, so the check has to be `!== undefined` — a
  // falsy-check would read a `locMin: 0` selection as no filter at all and send
  // the surface back to claiming the org is empty.
  it.each([
    ["locMin", { locMin: 0 }],
    ["locMax", { locMax: 0 }],
  ])("reports narrowing for a zero %s bound", (_field, overrides) => {
    expect(
      branchFiltersAreActive({ ...DEFAULT_BRANCH_FILTERS, ...overrides })
    ).toBe(true);
  });
});
