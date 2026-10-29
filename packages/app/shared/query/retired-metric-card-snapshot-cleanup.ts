"use client";

import { useEffect } from "react";

/**
 * Prefix every retired metric-card snapshot entry was written under (ISS-7424).
 * Kept verbatim after ISS-9897 removed the store: the bytes already resident in
 * an upgraded profile are named by the OLD prefix, and `localStorage` has no
 * expiry of its own, so removing the reader would otherwise strand them
 * forever. Nothing in this build can derive this string any more, which is why
 * it is written out rather than imported.
 */
export const RETIRED_METRIC_CARD_SNAPSHOT_STORAGE_PREFIX =
  "closedloop.metric-card-snapshot.";

/**
 * Drop every entry the retired store owned. Returns how many keys were removed
 * so a caller can assert the sweep ran; the owner key the store kept beside the
 * versioned entries lives under the same prefix and goes with them.
 */
export function clearRetiredMetricCardSnapshots(storage: Storage): number {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(RETIRED_METRIC_CARD_SNAPSHOT_STORAGE_PREFIX)) {
        keys.push(key);
      }
    }
  } catch {
    return 0;
  }
  let removed = 0;
  for (const key of keys) {
    try {
      storage.removeItem(key);
      removed += 1;
    } catch {
      // A profile that refuses writes keeps the bytes. Nothing else to try.
    }
  }
  return removed;
}

/**
 * One-time reclaim of the retired snapshot bytes, mounted where the store's own
 * sweep used to be so it runs whatever route the upgraded profile lands on. A
 * no-op on a profile that never wrote any, and on the server.
 */
export function useRetiredMetricCardSnapshotCleanup(): void {
  useEffect(() => {
    const storage = globalThis.localStorage;
    if (!storage) {
      return;
    }
    clearRetiredMetricCardSnapshots(storage);
  }, []);
}
