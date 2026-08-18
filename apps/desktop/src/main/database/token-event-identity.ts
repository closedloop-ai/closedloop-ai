/**
 * @file token-event-identity.ts
 * @description Pure provider-neutral token-event identity and counter helpers.
 * Preserves legacy sync hashes while keeping generated transport IDs stable
 * across replacement, replay, and equal-content occurrences.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import type { NormalizedTokenRecord } from "../collectors/types.js";
import { tokenCountValue } from "./db-helpers.js";

/** Validated token counters at the SQLite trust boundary. */
export type TokenEventUsageCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWriteTtl?: {
    fiveM: number;
    oneH: number;
  };
};

/** Immutable fields used by the pre-0043 sync identity contract. */
export type LegacyTokenEventIdentity = {
  model: string;
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** Stored fields needed to recover a token event's persistence identity. */
export type StoredTokenEventIdentityRow = {
  transport_id: string | null;
  model: string;
  created_at: string;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
  cache_write_5m_tokens: unknown;
  cache_write_1h_tokens: unknown;
};

/** Existing identities available to a complete replacement pass. */
export type ReusableTokenEventTransportIds = {
  idsByIdentity: Map<string, string[]>;
  identityByTransportId: Map<string, string>;
};

/** Validate token counters at their SQLite trust boundary. */
export function normalizeTokenEventRecord(
  record: NormalizedTokenRecord,
  context: string
): TokenEventUsageCounts {
  return {
    input: tokenCountValue(record.input, `${context}.input_tokens`),
    output: tokenCountValue(record.output, `${context}.output_tokens`),
    cacheRead: tokenCountValue(
      record.cacheRead,
      `${context}.cache_read_tokens`
    ),
    cacheWrite: tokenCountValue(
      record.cacheWrite,
      `${context}.cache_write_tokens`
    ),
    ...(record.cacheWriteTtl
      ? {
          cacheWriteTtl: {
            fiveM: tokenCountValue(
              record.cacheWriteTtl.fiveM,
              `${context}.cache_write_5m_tokens`
            ),
            oneH: tokenCountValue(
              record.cacheWriteTtl.oneH,
              `${context}.cache_write_1h_tokens`
            ),
          },
        }
      : {}),
  };
}

/** Reproduce the immutable content hash emitted for pre-0043 token rows. */
export function legacyTokenEventExternalId(
  sessionId: string,
  identity: LegacyTokenEventIdentity
): string {
  return createHash("sha256")
    .update(stableStringify({ sessionId, ...identity }))
    .digest("hex");
}

/** Build reusable IDs keyed by the complete persisted token identity. */
export function buildReusableTokenEventTransportIds(
  sessionId: string,
  rows: readonly StoredTokenEventIdentityRow[]
): ReusableTokenEventTransportIds {
  const idsByIdentity = new Map<string, Set<string>>();
  const identityByTransportId = new Map<string, string>();
  for (const row of rows) {
    const identityKey = persistenceIdentityKeyFromRow(row);
    const transportId =
      row.transport_id ??
      legacyTokenEventExternalId(sessionId, legacyIdentityFromRow(row));
    const ids = idsByIdentity.get(identityKey) ?? new Set<string>();
    ids.add(transportId);
    idsByIdentity.set(identityKey, ids);
    identityByTransportId.set(transportId, identityKey);
  }
  return {
    idsByIdentity: new Map(
      [...idsByIdentity].map(([identityKey, ids]) => [
        identityKey,
        [...ids].sort().reverse(),
      ])
    ),
    identityByTransportId,
  };
}

/** Count pre-0043 content identities for one-for-one live append filtering. */
export function buildLegacyTokenEventIdentityCounts(
  sessionId: string,
  rows: readonly StoredTokenEventIdentityRow[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const externalId = legacyTokenEventExternalId(
      sessionId,
      legacyIdentityFromRow(row)
    );
    counts.set(externalId, (counts.get(externalId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Consume a matching stored ID. Existing identity wins over a newly introduced
 * producer ID so an additive upgrade cannot duplicate an append-only sync row.
 */
export function consumeReusableTokenEventTransportId(
  reusableIds: ReusableTokenEventTransportIds,
  record: NormalizedTokenRecord,
  explicitTransportId: string | undefined
): string | undefined {
  const identityKey = persistenceIdentityKeyFromRecord(record);
  if (
    explicitTransportId !== undefined &&
    reusableIds.identityByTransportId.has(explicitTransportId) &&
    reusableIds.identityByTransportId.get(explicitTransportId) !== identityKey
  ) {
    throw new Error(
      `token event transport identity collision for ${explicitTransportId}`
    );
  }
  const ids = reusableIds.idsByIdentity.get(identityKey);
  if (ids === undefined) {
    return undefined;
  }
  if (explicitTransportId !== undefined) {
    const explicitIndex = ids.indexOf(explicitTransportId);
    if (explicitIndex >= 0) {
      const [transportId] = ids.splice(explicitIndex, 1);
      if (ids.length === 0) {
        reusableIds.idsByIdentity.delete(identityKey);
      }
      return transportId;
    }
  }
  const transportId = ids.pop();
  if (ids.length === 0) {
    reusableIds.idsByIdentity.delete(identityKey);
  }
  return transportId;
}

/** Consume one matching pre-0043 identity from live high-water rows. */
export function consumeLegacyTokenEventIdentity(
  counts: Map<string, number>,
  sessionId: string,
  record: NormalizedTokenRecord
): boolean {
  const externalId = legacyTokenEventExternalId(
    sessionId,
    legacyIdentityFromRecord(record)
  );
  const remaining = counts.get(externalId) ?? 0;
  if (remaining === 0) {
    return false;
  }
  if (remaining === 1) {
    counts.delete(externalId);
  } else {
    counts.set(externalId, remaining - 1);
  }
  return true;
}

/** Normalize a nullable persisted token counter. */
export function nullableTokenCount(value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : tokenCountValue(value, "token_events.replay.cache_write_ttl");
}

function legacyIdentityFromRecord(
  record: NormalizedTokenRecord
): LegacyTokenEventIdentity {
  const counts = normalizeTokenEventRecord(record, "token_events.legacy_id");
  return {
    model: record.model,
    createdAt: record.timestamp,
    inputTokens: counts.input,
    outputTokens: counts.output,
    cacheReadTokens: counts.cacheRead,
    cacheWriteTokens: counts.cacheWrite,
  };
}

function legacyIdentityFromRow(
  row: StoredTokenEventIdentityRow
): LegacyTokenEventIdentity {
  return {
    model: row.model,
    createdAt: row.created_at,
    inputTokens: tokenCountValue(
      row.input_tokens,
      "token_events.legacy_id.input"
    ),
    outputTokens: tokenCountValue(
      row.output_tokens,
      "token_events.legacy_id.output"
    ),
    cacheReadTokens: tokenCountValue(
      row.cache_read_tokens,
      "token_events.legacy_id.cache_read"
    ),
    cacheWriteTokens: tokenCountValue(
      row.cache_write_tokens,
      "token_events.legacy_id.cache_write"
    ),
  };
}

function persistenceIdentityKeyFromRecord(
  record: NormalizedTokenRecord
): string {
  const counts = normalizeTokenEventRecord(
    record,
    "token_events.persistence_identity"
  );
  return stableStringify({
    ...legacyIdentityFromRecord(record),
    cacheWriteFiveM: counts.cacheWriteTtl?.fiveM ?? null,
    cacheWriteOneH: counts.cacheWriteTtl?.oneH ?? null,
  });
}

function persistenceIdentityKeyFromRow(
  row: StoredTokenEventIdentityRow
): string {
  return stableStringify({
    ...legacyIdentityFromRow(row),
    cacheWriteFiveM: nullableTokenCount(row.cache_write_5m_tokens),
    cacheWriteOneH: nullableTokenCount(row.cache_write_1h_tokens),
  });
}
