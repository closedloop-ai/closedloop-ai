import { BoundedCache } from "@/lib/bounded-cache";

/**
 * Operation-id -> command-id cache for the desktop command store.
 *
 * `operationId` is NOT unique across compute targets, so an entry has to carry
 * the target it was warmed from. A scoped lookup that answered from an entry
 * belonging to another target would hand target A's command to target B's
 * results route, where the scoped ingest then drops the result and still
 * returns 200 — a silent cross-target leak.
 *
 * Reads are therefore validated, not merely keyed: an unscoped caller gets the
 * cached id, and a scoped caller gets it only when the entry was warmed from
 * the same target, otherwise a miss that falls through to the database.
 *
 * Validating alone left the entry keyed by `operationId`, which kept the cache
 * correct but stopped it being a cache for a colliding pair: two targets
 * sharing an operation id evicted each other, so every scoped read missed and
 * re-queried. Each write therefore lands under two keys — a per-target key that
 * gives colliding targets their own slot, and the bare operation key that is
 * the only one an unscoped caller can compute (last write wins there, exactly
 * as before). The two key spaces carry distinct prefixes so they cannot
 * collide, and a scoped read is STILL validated against the entry so no
 * encoding accident can reopen the cross-target leak.
 *
 * One operation can therefore occupy two of the cache's entries; the size cap
 * is a bound on entries, not on operations.
 */

const CACHE_MAX_SIZE = 10_000;

type OperationCommandEntry = {
  commandId: string;
  computeTargetId: string;
};

const operationCommandCache = new BoundedCache<string, OperationCommandEntry>(
  CACHE_MAX_SIZE
);

function unscopedCacheKey(operationId: string): string {
  return `op:${operationId}`;
}

function scopedCacheKey(operationId: string, computeTargetId: string): string {
  return `tgt:${computeTargetId}:${operationId}`;
}

export function rememberOperationCommand(
  operationId: string,
  commandId: string,
  computeTargetId: string
): void {
  const entry: OperationCommandEntry = { commandId, computeTargetId };
  operationCommandCache.set(
    scopedCacheKey(operationId, computeTargetId),
    entry
  );
  operationCommandCache.set(unscopedCacheKey(operationId), entry);
}

export function getCachedOperationCommandId(
  operationId: string,
  computeTargetId?: string
): string | null {
  if (computeTargetId) {
    const scoped = operationCommandCache.get(
      scopedCacheKey(operationId, computeTargetId)
    );
    if (!scoped || scoped.computeTargetId !== computeTargetId) {
      return null;
    }
    return scoped.commandId;
  }

  const entry = operationCommandCache.get(unscopedCacheKey(operationId));
  return entry ? entry.commandId : null;
}

export function clearOperationCommandCache(): void {
  operationCommandCache.clear();
}
