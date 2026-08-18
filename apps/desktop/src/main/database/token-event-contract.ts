/**
 * @file token-event-contract.ts
 * @description Provider-neutral token-event persistence contract. Owns stable
 * transport identity, legacy provenance/completeness defaults, storage-boundary
 * validation, boot replacement, and replay-safe live append behavior.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  type TokenCostSummary,
  type TokenSourceIdentity,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
  tokenCostSummarySchema,
  tokenEventTransportIdSchema,
  tokenSourceIdentitySchema,
} from "@repo/api/src/types/token-cost-provenance";
import { z } from "zod";
import type { NormalizedTokenRecord } from "../collectors/types.js";
import { EVENT_INSERT_PARAM_CAP } from "./db-constants.js";
import { tokenCountValue } from "./db-helpers.js";
import type { Prisma } from "./generated/client.js";
import { buildValuesTuples, chunkRowsByParamCap } from "./sql-values-tuples.js";
import {
  buildLegacyTokenEventIdentityCounts,
  buildReusableTokenEventTransportIds,
  consumeLegacyTokenEventIdentity,
  consumeReusableTokenEventTransportId,
  normalizeTokenEventRecord,
  nullableTokenCount,
  type ReusableTokenEventTransportIds,
  type StoredTokenEventIdentityRow,
} from "./token-event-identity.js";

export type TokenEventRecord = NormalizedTokenRecord;

/** A record after its internal identity and legacy source default are fixed. */
export type PersistedTokenEventRecord = Omit<
  TokenEventRecord,
  "transportId" | "sourceIdentity"
> & {
  transportId: string;
  sourceIdentity: TokenSourceIdentity;
};

type PersistedReplayRow = {
  model: string;
  created_at: string;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
  cache_write_5m_tokens: unknown;
  cache_write_1h_tokens: unknown;
  source_identity: unknown;
  cost_summary: unknown;
};

type PersistedReplayRowWithTransportId = PersistedReplayRow & {
  transport_id: string;
};

/**
 * Replace a session's complete token-event derivation. Generated fallback IDs
 * include the stable array occurrence, so equal-content records stay distinct
 * and a replay of the same normalized series produces the same IDs.
 */
export async function replaceTokenEvents(
  tx: Prisma.TransactionClient,
  sessionId: string,
  records: readonly TokenEventRecord[]
): Promise<PersistedTokenEventRecord[]> {
  const reusableTransportIds = await loadReusableTokenEventTransportIds(
    tx,
    sessionId
  );
  const persistedRecords = materializeTokenEventRecords(
    sessionId,
    records,
    reusableTransportIds
  );
  await tx.$executeRawUnsafe(
    "DELETE FROM token_events WHERE session_id = $1",
    sessionId
  );
  await insertTokenEventsBatched(tx, sessionId, persistedRecords);
  return persistedRecords;
}

/**
 * Append live records newer than the stored high-water mark. Equal-timestamp
 * rows are admitted and the persisted transport identity—not content—decides
 * replay. A reused ID with different immutable usage fails loudly.
 */
export async function appendTokenEvents(
  tx: Prisma.TransactionClient,
  sessionId: string,
  records: readonly TokenEventRecord[]
): Promise<PersistedTokenEventRecord[]> {
  const persistedRecords = materializeTokenEventRecords(sessionId, records);
  const hwmResult = await tx.$queryRawUnsafe<{ hwm: string | null }[]>(
    "SELECT MAX(created_at) AS hwm FROM token_events WHERE session_id = $1",
    sessionId
  );
  const hwm = hwmResult[0]?.hwm ?? null;
  const replayRowsByTransportId = await loadOlderExplicitReplayRows(
    tx,
    sessionId,
    records,
    persistedRecords,
    hwm
  );
  const legacyIdentityCounts =
    hwm !== null && persistedRecords.some((record) => record.timestamp === hwm)
      ? await loadLegacyTokenEventIdentityCounts(tx, sessionId)
      : new Map<string, number>();
  const insertedRecords: PersistedTokenEventRecord[] = [];
  for (const [index, record] of persistedRecords.entries()) {
    if (!record.timestamp || (hwm !== null && record.timestamp < hwm)) {
      if (
        record.timestamp &&
        records[index]?.transportId !== undefined &&
        !(await reconcileTokenEventReplayOptional(
          tx,
          sessionId,
          replayRowsByTransportId.get(record.transportId),
          record
        ))
      ) {
        throw transportIdentityCollisionError(sessionId, record.transportId);
      }
      continue;
    }
    if (
      record.timestamp === hwm &&
      consumeLegacyTokenEventIdentity(legacyIdentityCounts, sessionId, record)
    ) {
      continue;
    }
    const inserted = await insertTokenEvent(tx, sessionId, record);
    if (inserted > 0) {
      insertedRecords.push(record);
      continue;
    }
    await assertReplayMatches(tx, sessionId, record);
  }
  return insertedRecords;
}

