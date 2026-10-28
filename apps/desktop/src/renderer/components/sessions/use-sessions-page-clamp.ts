import { clampSessionsPageIndex } from "@repo/app/agents/lib/session-pagination";
import { useEffect } from "react";

/**
 * Repair a `?page=` the settled total cannot support, so the list can never sit
 * on a blank table the user has no way to leave.
 *
 * Extracted from `SessionsView` (a grandfathered over-size file) alongside
 * ISS-7249's `isSessionsPageOutOfRange`, because the two are one concern and
 * share one precondition: BOTH may only act on a total a successful read
 * established. A fetch in flight, no data, or a read the gate never enabled all
 * mean the total on hand is the render model's fallback zero, which would clamp
 * every later page to the first.
 */
export function useSessionsPageClamp({
  canReadSessions,
  isFetching,
  hasListData,
  maxOffset,
  page,
  pageSize,
  setPage,
  total,
}: {
  canReadSessions: boolean;
  isFetching: boolean;
  hasListData: boolean;
  maxOffset?: number;
  page: number;
  /** ISS-8756: the size the list read used — the reader's, not a constant. */
  pageSize: number;
  setPage: (page: number) => void;
  total: number;
}): void {
  useEffect(() => {
    if (!(canReadSessions && hasListData) || isFetching) {
      return;
    }
    const clampedPage = clampSessionsPageIndex(
      page,
      total,
      pageSize,
      maxOffset
    );
    if (clampedPage !== page) {
      setPage(clampedPage);
    }
  }, [
    canReadSessions,
    hasListData,
    isFetching,
    maxOffset,
    page,
    pageSize,
    setPage,
    total,
  ]);
}
