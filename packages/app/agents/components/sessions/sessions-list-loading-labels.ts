/**
 * The Sessions list's loading copy — the words that tell a reader whether the
 * table is still loading, narrowing, or already settled.
 *
 * ISS-9106: this was `apps/desktop/src/renderer/components/sessions/sessions-view-loading-labels.ts`
 * and only the desktop v1 stack could produce it, so `SessionsListSurfaceV2`
 * rendered a bare skeleton that conflates "still loading" with
 * "loaded-and-genuinely-empty". Moved to the owner both stacks can import.
 *
 * Deliberately free of React and of any desktop type, so the desktop Playwright
 * specs that assert this copy can import the constants rather than restate them.
 */

/** The table body's copy while a read is in flight and nothing narrows it. */
export const SESSIONS_LIST_LOADING_LABEL = "Loading sessions...";

/** The same moment under an active search term. */
export const SESSIONS_LIST_SEARCHING_LABEL = "Searching sessions...";

/**
 * ISS-6382: is the combined page read not-yet-showable — either the ISS-4655
 * restore gate is still holding it closed, or its first fetch is genuinely in
 * flight?
 *
 * `isListLoading` is the query's `isLoading`, DELIBERATELY not its `isPending`.
 * TanStack reports `pending` for any query with no data, including one disabled
 * indefinitely because `canReadSessions` is false — an unavailable local source.
 * Feeding that in pins the table spinner over the honest "Getting your sessions
 * ready" holding surface (and the summary bar's "—" placeholders) that state
 * owns, forever. `isLoading` is `isPending && isFetching`, so it is false there
 * and true only for a fetch that is actually running.
 *
 * The restore gate is the other half and cannot come from the query at all: a
 * held-closed read on a WARM cache reports a settled success, so `isViewReady`
 * has to be read directly. Bounded by `VIEW_RESTORE_AUTH_DEADLINE_MS`, which
 * fails open, so this can never latch on.
 */
export function isSessionsReadInitiallyLoading({
  isViewReady,
  isListLoading,
}: {
  isViewReady: boolean;
  isListLoading: boolean;
}): boolean {
  return !isViewReady || isListLoading;
}

/**
 * The label for the TABLE body's spinner, or `undefined` when the table is not
 * in a loading state at all. A refetch that still holds last-good rows keeps a
 * label (the rows stay, the spinner says why); a settled read with rows has
 * none.
 *
 * `isSourceStarting` is the caller's local session source still coming up. It
 * was the desktop-only `SessionsDisplayState` before the move; as a boolean the
 * contract states what it needs — a source that cannot answer yet — without
 * dragging a desktop enum onto a shared surface that has no local source.
 */
export function getSessionsTableLoadingLabel({
  hasData,
  isInitialLoading,
  isRefreshingWithPreviousData,
  isSourceStarting,
  search,
}: {
  hasData: boolean;
  isInitialLoading: boolean;
  isRefreshingWithPreviousData: boolean;
  isSourceStarting: boolean;
  search: string | undefined;
}): string | undefined {
  if (isRefreshingWithPreviousData) {
    return getSessionsLoadingLabel(search);
  }

  if ((isSourceStarting || isInitialLoading) && !hasData) {
    return getSessionsLoadingLabel(search);
  }

  return undefined;
}

function getSessionsLoadingLabel(search: string | undefined): string {
  return search ? SESSIONS_LIST_SEARCHING_LABEL : SESSIONS_LIST_LOADING_LABEL;
}