/**
 * Preserve an explicit producer summary. Otherwise a local estimate is Partial
 * evidence in the API-estimated lane and a missing estimate is Unavailable.
 * Explicit identity failures use their canonical completeness reason, while
 * omitted or legacy-default identity preserves legacy compatibility.
 */
export function resolveTokenEventCostSummary(
  record: TokenEventRecord,
  estimatedCostUsd: number | undefined
): TokenCostSummary {
  if (record.costSummary !== undefined) {
    return tokenCostSummarySchema.parse(record.costSummary);
  }
  const reason =
    record.sourceIdentity?.availability ===
      TokenSourceIdentityAvailability.Unavailable &&
    record.sourceIdentity.reason !==
      TokenSourceIdentityUnavailableReason.LegacyRecord
      ? TokenCostCompletenessReason.SourceIdentityUnavailable
      : TokenCostCompletenessReason.LegacyRecord;
  if (estimatedCostUsd !== undefined) {
    return tokenCostSummarySchema.parse({
      completeness: TokenCostCompleteness.Partial,
      reason,
      subtotalUsd: estimatedCostUsd,
      lanes: [
        {
          basis: TokenCostBasis.ApiEstimated,
          subtotalUsd: estimatedCostUsd,
        },
      ],
    });
  }
  return unavailableCostSummary(reason);
}

/** Parse persisted source evidence, degrading corrupt/future shapes safely. */
export function parseStoredTokenSourceIdentity(
  value: unknown
): TokenSourceIdentity | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = parseStoredJson(value);
  if (parsed.kind === "malformed") {
    return unavailableSourceIdentity(
      TokenSourceIdentityUnavailableReason.Malformed
    );
  }
  const identity = tokenSourceIdentitySchema.safeParse(parsed.value);
  return identity.success
    ? identity.data
    : unavailableSourceIdentity(
        knownSourceIdentityDiscriminantSchema.safeParse(parsed.value).success
          ? TokenSourceIdentityUnavailableReason.Malformed
          : TokenSourceIdentityUnavailableReason.Unknown
      );
}

/** Parse persisted cost evidence, degrading corrupt/future shapes safely. */
export function parseStoredTokenCostSummary(
  value: unknown
): TokenCostSummary | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = parseStoredJson(value);
  if (parsed.kind === "malformed") {
    return unavailableCostSummary(TokenCostCompletenessReason.Malformed);
  }
  const locallyDerived = storedLocalTokenCostSummarySchema.safeParse(
    parsed.value
  );
  if (locallyDerived.success) {
    return locallyDerived.data.summary;
  }
  const summary = tokenCostSummarySchema.safeParse(parsed.value);
  return summary.success
    ? summary.data
    : unavailableCostSummary(
        knownCostCompletenessDiscriminantSchema.safeParse(parsed.value).success
          ? TokenCostCompletenessReason.Malformed
          : TokenCostCompletenessReason.Unknown
      );
}

/** Identify local cost evidence without conflating it with producer evidence. */
export function isLocallyDerivedStoredTokenCostSummary(
  value: unknown
): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  const parsed = parseStoredJson(value);
  return (
    parsed.kind === "parsed" &&
    storedLocalTokenCostSummarySchema.safeParse(parsed.value).success
  );
}

/** Serialize producer evidence directly and tag locally derived fallbacks. */
export function serializeTokenEventCostSummary(
  record: TokenEventRecord,
  estimatedCostUsd: number | undefined
): string {
  const summary = resolveTokenEventCostSummary(record, estimatedCostUsd);
  return JSON.stringify(
    record.costSummary === undefined && estimatedCostUsd === undefined
      ? storedLocalTokenCostSummarySchema.parse({
          origin: StoredTokenCostSummaryOrigin.Local,
          summary,
        })
      : summary
  );
}

