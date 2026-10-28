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
import { effectiveParsePolicy } from "../parse-policy/effective-parse-policy.js";
import { EVENT_INSERT_PARAM_CAP } from "./db-constants.js";
import { tokenCountValue } from "./db-helpers.js";
import type { Prisma } from "./generated/client.js";
import {
  CANONICAL_UTC_TIMESTAMP_GLOB_SQL,
  canonicalizeHealableTimestampSql,
  isCanonicalUtcTimestamp,
} from "./session-timestamp-form.js";
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
 * ISS-7448: which text form BOTH sides of an append's high-water-mark
 * comparison are expressed in. `token_events.created_at` is TEXT outside
 * `HEALED_COLUMNS`, so `MAX` and the JS `<`/`===` below it are all byte
 * compares, and byte order is instant order only when every operand carries the
 * same fixed-width canonical spelling.
 */
const TokenEventTimestampForm = {
  Canonical: "canonical",
  Stored: "stored",
} as const;

type TokenEventTimestampForm =
  (typeof TokenEventTimestampForm)[keyof typeof TokenEventTimestampForm];

type TokenEventHighWaterMark = {
  form: TokenEventTimestampForm;
  value: string | null;
};

type TokenEventHighWaterMarkRow = {
  stored_hwm: string | null;
  canonical_hwm: string | null;
  stored_form: string;
};

/**
 * Replace a session's complete token-event derivation. Generated fallback IDs
 * include the stable array occurrence, so equal-content records stay distinct
 * and a replay of the same normalized series produces the same IDs.
 */
export async function replaceTokenEvents(
  tx: Prisma.TransactionClient,
  sessionId: string,
  records: readonly TokenEventRecord[],
  ownerAttribution: boolean = effectiveParsePolicy().attributionEvidence
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
  await insertTokenEventsBatched(
    tx,
    sessionId,
    persistedRecords,
    ownerAttribution
  );
  return persistedRecords;
}

/**
 * Append live records newer than the stored high-water mark. Equal-timestamp
 * rows are admitted and the persisted transport identity—not content—decides
 * replay. A reused ID with different immutable usage fails loudly.
 *
 * The mark and the two comparisons below it share ONE text form — see
 * {@link loadTokenEventHighWaterMark}.
 */
