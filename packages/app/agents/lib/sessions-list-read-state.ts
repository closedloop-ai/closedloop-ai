import { CompleteSurfaceState } from "../../shared/lib/complete-surface-contract";

export const SessionsListReadState = {
  Restoring: "restoring",
  Loading: "loading",
  Placeholder: "placeholder",
  Syncing: "syncing",
  Unavailable: "unavailable",
  Error: "error",
  Partial: "partial",
  Settled: "settled",
} as const;

export type SessionsListReadState =
  (typeof SessionsListReadState)[keyof typeof SessionsListReadState];

export type SessionsListReadModel = {
  hasKnownTotal: boolean;
  isPending: boolean;
  isRangeUnsettled: boolean;
  isSyncing: boolean;
  isUnavailable: boolean;
  state: SessionsListReadState;
  totalRows?: number;
};

/** Signals needed to bind the Sessions read vocabulary to the surface contract. */
export type SessionsListSurfaceStateSignals = {
  readonly hasActiveFilters: boolean;
  readonly hasCompletePopulation: boolean;
  readonly readModel: SessionsListReadModel;
  readonly visibleRowCount: number;
};

export function resolveSessionsListReadModel({
  canRead,
  hasData,
  isError = false,
  isLoading = false,
  isLoadingError = false,
  isPlaceholderData = false,
  isSyncing = false,
  knownTotal,
  rowCount,
}: {
  canRead: boolean;
  hasData: boolean;
  isError?: boolean;
  isLoading?: boolean;
  isLoadingError?: boolean;
  isPlaceholderData?: boolean;
  isSyncing?: boolean;
  knownTotal?: number;
  rowCount: number;
}): SessionsListReadModel {
  const hasCurrentData = hasData && !isPlaceholderData;
  if (isLoading && !hasCurrentData) {
    return sessionsListReadModel(SessionsListReadState.Loading);
  }
  if (isSyncing && !hasCurrentData) {
    return sessionsListReadModel(SessionsListReadState.Syncing);
  }
  if (!(canRead || hasCurrentData)) {
    return sessionsListReadModel(SessionsListReadState.Restoring);
  }
  if ((isLoadingError || (isError && !hasData)) && !hasCurrentData) {
    return sessionsListReadModel(SessionsListReadState.Error);
  }
  if (isPlaceholderData) {
    return sessionsListReadModel(SessionsListReadState.Placeholder);
  }
  if (!isValidSessionsListTotal(knownTotal)) {
    if (rowCount > 0) {
      return sessionsListReadModel(SessionsListReadState.Partial);
    }
    if (hasCurrentData) {
      return sessionsListReadModel(SessionsListReadState.Unavailable);
    }
    return sessionsListReadModel(SessionsListReadState.Loading);
  }
  return sessionsListReadModel(SessionsListReadState.Settled, knownTotal);
}

export function isSessionsListReadPending(
  state: SessionsListReadState
): boolean {
  return (
    state === SessionsListReadState.Restoring ||
    state === SessionsListReadState.Loading
  );
}

export function isSessionsListReadTotalKnown({
  state,
  totalRows,
}: {
  state: SessionsListReadState;
  totalRows?: number;
}): boolean {
  return (
    (state === SessionsListReadState.Settled ||
      state === SessionsListReadState.Partial) &&
    isValidSessionsListTotal(totalRows)
  );
}

function sessionsListReadModel(
  state: SessionsListReadState,
  totalRows?: number
): SessionsListReadModel {
  const hasKnownTotal = isSessionsListReadTotalKnown({ state, totalRows });
  return {
    hasKnownTotal,
    isPending: isSessionsListReadPending(state),
    isRangeUnsettled: !hasKnownTotal,
    isSyncing: state === SessionsListReadState.Syncing,
    isUnavailable:
      state === SessionsListReadState.Unavailable ||
      state === SessionsListReadState.Error,
    state,
    ...(hasKnownTotal ? { totalRows } : {}),
  };
}

export function isValidSessionsListTotal(
  totalRows: number | undefined
): totalRows is number {
  return (
    totalRows !== undefined && Number.isSafeInteger(totalRows) && totalRows >= 0
  );
}

export function sessionsListReadModelFromState(
  state: SessionsListReadState,
  totalRows?: number
): SessionsListReadModel {
  return sessionsListReadModel(state, totalRows);
}

/**
 * Converts the Sessions read-state helper into the seven-state complete-surface
 * contract without collapsing placeholder, unavailable, or out-of-range pages.
 */
export function selectSessionsListSurfaceState({
  hasActiveFilters,
  hasCompletePopulation,
  readModel,
  visibleRowCount,
}: SessionsListSurfaceStateSignals): CompleteSurfaceState {
  switch (readModel.state) {
    case SessionsListReadState.Restoring:
    case SessionsListReadState.Loading:
    case SessionsListReadState.Syncing:
      return CompleteSurfaceState.Loading;
    case SessionsListReadState.Unavailable:
      return CompleteSurfaceState.Unavailable;
    case SessionsListReadState.Error:
      return CompleteSurfaceState.Error;
    case SessionsListReadState.Placeholder:
    case SessionsListReadState.Partial:
      return CompleteSurfaceState.Partial;
    case SessionsListReadState.Settled:
      return completeSurfaceStateForSettledSessionsRead({
        hasActiveFilters,
        hasCompletePopulation,
        readModel,
        visibleRowCount,
      });
    default: {
      const _exhaustive: never = readModel.state;
      return _exhaustive;
    }
  }
}

function completeSurfaceStateForSettledSessionsRead({
  hasActiveFilters,
  hasCompletePopulation,
  readModel,
  visibleRowCount,
}: SessionsListSurfaceStateSignals): CompleteSurfaceState {
  if (visibleRowCount > 0) {
    return hasCompletePopulation
      ? CompleteSurfaceState.Ready
      : CompleteSurfaceState.Partial;
  }
  if (readModel.totalRows === 0) {
    return hasActiveFilters
      ? CompleteSurfaceState.FilteredEmpty
      : CompleteSurfaceState.GenuineEmpty;
  }
  return CompleteSurfaceState.Partial;
}
