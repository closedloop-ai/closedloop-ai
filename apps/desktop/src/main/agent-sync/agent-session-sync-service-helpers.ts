/**
 * @file agent-session-sync-service-helpers.ts
 * @description The stateless module-level helpers of the session sync lane:
 * tied-top id collection, the persisted tied-top cap, byte formatting, and the
 * thrown-send classifiers.
 *
 * Hoisted out of `agent-session-sync-service.ts` (a shrink-only grandfathered
 * hotspot — root AGENTS.md) alongside the two fold modules. Every function here
 * is pure: no service state, no logger, no clock — `capPersistedTopIds` reports
 * an overflow through an injected callback rather than reaching for the gateway
 * log, so this module has no runtime dependencies at all. Behaviour is unchanged
 * from the inline versions.
 */

import { formatBinaryBytes } from "@repo/lib/format-bytes";
import type { SessionCursorRow } from "./agent-session-read-model.js";
import { MAX_OBSERVED_TOP_IDS } from "./agent-session-sync-backoff-policy.js";
import type { PersistedSyncState } from "./agent-session-sync-source.js";

/**
 * The ids sharing the newest `updated_at` in a descending cursor page. Stops at
 * the first row with a different timestamp, so it reads only the tied-top group.
 */
export function collectIdsAtTimestamp(
  // ISS-8116: `readonly` because the only thing this does with `rows` is read
  // them, and the initial-backfill walk hands its enumeration through as a
  // readonly view.
  rows: readonly SessionCursorRow[],
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

/**
 * Human-readable byte size for log lines, in binary units.
 *
 * ISS-8506: the implementation moved to `@repo/lib/format-bytes`, the one owner
 * of byte formatting repo-wide, leaving this as the name the sync lane already
 * imports. Output is byte-identical to what it replaced, so every assertion
 * pinning it stays green.
 */
export function formatBytes(bytes: number): string {
  return formatBinaryBytes(bytes);
}

/**
 * FEA-3364: distinguish a LOCAL serialization/prep failure from a TRANSIENT
 * socket failure when `sendBatch` throws. A serialization failure is a
 * deterministic local bug — the socket.io parser (or a JSON.stringify along the
 * prep path) cannot encode the payload, so the IDENTICAL batch re-throws on
 * every 5s retry. Retrying it forever just spams; it must be dead-lettered
 * immediately. A dropped connection is neither: the client types it as an
 * {@link AgentSessionSyncTransportError} and the lane defers on it (ISS-10602).
 * Serialization failures surface as a `TypeError` whose message carries one of
 * these encoder signatures; any other throw earns the bounded
 * MAX_CONSECUTIVE_TRANSPORT_ERRORS retry budget (the conservative default — a
 * misclassified transient just retries a bounded number of times before
 * dead-lettering anyway).
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

/**
 * FEA-1962/FEA-3473: the durable cursor snapshot, built from the lane's
 * in-memory watermark, tied-top ids, and dead-letter set. Single source of truth
 * shared by the drained-queues persist and the post-initial-seed persist.
 *
 * The tied-top cap applies to the PERSISTED JSON only — the in-memory working
 * set stays complete, so incremental dedup is exact, while a pathological
 * cluster of same-`updated_at` sessions can never bloat the column without
 * bound. On overflow the serialized set is emptied and a restart falls back to
 * re-scan-from-timestamp: an empty observed set omits the incremental query's
 * `id NOT IN (...)` exclusion, so `updated_at = watermark` re-selects the whole
 * tied-top group and the outbox + server idempotently dedupe the re-enqueue —
 * nothing un-uploaded is skipped.
 */
export function buildPersistedCursorState(
  input: {
    observedTopUpdatedAt: string | null;
    observedIdsAtTopUpdatedAt: ReadonlySet<string>;
    deadLetteredIds: Iterable<string>;
  },
  onOverflow: (message: string) => void
): PersistedSyncState {
  return {
    observedTopUpdatedAt: input.observedTopUpdatedAt,
    observedIdsAtTopUpdatedAt: capPersistedTopIds(
      input.observedIdsAtTopUpdatedAt,
      onOverflow
    ),
    deadLetteredIds: [...input.deadLetteredIds],
  };
}

/**
 * C0 controls plus DEL. Truncation alone is not sanitization: an untrusted
 * server-supplied string (a proxy error page, a version-skewed peer, a body an
 * attacker who can answer the sync POST controls) can carry newlines or ANSI
 * escapes, and these strings are interpolated straight into the gateway console
 * sink — where a newline forges a second log line and an ESC drives the
 * terminal.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping C0/DEL from an untrusted server string is the whole point of this pattern.
const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F]/g;

/**
 * Make an untrusted server-supplied string safe to interpolate into a log line.
 *
 * Strips {@link CONTROL_CHARS_PATTERN} BEFORE applying the length cap, so the
 * cap measures what is actually printed rather than counting escape bytes that
 * are about to be removed.
 *
 * ISS-8595 hoisted this out of `agent-session-sync-validation-failure.ts`, which
 * held the only copy. That `validation_failed` detail was never the lane's only
 * untrusted echoed string — an ack REASON this build does not recognize crosses
 * the identical boundary — and a second hand-rolled copy is exactly how one call
 * site ends up sanitized and the other does not.
 *
 * No redaction marker is emitted: this drops terminal-control noise from a
 * diagnostic string, it does not redact sensitive content, and a marker would
 * imply a meaning-bearing value was withheld.
 */
export function sanitizeUntrustedServerText(
  value: string,
  maxChars: number
): string {
  return value.replace(CONTROL_CHARS_PATTERN, "").slice(0, maxChars);
}

/**
 * ISS-10602: a `sendBatch` throw raised because no HTTP answer arrived at all —
 * the request was never sent (no API origin) or the fetch itself rejected
 * (offline, DNS, a reset socket). Every row would draw the identical throw, so
 * the transport-error fold defers the LANE on it instead of charging the row
 * (`main/sync/AGENTS.md` invariant 4; ISS-9793 ruled the transcript lane's
 * status-less throws the same way). An untyped throw is NOT presumed
 * environmental: payload prep and body encoding fail that way, and those
 * failures belong to the row.
 */
export class AgentSessionSyncTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentSessionSyncTransportError";
  }
}