export async function appendTokenEvents(
  tx: Prisma.TransactionClient,
  sessionId: string,
  records: readonly TokenEventRecord[],
  ownerAttribution: boolean = effectiveParsePolicy().attributionEvidence
): Promise<PersistedTokenEventRecord[]> {
  const persistedRecords = materializeTokenEventRecords(sessionId, records);
  const hwm = await loadTokenEventHighWaterMark(
    tx,
    sessionId,
    persistedRecords
  );
  const replayRowsByTransportId = await loadOlderExplicitReplayRows(
    tx,
    sessionId,
    records,
    persistedRecords,
    hwm.value
  );
  const legacyIdentityCounts =
    hwm.value !== null &&
    persistedRecords.some((record) => record.timestamp === hwm.value)
      ? await loadLegacyTokenEventIdentityCounts(tx, sessionId, hwm.form)
      : new Map<string, number>();
  const insertedRecords: PersistedTokenEventRecord[] = [];
  for (const [index, record] of persistedRecords.entries()) {
    if (
      !record.timestamp ||
      (hwm.value !== null && record.timestamp < hwm.value)
    ) {
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
      record.timestamp === hwm.value &&
      consumeLegacyTokenEventIdentity(legacyIdentityCounts, sessionId, record)
    ) {
      continue;
    }
    const inserted = await insertTokenEvent(
      tx,
      sessionId,
      record,
      ownerAttribution
    );
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

/**
 * ISS-7448: the pre-0043 content identities, keyed in the SAME text form the
 * mark is. The identity hash covers `created_at`, so in canonical mode a legacy
 * row still spelled `…T06:59:00Z` would not match today's `…T06:59:00.000Z`
 * re-derivation of the same event — and, having moved out of the `<` branch when
 * the mark canonicalized, would be re-inserted on every hook event. The stored
 * form is unchanged and so is the pre-0043 sync id built from it
 * (`buildReusableTokenEventTransportIds`); only this count map's bucket key
 * moves.
 */
async function loadLegacyTokenEventIdentityCounts(
  tx: Prisma.TransactionClient,
  sessionId: string,
  form: TokenEventTimestampForm
): Promise<Map<string, number>> {
  const createdAtExpr =
    form === TokenEventTimestampForm.Canonical
      ? canonicalizeHealableTimestampSql("created_at")
      : "created_at";
  const rows = await tx.$queryRawUnsafe<StoredTokenEventIdentityRow[]>(
    `SELECT transport_id, model, ${createdAtExpr} AS created_at, input_tokens,
            output_tokens, cache_read_tokens, cache_write_tokens,
            cache_write_5m_tokens, cache_write_1h_tokens
       FROM token_events
      WHERE session_id = $1 AND transport_id IS NULL`,
    sessionId
  );
  return buildLegacyTokenEventIdentityCounts(sessionId, rows);
}

/**
 * ISS-7448: the session's newest stored instant, plus the text form it and the
 * caller's comparisons are expressed in. Two modes, never mixed — ISS-5497's
 * rule, and load-bearing here rather than conservative.
 *
 * CANONICAL requires both sides to be canonical already: every stored
 * `created_at` re-expressible by `canonicalizeHealableTimestampSql` (the SSOT
 * for what a stored timestamp's text form means), AND every incoming record
 * already carrying the canonical spelling. Then `MAX` returns the true latest
 * instant and the caller's `<`/`===` over the records' own text are exact.
 * Requiring the incoming side to be canonical rather than canonicalizing it is
 * what keeps the comparison single-reader: no JS timestamp parser is involved,
 * so the ISS-5496 zone-less disagreement between `Date.parse` and SQLite's
 * default parse cannot reach this decision. It also keeps a record whose
 * spelling drifted from its stored row on the STORED-form path, where its own
 * byte-equal `===` still finds the legacy identity.
 *
 * The stored side has a SECOND requirement, and it is the one that keeps this
 * mode from trading a silent drop for a duplicate (whitlockk review): every
 * noncanonical row must be a pre-0043 `transport_id IS NULL` row. Healing the
 * mark moves such a row's re-presentation off the `<` branch and onto the
 * insert path, so something has to recognize it there. For a NULL-transport row
 * {@link loadLegacyTokenEventIdentityCounts} does, by re-deriving its content
 * hash from the SAME canonicalized `created_at`. For a row carrying a GENERATED
 * id nothing can: that id hashes the record's array `occurrence`, which is not a
 * column, so a stored row's generated id is unrecoverable from the row — and a
 * re-presentation spelled canonically hashes to a DIFFERENT id, which the
 * partial unique index on `(session_id, transport_id)` then reads as a new
 * event and inserts alongside the old one. Declining the mode is not a widening
 * of the guard; it is this function's own rule applied to the dissenter that
 * has no stable identity across the heal.
 *
 * Any dissenter on either side yields STORED — `MAX(created_at)` verbatim, which
 * cannot regress anything because it is what shipped. Dropping the dissenting
 * operand instead of the whole mode is the OTHER half of ISS-5497's rule, and it
 * is the one that bites here: `MAX(canonical)` ignores the NULL a declined shape
 * yields, so the row that could have won is exactly the row it discards.
 *
 * KNOWN COST, accepted. The old `MAX(created_at)` was a single index seek; this
 * walks the session's entries in the same covering index
 * (`idx_token_events_session_created` — `EXPLAIN QUERY PLAN` reports
 * `SEARCH … USING COVERING INDEX … (session_id=?)` for both), two GLOBs per row
 * on the common all-canonical store. Measured on the bundled engine at 1,000
 * rows: 1.3us seek -> 4.0ms scan. That is not a new asymptotic class — the live
 * hook re-presents the WHOLE series on every event, so `appendTokenEvents` was
 * already linear per call, and its `generatedTransportId` hashing alone measures
 * 7.5ms at the same width. The derived table keeps the canonicalization to one
 * evaluation per row rather than one per aggregate.
 */
async function loadTokenEventHighWaterMark(
  tx: Prisma.TransactionClient,
  sessionId: string,
  records: readonly PersistedTokenEventRecord[]
): Promise<TokenEventHighWaterMark> {
  const rows = await tx.$queryRawUnsafe<TokenEventHighWaterMarkRow[]>(
    `SELECT MAX(created_at) AS stored_hwm,
            MAX(canonical) AS canonical_hwm,
            CASE WHEN COUNT(canonical) = COUNT(created_at)
                      AND COUNT(unhealable_identity) = 0
                 THEN '${TokenEventTimestampForm.Canonical}'
                 ELSE '${TokenEventTimestampForm.Stored}' END AS stored_form
       FROM (
         SELECT created_at,
                ${canonicalizeHealableTimestampSql("created_at")} AS canonical,
                CASE WHEN transport_id IS NOT NULL
                          AND created_at NOT GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
                     THEN 1 END AS unhealable_identity
           FROM token_events
          WHERE session_id = $1
       )`,
    sessionId
  );
  const row = rows[0];
  const canonical =
    row?.stored_form === TokenEventTimestampForm.Canonical &&
    records.every(
      (record) => !record.timestamp || isCanonicalUtcTimestamp(record.timestamp)
    );
  if (canonical) {
    return {
      form: TokenEventTimestampForm.Canonical,
      value: row?.canonical_hwm ?? null,
    };
  }
  return {
    form: TokenEventTimestampForm.Stored,
    value: row?.stored_hwm ?? null,
  };
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
  records: readonly PersistedTokenEventRecord[],
  ownerAttribution: boolean
): Promise<void> {
  const rows = records.flatMap((record) => {
    if (!record.timestamp) {
      return [];
    }
    return [tokenEventInsertRow(sessionId, record, ownerAttribution)];
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
  record: PersistedTokenEventRecord,
  ownerAttribution: boolean
): Promise<number> {
  const row = tokenEventInsertRow(sessionId, record, ownerAttribution);
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
  record: PersistedTokenEventRecord,
  ownerAttribution: boolean
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
    // ISS-12552: NULL is the main agent, and every owner with the attribution
    // policy off (PRD-800 "Rollout"), as before PRD-800.
    ownerAttribution ? (record.subagentId ?? null) : null,
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

/** Discriminant of the persisted local-cost envelope. Exported so a fixture
 *  cannot re-declare the raw `"local"` and go on passing after a rename. */
export const StoredTokenCostSummaryOrigin = {
  Local: "local",
} as const;

/**
 * ISS-7822: the persisted local-cost envelope, and it is deliberately
 * `.passthrough()` where every sibling schema in this file is `.strict()`.
 *
 * Which side of the `.strict()`-boundary rule this sits on is the whole
 * decision. A strict schema is right at a TRUST boundary — a wire payload, an
 * IPC/worker message, a cross-repo contract — where an unknown key is evidence
 * that the peer is speaking a shape this build cannot honour and the loud
 * rejection is the point. The inner {@link tokenCostSummarySchema} is exactly
 * that and stays strict.
 *
 * This envelope is not that. It is a SELF-AUTHORED local cache: the only writer
 * is {@link serializeTokenEventCostSummary} a few lines up, in this same
 * codebase, and the only reader is this build reading its own SQLite file. The
 * sole way an unknown key gets here is a NEWER build of this same program
 * adding one — version skew against ourselves — and strictness against that
 * buys nothing while costing everything: the parse fails, both fallbacks below
 * it fail, and a real locally-computed cost sitting inside the envelope's own
 * `summary` is reported as `Unavailable`/`Unknown` instead. That degraded value
 * then reaches the cloud through `token-event-sync.ts`, AND stops the row
 * reading as locally derived, so `producerCostSummary`
 * (`token-cost-maintenance.ts`) treats it as authoritative producer evidence
 * and the reprice sweep built to reheal it can no longer see the row.
 *
 * So: do not "re-harden" this to `.strict()`. Tolerating an additive key from a
 * future build is what lets an older reader keep the cost it already has. The
 * discriminant (`origin`) and the payload (`summary`) are still validated, so a
 * blob that is not this envelope is still rejected here and falls through to the
 * producer-shape parse exactly as before.
 */
const storedLocalTokenCostSummarySchema = z
  .object({
    origin: z.literal(StoredTokenCostSummaryOrigin.Local),
    summary: tokenCostSummarySchema,
  })
  .passthrough();

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
  "session_id, transport_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens, source_identity, cost_summary, agent_id";
const TOKEN_EVENT_INSERT_COLUMN_COUNT = 13;
