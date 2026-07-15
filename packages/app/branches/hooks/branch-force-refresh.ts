"use client";

import type { QueryKey } from "@tanstack/react-query";

const forcedBranchQueryKeys = new Set<string>();

/** Mark a concrete Branches query so its next fetch bypasses source-level TTLs. */
export function markBranchQueryForceRefresh(queryKey: QueryKey): void {
  forcedBranchQueryKeys.add(serializeQueryKey(queryKey));
}

/** Consume a one-shot force-refresh marker for a concrete Branches query. */
export function consumeBranchQueryForceRefresh(queryKey: QueryKey): boolean {
  const serialized = serializeQueryKey(queryKey);
  if (!forcedBranchQueryKeys.has(serialized)) {
    return false;
  }
  forcedBranchQueryKeys.delete(serialized);
  return true;
}

function serializeQueryKey(queryKey: QueryKey): string {
  return JSON.stringify(queryKey);
}
