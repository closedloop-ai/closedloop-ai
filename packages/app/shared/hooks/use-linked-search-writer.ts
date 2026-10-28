"use client";

import {
  currentSearchForPath,
  recordPendingSearch,
  retainPendingSearchWrites,
  settlePendingSearch,
  subscribePendingSearch,
} from "@repo/app/shared/lib/pending-search-writes";
import { useNoNavigationEpoch } from "@repo/navigation/inert-navigation";
import { useNavigationAdapterOptional } from "@repo/navigation/provider";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/**
 * One URL writer for every hook that replaces a route's query. `search` is the
 * query to render from (the router snapshot, or a newer replace it has not
 * reflected yet); `readLatest` is the query a writer builds its next write from
 * at call time; `replaceSearch` replaces through the host and records the write
 * so the next writer, in this render cycle or the next, merges onto it.
 *
 * Render only reads. The queue settles in an effect once the router reports a
 * snapshot, so a discarded or repeated render cannot change it.
 */
export function useLinkedSearchWriter(
  path: string,
  snapshot: Pick<URLSearchParams, "toString">,
  replace: (href: string, options?: { scroll?: boolean }) => void
) {
  const snapshotSearch = snapshot.toString();
  const adapter = useNavigationAdapterOptional();
  const readEpoch = adapter?.useNavigationEpoch ?? useNoNavigationEpoch;
  const epoch = readEpoch();
  const latest = useRef({ path, epoch, snapshotSearch });
  const subscribe = useCallback(
    (listener: () => void) => subscribePendingSearch(path, listener),
    [path]
  );
  // The queue lives in module state, so React reads it only as an external
  // store: a render that read it directly would see a new value without an
  // update, and React may then drop the effects keyed on it.
  const search = useSyncExternalStore(
    subscribe,
    () => currentSearchForPath(path, snapshotSearch, epoch),
    () => snapshotSearch
  );

  useEffect(() => {
    latest.current = { path, epoch, snapshotSearch };
    settlePendingSearch(path, snapshotSearch, epoch);
  }, [path, epoch, snapshotSearch]);
  useEffect(() => retainPendingSearchWrites(path), [path]);

  const readLatest = useCallback(
    () =>
      new URLSearchParams(
        currentSearchForPath(
          latest.current.path,
          latest.current.snapshotSearch,
          latest.current.epoch
        )
      ),
    []
  );
  const replaceSearch = useCallback(
    (next: URLSearchParams | string) => {
      const query = next.toString();
      recordPendingSearch(
        latest.current.path,
        latest.current.snapshotSearch,
        latest.current.epoch,
        query
      );
      replace(`${latest.current.path}${query ? `?${query}` : ""}`, {
        scroll: false,
      });
    },
    [replace]
  );
  return {
    readLatest,
    replaceSearch,
    search,
  };
}
