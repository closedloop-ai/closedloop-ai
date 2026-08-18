/**
 * Map a raw SQLite `token_events` row into the shape the session-trace sync
 * input expects.
 *
 * Every count goes through the storage-boundary validation in `db-helpers`,
 * which rejects a negative or non-finite count rather than letting a corrupt row
 * reach the trace; the `trace.*` labels identify this call site in that
 * reporting. The optional 5m/1h cache-write subdivisions use
 * `optionalTokenCountValue` so a genuine `null` (the column was not populated)
 * survives instead of being coerced to `0`, keeping "unknown" distinguishable
 * from "zero" downstream. Cost columns are passed through verbatim — pricing is
 * resolved elsewhere.
 *
 * `normalizeTraceTokenEvent` is the strict single-row parser. Production
 * hydration goes through `mapTraceTokenEvents`, which wraps it with the per-row
 * isolation the batching call site needs — see that function for why.
 *
 * Extracted from `sync-source.ts` (ISS-4771 shrink-only discipline: an
 * over-ceiling grandfathered file must end up smaller than it started).
 */

import { InvalidTokenCountError } from "@repo/lib/harness/token-counts";
import { writePersistentLog } from "../logging/persistent-log.js";
import { optionalTokenCountValue, tokenCountValue } from "./db-helpers.js";
import type { SqliteTokenEventRow } from "./db-row-types.js";
import type { SessionTraceSyncInput } from "./session-trace.js";

const TRACE_TOKEN_EVENT_LOG_SCOPE = "sync-source";

export function normalizeTraceTokenEvent(
  row: SqliteTokenEventRow
): SessionTraceSyncInput["tokenEvents"][number] {
  return {
    model: row.model,
    created_at: row.created_at,
    input_tokens: tokenCountValue(row.input_tokens, "trace.input"),
    output_tokens: tokenCountValue(row.output_tokens, "trace.output"),
    cache_read_tokens: tokenCountValue(
      row.cache_read_tokens,
      "trace.cache_read"
    ),
    cache_write_tokens: tokenCountValue(
      row.cache_write_tokens,
      "trace.cache_write"
    ),
    cache_write_5m_tokens: optionalTokenCountValue(
      row.cache_write_5m_tokens,
      "trace.cache_write_5m"
    ),
    cache_write_1h_tokens: optionalTokenCountValue(
      row.cache_write_1h_tokens,
      "trace.cache_write_1h"
    ),
    cost_usd_estimated: row.cost_usd_estimated,
    input_cost_usd_estimated: row.input_cost_usd_estimated,
    output_cost_usd_estimated: row.output_cost_usd_estimated,
    cache_read_cost_usd_estimated: row.cache_read_cost_usd_estimated,
    cache_creation_cost_usd_estimated: row.cache_creation_cost_usd_estimated,
  };
}

/**
 * Map one session's persisted `token_events` rows for the session trace, with
 * per-row isolation for the optional TTL subdivisions.
 *
 * `loadSyncedSessions` hydrates a BATCH of sessions in one pass, so a bare
 * `rows.map(normalizeTraceTokenEvent)` let a single corrupt persisted TTL value
 * throw out of the whole hydration: list/detail reads for every valid sibling
 * session in the batch failed, and the session-metadata sync lane caught it only
 * at the lane boundary — leaving the same session at the head of the lane to be
 * retried forever. The parser stays strict (a bad value is never silently
 * accepted); the failure is caught HERE, where both the session id and the
 * column name are known, and reported through the same persistent-log sink the
 * sibling Branches degrade path uses.
 *
 * Only the two optional 5m/1h subdivisions are degraded, and only to `null` —
 * the one honest representation of "this tier was never reported" for an
 * internal nullable value. Never to `0`, which would report a real, wrong count.
 * The four REQUIRED counts are deliberately not isolated here: `loadSyncedSessions`
 * runs `mapSyncedTokenEvent` over these same rows one call earlier and validates
 * exactly those four, so a corrupt one throws before this mapper ever sees it —
 * isolating them belongs with that mapper, not with a branch that cannot be
 * reached from here.
 */
export function mapTraceTokenEvents(
  sessionId: string,
  rows: readonly SqliteTokenEventRow[]
): SessionTraceSyncInput["tokenEvents"] {
  return rows.map((row) =>
    normalizeTraceTokenEvent({
      ...row,
      cache_write_5m_tokens: degradedOptionalTokenCount(
        sessionId,
        row.cache_write_5m_tokens,
        "trace.cache_write_5m"
      ),
      cache_write_1h_tokens: degradedOptionalTokenCount(
        sessionId,
        row.cache_write_1h_tokens,
        "trace.cache_write_1h"
      ),
    })
  );
}

/**
 * Parse one optional subdivision strictly, degrading a rejected value to `null`
 * and reporting it. Anything that is not an {@link InvalidTokenCountError}
 * propagates — this must not widen into swallowing unrelated failures.
 */
function degradedOptionalTokenCount(
  sessionId: string,
  value: unknown,
  fieldName: string
): number | null {
  try {
    return optionalTokenCountValue(value, fieldName);
  } catch (error) {
    if (!(error instanceof InvalidTokenCountError)) {
      throw error;
    }
    writePersistentLog(
      "warn",
      TRACE_TOKEN_EVENT_LOG_SCOPE,
      `Degraded invalid ${fieldName} to null for session ${sessionId} (raw=${String(value)}); the session trace reports the tier as unknown instead of failing the hydration batch`
    );
    return null;
  }
}