function materializeTokenEventRecords(
  sessionId: string,
  records: readonly TokenEventRecord[],
  reusableTransportIds: ReusableTokenEventTransportIds = {
    idsByIdentity: new Map(),
    identityByTransportId: new Map(),
  }
): PersistedTokenEventRecord[] {
  const seenTransportIds = new Set<string>();
  return records.map((record, occurrence) => {
    const reusableTransportId = consumeReusableTokenEventTransportId(
      reusableTransportIds,
      record,
      record.transportId
    );
    const transportId = tokenEventTransportIdSchema.parse(
      reusableTransportId ??
        record.transportId ??
        generatedTransportId(sessionId, record, occurrence)
    );
    if (seenTransportIds.has(transportId)) {
      throw new Error(
        `duplicate token event transportId in session ${sessionId}: digest=${transportIdDiagnostic(transportId)}`
      );
    }
    seenTransportIds.add(transportId);
    const sourceIdentity = tokenSourceIdentitySchema.parse(
      record.sourceIdentity ?? legacyUnavailableSourceIdentity()
    );
    return {
      ...record,
      transportId,
      sourceIdentity,
      ...(record.costSummary === undefined
        ? {}
        : { costSummary: tokenCostSummarySchema.parse(record.costSummary) }),
    };
  });
}

