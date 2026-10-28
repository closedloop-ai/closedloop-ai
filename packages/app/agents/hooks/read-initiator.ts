import { ReadInitiator } from "@repo/api/src/types/read-initiator";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** True only while {@link refetchAsUser} is inside its `refetch()` call. */
let userRefetchInProgress = false;

/**
 * ISS-12039: classify the read a `queryFn` is about to issue. Reads only
 * `client` and `queryKey` off the context: touching `signal` would opt the
 * query out of query-core's keep-running-on-unmount path.
 */
export function queryReadInitiator({
  client,
  queryKey,
}: {
  client: QueryClient;
  queryKey: QueryKey;
}): ReadInitiator {
  if (userRefetchInProgress) {
    return ReadInitiator.User;
  }
  const state = client.getQueryState(queryKey);
  const settledBefore =
    state !== undefined &&
    (state.dataUpdatedAt > 0 ||
      state.errorUpdatedAt > 0 ||
      state.fetchFailureCount > 0);
  return settledBefore ? ReadInitiator.Background : ReadInitiator.User;
}

/**
 * Issue a query's `refetch` as an explicit, user-initiated read. Query-core
 * calls the `queryFn` synchronously inside `refetch()`, so the flag reaches it;
 * a refetch deduplicated into a read already in flight issues no new read.
 */
export function refetchAsUser<T>(refetch: () => Promise<T>): Promise<T> {
  userRefetchInProgress = true;
  try {
    return refetch();
  } finally {
    userRefetchInProgress = false;
  }
}
