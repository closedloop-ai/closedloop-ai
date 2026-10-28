import {
  deriveListEmptyReason,
  ListEmptyReason,
} from "@repo/api/src/list-empty-state";
import { CompleteSurfaceState } from "../../shared/lib/complete-surface-contract";
import type { BranchFilters } from "./branch-row";

/** What a Branches list body renders, once the precedence has been applied. */
export const BranchesListStateKind = {
  /** The read has not settled; no row count can be trusted yet. */
  Loading: "loading",
  /** Zero rows are visible, and {@link BranchesListEmptyState.reason} says why. */
  Empty: "empty",
  /** Rows are visible; render the table. */
  Rows: "rows",
} as const;
export type BranchesListStateKind =
  (typeof BranchesListStateKind)[keyof typeof BranchesListStateKind];

/**
 * The facts a host already holds. Deliberately raw: a host passes what it read,
 * never a pre-chewed "should I show the empty state" boolean, so no host can
 * apply part of the precedence on its own.
 */
export type BranchesListStateSignals = {
  /** The read has not produced a first result yet (query `isPending`). */
  isPending: boolean;
  /** The read that would have produced the current rows failed. */
  isError: boolean;
  /** A facet filter (repo, status, owner, tag, LOC bound, …) is narrowing. */
  hasActiveFilters: boolean;
  /** A bounded date window is narrowing — i.e. the range is not "all time". */
  hasWindow: boolean;
  /** Rows the table would actually paint right now. */
  visibleRowCount: number;
  /** Total rows in the served population, when the producer reports one. */
  totalRows?: number;
  /** Whether the visible rows are known to represent the full served population. */
  hasCompletePopulation?: boolean;
};

export type BranchesListEmptyState = {
  kind: typeof BranchesListStateKind.Empty;
  /** The canonical reason; the view maps it to a Branches variant. */
  reason: ListEmptyReason;
  /**
   * Offer "Show all time" only when the date window is the ONLY thing narrowing.
   * With a facet filter also active, resetting the range need not reveal a
   * single row, so the button would name a fix that is not one.
   */
  offerShowAllTime: boolean;
};

export type BranchesListState =
  | { kind: typeof BranchesListStateKind.Loading }
  | { kind: typeof BranchesListStateKind.Rows }
  | BranchesListEmptyState;

/** Is any facet filter narrowing the branch corpus? */
export function branchFiltersAreActive(filters: BranchFilters): boolean {
  return (
    filters.names.length > 0 ||
    filters.statuses.length > 0 ||
    filters.owners.length > 0 ||
    filters.collaborators.length > 0 ||
    filters.repos.length > 0 ||
    filters.pullRequests.length > 0 ||
    filters.lastActiveRanges.length > 0 ||
    filters.tags.length > 0 ||
    filters.priorities.length > 0 ||
    filters.sessionPresence.length > 0 ||
    filters.locMin !== undefined ||
    filters.locMax !== undefined ||
    Boolean(filters.search?.trim())
  );
}

/**
 * The one place the Branches list precedence is derived — every host and every
 * body routes here, so a host that re-derives a rung of its own can put the two
 * lists out of step again.
 *
 * The order is the one in which a reader can never be lied to:
 *
 * 1. **Loading** — an unsettled read reports nothing about the population.
 * 2. **Rows** — something is visible; render it.
 * 3. **Empty** — zero rows are visible, so {@link deriveListEmptyReason} names
 *    why: a failed read is Unavailable (never a false all-clear, whether or not
 *    stale rows are still held), an active window, facet, or positive total
 *    makes it Filtered, and only a settled, unnarrowed, successful read may
 *    claim the scope is genuinely Empty.
 */
export function resolveBranchesListState(
  signals: BranchesListStateSignals
): BranchesListState {
  if (signals.isPending) {
    return { kind: BranchesListStateKind.Loading };
  }
  if (signals.visibleRowCount > 0) {
    return { kind: BranchesListStateKind.Rows };
  }
  const reason = deriveListEmptyReason({
    hasActiveFilters:
      signals.hasActiveFilters ||
      signals.hasWindow ||
      hasKnownPositiveTotal(signals.totalRows),
    isUnavailable: signals.isError,
  });
  return {
    kind: BranchesListStateKind.Empty,
    offerShowAllTime:
      reason === ListEmptyReason.Filtered &&
      signals.hasWindow &&
      !signals.hasActiveFilters,
    reason,
  };
}

/**
 * The Branches read/body ladder expressed in the shared complete-surface
 * vocabulary, without letting either host pick a truth state independently.
 */
export function selectBranchesListSurfaceState(
  signals: BranchesListStateSignals
): CompleteSurfaceState {
  if (signals.isPending) {
    return CompleteSurfaceState.Loading;
  }
  if (signals.isError) {
    return CompleteSurfaceState.Error;
  }
  if (signals.visibleRowCount > 0) {
    return signals.hasCompletePopulation === true
      ? CompleteSurfaceState.Ready
      : CompleteSurfaceState.Partial;
  }
  if (hasKnownPositiveTotal(signals.totalRows)) {
    return CompleteSurfaceState.Partial;
  }
  const state = resolveBranchesListState(signals);
  switch (state.kind) {
    case BranchesListStateKind.Loading:
      return CompleteSurfaceState.Loading;
    case BranchesListStateKind.Rows:
      return signals.hasCompletePopulation === true
        ? CompleteSurfaceState.Ready
        : CompleteSurfaceState.Partial;
    case BranchesListStateKind.Empty:
      return completeSurfaceStateForBranchesEmptyReason(state.reason);
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function hasKnownPositiveTotal(totalRows: number | undefined): boolean {
  return (
    totalRows !== undefined && Number.isSafeInteger(totalRows) && totalRows > 0
  );
}

function completeSurfaceStateForBranchesEmptyReason(
  reason: ListEmptyReason
): CompleteSurfaceState {
  switch (reason) {
    case ListEmptyReason.Unavailable:
      return CompleteSurfaceState.Unavailable;
    case ListEmptyReason.Filtered:
      return CompleteSurfaceState.FilteredEmpty;
    case ListEmptyReason.Empty:
      return CompleteSurfaceState.GenuineEmpty;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
