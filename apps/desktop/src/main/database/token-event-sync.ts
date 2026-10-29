/** Provider-neutral SQLite token-event to additive sync-contract projection. */
import type { SyncedAgentSessionTokenEvent } from "@repo/api/src/types/agent-session";
import { PARENT_AGENT_EXTERNAL_ID } from "@repo/api/src/types/token-event-agent-owner";
import { tokenCountValue } from "./db-helpers.js";
import type { SqliteTokenEventRow } from "./db-row-types.js";
import { syncableCostUsd } from "./sync-source-session-analytics.js";
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
  // Both columns share the Decimal(14, 6) width — same ceiling as the session cost sibling.
  const estimatedCostUsd = syncableCostUsd(eventRow.cost_usd_estimated);
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
    // ISS-12552 (PRD-800): the owner is corrected on every sync,
    // so the main agent is stated explicitly rather than omitted.
    agentExternalId: eventRow.agent_id || PARENT_AGENT_EXTERNAL_ID,
    createdAt: eventRow.created_at,
  };
}
