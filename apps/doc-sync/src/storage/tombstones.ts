import { log } from "@repo/observability/log";
import { REALTIME_TOKEN_TTL_SECONDS } from "@repo/realtime-contract/token";

export const DOC_SYNC_TOMBSTONE_EVICTED_EARLY_EVENT =
  "doc_sync.tombstone_evicted_early";

/** The names of documents deleted within the last TTL. */
export type Tombstones = {
  add: (documentName: string) => void;
  has: (documentName: string) => boolean;
};

/**
 * Held for the document token's lifetime: a token minted before a delete is
 * valid at most `REALTIME_TOKEN_TTL_SECONDS`, and the API mints none after it,
 * so no admission is possible once a tombstone expires. Expired entries are
 * evicted on every call; past `maxEntries`, the oldest is evicted early and
 * logged.
 */
// lc-debt: per-process tombstones assume one instance (PLN-2099 E2); upgrade path: a deleted_document table checked by fetch/store/auth before Redis scale-out
export function createTombstones({
  ttlMs = REALTIME_TOKEN_TTL_SECONDS * 1000,
  maxEntries = DEFAULT_MAX_TOMBSTONES,
  now = Date.now,
}: {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
} = {}): Tombstones {
  /** Insertion order is expiry order, because every entry lives `ttlMs`. */
  const expiresAt = new Map<string, number>();

  const evictExpired = (at: number) => {
    for (const [documentName, expiry] of expiresAt) {
      if (expiry > at) {
        return;
      }
      expiresAt.delete(documentName);
    }
  };

  return {
    add: (documentName) => {
      const at = now();
      evictExpired(at);
      expiresAt.delete(documentName);
      expiresAt.set(documentName, at + ttlMs);
      if (expiresAt.size <= maxEntries) {
        return;
      }
      const oldest = expiresAt.keys().next().value;
      if (oldest !== undefined) {
        expiresAt.delete(oldest);
        log.error("Doc sync tombstone evicted before its TTL", {
          event: DOC_SYNC_TOMBSTONE_EVICTED_EARLY_EVENT,
          documentName: oldest,
        });
      }
    },
    has: (documentName) => {
      evictExpired(now());
      return expiresAt.has(documentName);
    },
  };
}

/** Reached only above ~166 deletes/s sustained for the 10-minute TTL. */
const DEFAULT_MAX_TOMBSTONES = 100_000;
