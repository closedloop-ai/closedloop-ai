/** Provider-neutral SQLite token-event to additive sync-contract projection. */
import type { SyncedAgentSessionTokenEvent } from "@repo/api/src/types/agent-session";
import { tokenCountValue } from "./db-helpers.js";
import type { SqliteTokenEventRow } from "./db-row-types.js";
import {
  parseStoredTokenCostSummary,
  parseStoredTokenSourceIdentity,
} from "./token-event-contract.js";
import { legacyTokenEventExternalId } from "./token-event-identity.js";

/**
 * Prefer the persisted internal transport identity. Untouched pre-migration rows
 * retain their historical immutable-content hash and omit new optional fields.
 */
export function mapSyncedTokenEvent(
  sessionId: string,
  eventRow: SqliteTokenEventRow
): SyncedAgentSessionTokenEvent {
  const inputTokens = tokenCountValue(
    eventRow.input_tokens,
    "tokenEvent.input"
  );
  const outputTokens = tokenCountValue(
    eventRow.output_tokens,
    "tokenEvent.output"
  );
  const cacheReadTokens = tokenCountValue(
    eventRow.cache_read_tokens,
    "tokenEvent.cacheRead"
  );
  const cacheWriteTokens = tokenCountValue(
    eventRow.cache_write_tokens,
    "tokenEvent.cacheWrite"
  );
  const estimatedCostUsd = eventRow.cost_usd_estimated ?? undefined;
  const sourceIdentity = parseStoredTokenSourceIdentity(
    eventRow.source_identity
  );
  const costSummary = parseStoredTokenCostSummary(eventRow.cost_summary);
  const externalEventId =
    eventRow.transport_id ??
    legacyTokenEventExternalId(sessionId, {
      model: eventRow.model,
      createdAt: eventRow.created_at,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    });
  return {
    externalEventId,
    model: eventRow.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
    ...(costSummary === undefined ? {} : { costSummary }),
    createdAt: eventRow.created_at,
  };
}
