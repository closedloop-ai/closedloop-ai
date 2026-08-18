/**
 * @file agent-session-sync-service-helpers.ts
 * @description The stateless module-level helpers of the session sync lane:
 * tied-top id collection, the persisted tied-top cap, byte formatting, and the
 * local-vs-transient throw classifier.
 *
 * Hoisted out of `agent-session-sync-service.ts` (a shrink-only grandfathered
 * hotspot — root AGENTS.md) alongside the two fold modules. Every function here
 * is pure: no service state, no logger, no clock — `capPersistedTopIds` reports
 * an overflow through an injected callback rather than reaching for the gateway
 * log, so this module has no runtime dependencies at all. Behaviour is unchanged
 * from the inline versions.
 */

import type { SessionCursorRow } from "./agent-session-read-model.js";
import { MAX_OBSERVED_TOP_IDS } from "./agent-session-sync-backoff-policy.js";

/**
 * The ids sharing the newest `updated_at` in a descending cursor page. Stops at
 * the first row with a different timestamp, so it reads only the tied-top group.
 */
export function collectIdsAtTimestamp(
  rows: SessionCursorRow[],
  updatedAt: string
): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.updated_at !== updatedAt) {
      break;
    }
    ids.add(row.id);
  }
  return ids;
}

/**
 * FEA-3473 (G6): enforce the `MAX_OBSERVED_TOP_IDS` cap when SERIALIZING the
 * tied-top id set into the persisted cursor. On overflow, return an EMPTY array
 * — the persisted cursor keeps only `observedTopUpdatedAt`, and a restart
 * re-scans the whole tied-top group by timestamp (`updated_at >= watermark`),
 * with the outbox + server idempotently deduping the re-enqueue. Under the cap
 * the set is serialized unchanged. Only the PERSISTED JSON is bounded; the
 * in-memory working set stays complete so live incremental dedup is exact.
 */
export function capPersistedTopIds(
  ids: ReadonlySet<string>,
  onOverflow: (message: string) => void
): string[] {
  if (ids.size <= MAX_OBSERVED_TOP_IDS) {
    return [...ids];
  }
  onOverflow(
    `tied-top id set of ${ids.size} exceeds ${MAX_OBSERVED_TOP_IDS}; ` +
      "persisting an empty set and falling back to re-scan-from-timestamp on restart"
  );
  return [];
}

/** Human-readable byte size for log lines. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * FEA-3364: distinguish a LOCAL serialization/prep failure from a TRANSIENT
 * socket failure when `sendBatch` throws. A serialization failure is a
 * deterministic local bug — the socket.io parser (or a JSON.stringify along the
 * prep path) cannot encode the payload, so the IDENTICAL batch re-throws on
 * every 5s retry. Retrying it forever just spams; it must be dead-lettered
 * immediately. A transient socket throw (a connection torn down mid-emit) clears
 * on reconnect and earns the bounded MAX_CONSECUTIVE_TRANSPORT_ERRORS retry
 * budget instead. Serialization failures surface as a `TypeError` whose message
 * carries one of these encoder signatures; anything else is treated as transient
 * (the conservative default — a misclassified transient just retries a bounded
 * number of times before dead-lettering anyway).
 */
export function isLocalSerializationError(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("circular") ||
    message.includes("serialize") ||
    message.includes("bigint")
  );
}