async function loadReusableTokenEventTransportIds(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<ReusableTokenEventTransportIds> {
  const rows = await tx.$queryRawUnsafe<StoredTokenEventIdentityRow[]>(
    `SELECT transport_id, model, created_at, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
            cache_write_1h_tokens
       FROM token_events
      WHERE session_id = $1`,
    sessionId
  );
  return buildReusableTokenEventTransportIds(sessionId, rows);
}

async function loadLegacyTokenEventIdentityCounts(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<Map<string, number>> {
  const rows = await tx.$queryRawUnsafe<StoredTokenEventIdentityRow[]>(
    `SELECT transport_id, model, created_at, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
            cache_write_1h_tokens
       FROM token_events
      WHERE session_id = $1 AND transport_id IS NULL`,
    sessionId
  );
  return buildLegacyTokenEventIdentityCounts(sessionId, rows);
}

function generatedTransportId(
  sessionId: string,
  record: TokenEventRecord,
  occurrence: number
): string {
  const digest = createHash("sha256")
    .update(
      stableStringify({
        sessionId,
        occurrence,
        timestamp: record.timestamp,
        model: record.model,
        input: record.input,
        output: record.output,
        cacheRead: record.cacheRead,
        cacheWrite: record.cacheWrite,
        cacheWriteTtl: record.cacheWriteTtl ?? null,
      })
    )
    .digest("hex");
  return `token-event-${digest}`;
}

async function insertTokenEventsBatched(
  tx: Prisma.TransactionClient,
  sessionId: string,
  records: readonly PersistedTokenEventRecord[]
): Promise<void> {
  const rows = records.flatMap((record) => {
    if (!record.timestamp) {
      return [];
    }
    return [tokenEventInsertRow(sessionId, record)];
  });
  for (const chunk of chunkRowsByParamCap(
    rows,
    TOKEN_EVENT_INSERT_COLUMN_COUNT
  )) {
    const { tuples, params } = buildValuesTuples(chunk);
    await tx.$executeRawUnsafe(
      `INSERT INTO token_events (${TOKEN_EVENT_INSERT_COLUMNS})
       VALUES ${tuples.join(", ")}`,
      ...params
    );
  }
}

function insertTokenEvent(
  tx: Prisma.TransactionClient,
  sessionId: string,
  record: PersistedTokenEventRecord
): Promise<number> {
  const row = tokenEventInsertRow(sessionId, record);
  const placeholders = row.map((_, index) => `$${index + 1}`).join(", ");
  return tx.$executeRawUnsafe(
    `INSERT INTO token_events (${TOKEN_EVENT_INSERT_COLUMNS})
     VALUES (${placeholders})
     ON CONFLICT(session_id, transport_id) WHERE transport_id IS NOT NULL
     DO NOTHING`,
    ...row
  );
}

function tokenEventInsertRow(
  sessionId: string,
  record: PersistedTokenEventRecord
): unknown[] {
  const storageCounts = normalizeTokenEventRecord(record, "token_events");
  return [
    sessionId,
    record.transportId,
    record.model,
    record.timestamp,
    storageCounts.input,
    storageCounts.output,
    storageCounts.cacheRead,
    storageCounts.cacheWrite,
    storageCounts.cacheWriteTtl ? storageCounts.cacheWriteTtl.fiveM : null,
    storageCounts.cacheWriteTtl ? storageCounts.cacheWriteTtl.oneH : null,
    JSON.stringify(tokenSourceIdentitySchema.parse(record.sourceIdentity)),
    JSON.stringify(
      tokenCostSummarySchema.parse(
        record.costSummary ?? legacyUnavailableCostSummary()
      )
    ),
  ];
}

async function assertReplayMatches(
  tx: Prisma.TransactionClient,
  sessionId: string,
  record: PersistedTokenEventRecord
): Promise<void> {
  const rows = await tx.$queryRawUnsafe<PersistedReplayRow[]>(
    `SELECT model, created_at, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
            source_identity, cost_summary
       FROM token_events
      WHERE session_id = $1 AND transport_id = $2`,
    sessionId,
    record.transportId
  );
  const existing = rows[0];
  if (
    existing === undefined ||
    !(await reconcileTokenEventReplay(tx, sessionId, existing, record))
  ) {
    throw transportIdentityCollisionError(sessionId, record.transportId);
  }
}

async function loadOlderExplicitReplayRows(
  tx: Prisma.TransactionClient,
  sessionId: string,
  sourceRecords: readonly TokenEventRecord[],
  persistedRecords: readonly PersistedTokenEventRecord[],
  hwm: string | null
): Promise<Map<string, PersistedReplayRow>> {
  if (hwm === null) {
    return new Map();
  }
  const transportIds = Array.from(
    new Set(
      persistedRecords.flatMap((record, index) =>
        record.timestamp &&
        record.timestamp < hwm &&
        sourceRecords[index]?.transportId !== undefined
          ? [record.transportId]
          : []
      )
    )
  );
  const rowsByTransportId = new Map<string, PersistedReplayRow>();
  const idsPerQuery = EVENT_INSERT_PARAM_CAP - 1;
  for (let offset = 0; offset < transportIds.length; offset += idsPerQuery) {
    const ids = transportIds.slice(offset, offset + idsPerQuery);
    const placeholders = ids.map((_, index) => `$${index + 2}`).join(", ");
    const rows = await tx.$queryRawUnsafe<PersistedReplayRowWithTransportId[]>(
      `SELECT transport_id, model, created_at, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
              cache_write_1h_tokens, source_identity, cost_summary
         FROM token_events
        WHERE session_id = $1 AND transport_id IN (${placeholders})`,
      sessionId,
      ...ids
    );
    for (const row of rows) {
      rowsByTransportId.set(row.transport_id, row);
    }
  }
  return rowsByTransportId;
}

async function reconcileTokenEventReplayOptional(
  tx: Prisma.TransactionClient,
  sessionId: string,
  existing: PersistedReplayRow | undefined,
  record: PersistedTokenEventRecord
): Promise<boolean> {
  return (
    existing === undefined ||
    (await reconcileTokenEventReplay(tx, sessionId, existing, record))
  );
}

/**
 * Accept an exact replay or persist an ordered provenance-prefix extension.
 * Immutable usage and cost fields must match before provenance can grow.
 */
async function reconcileTokenEventReplay(
  tx: Prisma.TransactionClient,
  sessionId: string,
  existing: PersistedReplayRow,
  record: PersistedTokenEventRecord
): Promise<boolean> {
  if (!immutableReplayFieldsMatch(existing, record)) {
    return false;
  }
  const storedSourceIdentity = parseStoredTokenSourceIdentity(
    existing.source_identity
  );
  if (
    sourceIdentityMatchesReplay(storedSourceIdentity, record.sourceIdentity)
  ) {
    return true;
  }
  if (
    !isOrderedSourceIdentityExtension(
      storedSourceIdentity,
      record.sourceIdentity
    )
  ) {
    return false;
  }
  const updated = await tx.$executeRawUnsafe(
    `UPDATE token_events
        SET source_identity = $1
      WHERE session_id = $2 AND transport_id = $3`,
    JSON.stringify(tokenSourceIdentitySchema.parse(record.sourceIdentity)),
    sessionId,
    record.transportId
  );
  return updated === 1;
}

function immutableReplayFieldsMatch(
  existing: PersistedReplayRow,
  record: PersistedTokenEventRecord
): boolean {
  const counts = normalizeTokenEventRecord(record, "token_events.replay");
  const costSummary = parseStoredTokenCostSummary(existing.cost_summary);
  return (
    existing.model === record.model &&
    existing.created_at === record.timestamp &&
    tokenCountValue(existing.input_tokens, "token_events.replay.input") ===
      counts.input &&
    tokenCountValue(existing.output_tokens, "token_events.replay.output") ===
      counts.output &&
    tokenCountValue(
      existing.cache_read_tokens,
      "token_events.replay.cache_read"
    ) === counts.cacheRead &&
    tokenCountValue(
      existing.cache_write_tokens,
      "token_events.replay.cache_write"
    ) === counts.cacheWrite &&
    nullableTokenCount(existing.cache_write_5m_tokens) ===
      (counts.cacheWriteTtl?.fiveM ?? null) &&
    nullableTokenCount(existing.cache_write_1h_tokens) ===
      (counts.cacheWriteTtl?.oneH ?? null) &&
    (record.costSummary === undefined ||
      (costSummary !== undefined &&
        stableStringify(costSummary) === stableStringify(record.costSummary)))
  );
}

function isOrderedSourceIdentityExtension(
  stored: TokenSourceIdentity | undefined,
  incoming: TokenSourceIdentity
): boolean {
  if (
    stored?.availability !== TokenSourceIdentityAvailability.Available ||
    incoming.availability !== TokenSourceIdentityAvailability.Available ||
    stored.scheme !== incoming.scheme ||
    stored.sourceRecordIds.length >= incoming.sourceRecordIds.length
  ) {
    return false;
  }
  return stored.sourceRecordIds.every(
    (sourceRecordId, index) =>
      incoming.sourceRecordIds[index] === sourceRecordId
  );
}

function sourceIdentityMatchesReplay(
  stored: TokenSourceIdentity | undefined,
  incoming: TokenSourceIdentity
): boolean {
  if (
    stored?.availability === TokenSourceIdentityAvailability.Unavailable &&
    stored.reason === TokenSourceIdentityUnavailableReason.LegacyRecord
  ) {
    return true;
  }
  return (
    stored !== undefined &&
    stableStringify(stored) === stableStringify(incoming)
  );
}

function parseStoredJson(
  value: unknown
): { kind: "parsed"; value: unknown } | { kind: "malformed" } {
  if (typeof value !== "string") {
    return { kind: "malformed" };
  }
  try {
    return { kind: "parsed", value: JSON.parse(value) };
  } catch {
    return { kind: "malformed" };
  }
}

function legacyUnavailableSourceIdentity(): TokenSourceIdentity {
  return unavailableSourceIdentity(
    TokenSourceIdentityUnavailableReason.LegacyRecord
  );
}

function unavailableSourceIdentity(
  reason: TokenSourceIdentityUnavailableReason
): TokenSourceIdentity {
  return {
    availability: TokenSourceIdentityAvailability.Unavailable,
    reason,
  };
}

function legacyUnavailableCostSummary(): TokenCostSummary {
  return unavailableCostSummary(TokenCostCompletenessReason.LegacyRecord);
}

function unavailableCostSummary(
  reason: TokenCostCompletenessReason
): TokenCostSummary {
  return {
    completeness: TokenCostCompleteness.Unavailable,
    reason,
  };
}

const StoredTokenCostSummaryOrigin = {
  Local: "local",
} as const;

const storedLocalTokenCostSummarySchema = z
  .object({
    origin: z.literal(StoredTokenCostSummaryOrigin.Local),
    summary: tokenCostSummarySchema,
  })
  .strict();

const knownSourceIdentityDiscriminantSchema = z
  .object({ availability: z.enum(TokenSourceIdentityAvailability) })
  .passthrough();

const knownCostCompletenessDiscriminantSchema = z
  .object({ completeness: z.enum(TokenCostCompleteness) })
  .passthrough();

function transportIdentityCollisionError(
  sessionId: string,
  transportId: string
): Error {
  return new Error(
    `token event transport identity collision for session ${sessionId}: digest=${transportIdDiagnostic(transportId)}`
  );
}

function transportIdDiagnostic(transportId: string): string {
  return createHash("sha256").update(transportId).digest("hex").slice(0, 16);
}

const TOKEN_EVENT_INSERT_COLUMNS =
  "session_id, transport_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens, source_identity, cost_summary";
const TOKEN_EVENT_INSERT_COLUMN_COUNT = 12;
