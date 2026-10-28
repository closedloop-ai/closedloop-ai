import { useEffect, useRef } from "react";

/**
 * ISS-12278 (Marisol Ashgrove ruling, 2026-10-08, PRD-792 thread): web has no
 * branch-change signal, so when the cloud read reports a stale-PR refresh that
 * is scheduled or still in flight, the detail is refetched a few seconds later
 * to pick up the refreshed state.
 *
 * The server keeps reporting the refresh while a claimed attempt has not
 * landed, so one refetch can arrive before a slow refresh finishes. Follow-ups
 * are capped per `detailKey` at {@link BRANCH_DETAIL_REFRESH_FOLLOW_UP_LIMIT}:
 * a refresh that cannot run (budget, GitHub failure) can never become a poll.
 * `dataUpdatedAt` re-arms the timer after each fetch that still reports one.
 */
export function useBranchDetailRefreshFollowUp(
  refreshPending: boolean,
  detailKey: string,
  dataUpdatedAt: number,
  refetch: () => Promise<unknown>
): void {
  const followUps = useRef<{ key: string; count: number; armedAt: number }>({
    key: detailKey,
    count: 0,
    armedAt: Number.NaN,
  });
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    if (followUps.current.key !== detailKey) {
      followUps.current = { key: detailKey, count: 0, armedAt: Number.NaN };
    }
    if (
      !refreshPending ||
      followUps.current.armedAt === dataUpdatedAt ||
      followUps.current.count >= BRANCH_DETAIL_REFRESH_FOLLOW_UP_LIMIT
    ) {
      return;
    }
    const timer = setTimeout(() => {
      followUps.current.armedAt = dataUpdatedAt;
      followUps.current.count += 1;
      refetchRef.current().catch(() => undefined);
    }, BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [refreshPending, detailKey, dataUpdatedAt]);
}

export const BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS = 5000;

/** Follow-up refetches per detail key, so a refresh that never lands is not a poll. */
export const BRANCH_DETAIL_REFRESH_FOLLOW_UP_LIMIT = 3;
