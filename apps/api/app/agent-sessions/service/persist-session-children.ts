import { ERROR_EVENT_TERMS } from "@repo/api/src/agent-session-events";
import type {
  SyncedAgentSession,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import { Prisma } from "@repo/database";
import {
  maxDate,
  normalizeNullableString,
  roundCost,
  toDate,
} from "./coercion";
import type { AgentSessionUpsertTx } from "./records";

/**
 * Collapse events that share an `externalEventId` down to a single row (last
 * occurrence wins) before they reach the multi-row
 * `INSERT ... ON CONFLICT (agent_session_id, external_event_id) DO UPDATE` in
 * `persistSessionChildren`.
 *
 * Postgres aborts a statement with SQLSTATE 21000 ("ON CONFLICT DO UPDATE
 * command cannot affect row a second time") when one INSERT targets the same
 * conflict key twice, which would roll back the entire session upsert and make
 * the handler return `ingestion_failed` — the desktop then dead-letters after
 * retries, silently dropping *every* event for that session. The trust boundary
 * permits duplicates: the sync Zod schema does not enforce event-id uniqueness,
 * and the fragment transport concatenates event sets across fragment
 * materializations without dedup, so two rows with the same id can reach the
 * INSERT together. Collapsing them here keeps the upsert crash-safe. Last-wins
 * mirrors the `DO UPDATE SET ... = EXCLUDED` a re-sync would apply.
 */
function dedupeEventsByExternalId(
  events: SyncedAgentSession["events"]
): SyncedAgentSession["events"] {
  if (events.length < 2) {
    return events;
  }
  const byExternalId = new Map<string, SyncedAgentSession["events"][number]>();
  for (const event of events) {
    byExternalId.set(event.externalEventId, event);
  }
  return byExternalId.size === events.length
    ? events
    : [...byExternalId.values()];
}

/**
 * Persist a session's event + token-usage child rows (keyed on the session's
 * artifact id) and recompute the event-derived counts. Extracted from the
 * upsert loop to keep that method's cognitive complexity in check.
 */
export async function persistSessionChildren(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  session: SyncedAgentSession,
  normalizedTokenUsage: readonly SyncedAgentSessionTokenUsage[],
  shouldReplace = false
): Promise<void> {
  if (shouldReplace) {
    await tx.agentSessionEvent.deleteMany({
      where: { agentSessionId: artifactId },
    });
  }

  // Batch upsert events into the child table — single round-trip via raw SQL.
  // `id` is supplied inline via gen_random_uuid(): the Prisma schema's
  // @default(uuid(7)) is client-side and does not apply to raw SQL, and the
  // column has no DB default — omitting it produces a 23502 null violation on
  // every new event.
  //
  // Collapse duplicate externalEventIds first: the single multi-row
  // `INSERT ... ON CONFLICT DO UPDATE` below aborts with SQLSTATE 21000 if it
  // targets the same (agent_session_id, external_event_id) twice, which would
  // roll back the whole session upsert and dead-letter the sync — silently
  // dropping every event for the session (FEA-2690).
  const events = dedupeEventsByExternalId(session.events);
  if (events.length > 0) {
    const rows = events.map((event) => [
      artifactId,
      event.externalEventId,
      event.agentExternalId ?? null,
      event.eventType,
      event.toolName ?? null,
      new Date(event.createdAt),
    ]);
    const flatValues = rows.flat();
    const rowPlaceholders = rows
      .map((_, i) => {
        const base = i * 6;
        return `(gen_random_uuid(), $${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::timestamp)`;
      })
      .join(", ");
    await tx.$executeRawUnsafe(
      `INSERT INTO "agent_session_events" ("id", "agent_session_id", "external_event_id", "agent_external_id", "event_type", "tool_name", "event_created_at") VALUES ${rowPlaceholders} ON CONFLICT ("agent_session_id", "external_event_id") DO UPDATE SET "agent_external_id" = EXCLUDED."agent_external_id", "event_type" = EXCLUDED."event_type", "tool_name" = EXCLUDED."tool_name", "event_created_at" = EXCLUDED."event_created_at"`,
      ...flatValues
    );
  }

  // Recompute event-derived counts from the full child table. A single
  // conditional-aggregation query (COUNT(*) FILTER) collapses what were two
  // sequential COUNT round-trips — tool-use and errors — into one table scan
  // (FEA-2913). The FILTER predicates mirror the previous Prisma `count`
  // filters exactly:
  //   - tool-use: `event_type = 'tool_use'` OR a non-empty `tool_name`.
  //   - errors:   `event_type ILIKE '%<term>%'` for each ERROR_EVENT_TERMS
  //     entry, built from that SSOT so the persisted count keeps mirroring
  //     ERROR_EVENT_PATTERN (/error|fail/i) — matching the in-memory
  //     aggregateByTool classifier and the desktop countErrorEvents. `ILIKE`
  //     with an un-escaped `%<term>%` reproduces Prisma's case-insensitive
  //     `contains` semantics.
  const errorFilter =
    ERROR_EVENT_TERMS.map((_, i) => `"event_type" ILIKE $${i + 2}`).join(
      " OR "
    ) || "FALSE";
  const [counts] = await tx.$queryRawUnsafe<
    { toolUseCount: bigint; errorCount: bigint }[]
  >(
    `SELECT
       COUNT(*) FILTER (
         WHERE "event_type" = 'tool_use'
            OR ("tool_name" IS NOT NULL AND "tool_name" <> '')
       ) AS "toolUseCount",
       COUNT(*) FILTER (WHERE ${errorFilter}) AS "errorCount"
     FROM "agent_session_events"
     WHERE "agent_session_id" = $1::uuid`,
    artifactId,
    ...ERROR_EVENT_TERMS.map((term) => `%${term}%`)
  );
  const totalToolUse = Number(counts?.toolUseCount ?? 0);
  const totalErrors = Number(counts?.errorCount ?? 0);

  // Genuine-activity timestamp (PLN-1034): the latest real agent event, floored
  // at the session start. Derived ONLY from the cloud's persisted event stream
  // (the authoritative source) — NOT session_updated_at (bumped by OTEL ingest /
  // enrichment / sync), and NOT the incoming payload's lastActivityAt (a Desktop
  // hint the cloud should not trust over its own events). Monotonic via GREATEST
  // with the existing value so a replacement sync (events deleted + re-inserted
  // with a smaller/older set) can never move it backward.
  const latestEvent = await tx.agentSessionEvent.aggregate({
    where: { agentSessionId: artifactId },
    _max: { eventCreatedAt: true },
  });
  const existingDetail = await tx.sessionDetail.findUnique({
    where: { artifactId },
    select: { lastActivityAt: true },
  });
  const lastActivityAt = maxDate(
    existingDetail?.lastActivityAt,
    new Date(session.startedAt),
    latestEvent._max.eventCreatedAt
  );
  await tx.sessionDetail.update({
    where: { artifactId },
    data: {
      toolUseCount: totalToolUse,
      errorCount: totalErrors,
      lastActivityAt,
    },
  });

  // Token usage is a full per-model snapshot, replaced atomically. An empty
  // array means the payload carried no replacement data (non-desktop caller,
  // all-empty model strings dropped by normalizeTokenUsage, or a future
  // contract that omits tokenUsageByModel), so leave any previously persisted
  // rows untouched rather than destroying them. This mirrors the attribution
  // and agents resync rules above: a payload that simply omits data must never
  // clear it. Only when replacement rows are present do we delete + recreate.
  if (normalizedTokenUsage.length > 0) {
    await tx.agentSessionTokenUsage.deleteMany({
      where: { agentSessionId: artifactId },
    });
    await tx.agentSessionTokenUsage.createMany({
      data: normalizedTokenUsage.map((row) => ({
        agentSessionId: artifactId,
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        estimatedCost: roundCost(row.estimatedCostUsd ?? 0),
      })),
    });
  }

  // FEA-2730: persist the two new per-session sections. Both follow the same
  // "a payload that omits data must never clear it" rule as tokenUsage above.
  await persistSessionTokenEvents(tx, artifactId, session);
  await persistSessionAnalytics(tx, artifactId, session);
}

/**
 * FEA-2730 (G1): persist raw per-event token rows. These are an append-only,
 * keep-all log: `externalEventId` is a content hash of the immutable desktop row
 * (session + model + timestamp + token counts), so a row's identity IS its
 * content and `skipDuplicates` makes re-sync (and chunk/backfill overlap) an
 * idempotent no-op.
 *
 * Persistence is intentionally additive and never deletes — unlike the
 * snapshot-style `tokenUsageByModel` lane, there is NO revision-driven
 * delete-then-recreate here. That matters because the desktop chunker paginates
 * events and tokenEvents into SEPARATE chunks (each a distinct request): a
 * delete gated on the one-shot `shouldReplace` would fire on the first
 * (events-only) chunk and wipe every prior token-event row while its
 * replacements ride later chunks, leaving a data-visibility gap that becomes
 * permanent if the sync is interrupted mid-run. Append-only sidesteps that
 * entirely and is the correct model for an immutable raw-event stream.
 */
export async function persistSessionTokenEvents(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  session: SyncedAgentSession
): Promise<void> {
  const tokenEvents = session.tokenEvents ?? [];
  if (tokenEvents.length === 0) {
    return;
  }
  await tx.agentSessionTokenEvent.createMany({
    data: tokenEvents.map((event) => ({
      agentSessionId: artifactId,
      externalEventId: event.externalEventId,
      agentExternalId: event.agentExternalId ?? null,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      estimatedCost: roundCost(event.estimatedCostUsd ?? 0),
      eventCreatedAt: new Date(event.createdAt),
    })),
    skipDuplicates: true,
  });
}

/**
 * FEA-2730 (G10): upsert the desktop's per-session analytics rollup (1:1 on the
 * session artifact id; authoritative per Q16). Omission preserves any prior
 * rollup, mirroring the tokenUsage/attribution "omission never clears" rule.
 */
async function persistSessionAnalytics(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  session: SyncedAgentSession
): Promise<void> {
  const analytics = session.sessionAnalytics;
  if (!analytics) {
    return;
  }
  const data = {
    startedAt: toDate(analytics.startedAt),
    startedDay: analytics.startedDay ?? null,
    status: analytics.status ?? null,
    harness: analytics.harness ?? null,
    isHuman: analytics.isHuman,
    humanTurns: analytics.humanTurns,
    agentTurns: analytics.agentTurns,
    eventCount: analytics.eventCount,
    toolInvocations: analytics.toolInvocations,
    errorEvents: analytics.errorEvents,
    inputTokens: analytics.inputTokens,
    outputTokens: analytics.outputTokens,
    cacheReadTokens: analytics.cacheReadTokens,
    cacheWriteTokens: analytics.cacheWriteTokens,
    estimatedCost: roundCost(analytics.estimatedCostUsd ?? 0),
    runtimeMs: analytics.runtimeMs ?? null,
    rollupUpdatedAt: toDate(analytics.updatedAt),
    lastSyncedAt: new Date(),
  };
  await tx.agentSessionUsageRollup.upsert({
    where: { artifactId },
    create: { artifactId, ...data },
    update: data,
  });
}

/**
 * Attribution-derived SessionDetail columns. Kept separate from the always-
 * overwritten mutable columns because attribution is optional on the wire
 * (older Desktop builds, chunked/partial payloads) and must never be cleared
 * by a payload that simply omits it.
 */
type SessionAttributionColumns = {
  repositoryFullName: string | null;
  worktreePath: string | null;
  sourceArtifactId: string | null;
  sourceLoopId: string | null;
  baseBranch: string | null;
};

type NullableJsonPatch =
  | Prisma.NullableJsonNullValueInput
  | Prisma.InputJsonValue;

type SessionTraceDetailPatch = {
  billingMode?: string | null;
  branch?: string | null;
  pullRequests?: NullableJsonPatch;
  wallClock?: string | null;
  activeAgent?: string | null;
  waitingUser?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
  locSource?: string | null;
  branchLinesAdded?: number | null;
  branchLinesRemoved?: number | null;
  branchFilesChanged?: number | null;
  branchLocSource?: string | null;
  turns?: number | null;
  steeringEpisodes?: number | null;
  autonomy?: number | null;
  activityBuckets?: NullableJsonPatch;
  sessionSpan?: NullableJsonPatch;
  markers?: NullableJsonPatch;
  throttles?: NullableJsonPatch;
  tracePhaseSources?: NullableJsonPatch;
  throttleSources?: NullableJsonPatch;
  correctionSources?: NullableJsonPatch;
  phases?: NullableJsonPatch;
  phaseIterations?: NullableJsonPatch;
  phaseLoopbacks?: NullableJsonPatch;
};

export function toAttributionColumns(
  session: SyncedAgentSession
): SessionAttributionColumns {
  return {
    repositoryFullName: normalizeNullableString(
      session.attribution?.repositoryFullName
    ),
    worktreePath: normalizeNullableString(session.attribution?.worktreePath),
    sourceArtifactId: normalizeNullableString(
      session.attribution?.sourceArtifactId
    ),
    sourceLoopId: normalizeNullableString(session.attribution?.sourceLoopId),
    baseBranch: normalizeNullableString(session.attribution?.baseBranch),
  };
}

export function toNullableJsonPatch(value: unknown): NullableJsonPatch {
  return value == null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/**
 * Sync-owned Session Trace detail fields. Undefined means the desktop build did
 * not send the field and existing cloud values must be preserved; null is an
 * intentional clear for nullable storage.
 */
export function toTraceDetailPatch(
  session: SyncedAgentSession
): SessionTraceDetailPatch {
  const patch: SessionTraceDetailPatch = {};
  setPatchValue(
    patch,
    "billingMode",
    session.billingMode,
    normalizeNullableString
  );
  setPatchValue(patch, "branch", session.branch, normalizeNullableString);
  setPatchValue(patch, "pullRequests", session.prs, toNullableJsonPatch);
  setPatchValue(patch, "wallClock", session.wallClock, normalizeNullableString);
  setPatchValue(
    patch,
    "activeAgent",
    session.activeAgent,
    normalizeNullableString
  );
  setPatchValue(
    patch,
    "waitingUser",
    session.waitingUser,
    normalizeNullableString
  );
  // gitDiffStats is the source-tagged variant of the loose lines/files scalars.
  // Persist it into the same dedicated columns, preferring it when present so a
  // git-derived count wins over a heuristic scalar from the same payload. The
  // source tag is recorded separately in loc_source so readers can rehydrate
  // gitDiffStats and distinguish git-derived LOC from agent-estimated scalars.
  setPatchValue(
    patch,
    "linesAdded",
    session.gitDiffStats?.linesAdded ?? session.linesAdded,
    identityPatchValue
  );
  setPatchValue(
    patch,
    "linesRemoved",
    session.gitDiffStats?.linesRemoved ?? session.linesRemoved,
    identityPatchValue
  );
  setPatchValue(
    patch,
    "filesChanged",
    session.gitDiffStats?.filesChanged ?? session.filesChanged,
    identityPatchValue
  );
  // Record provenance whenever the payload carries any LOC signal. A present
  // gitDiffStats tags the scalars as "git"; loose scalars alone clear the marker
  // so a re-sync without git stats does not keep rendering stale LOC as git.
  setPatchValue(
    patch,
    "locSource",
    resolveLocSourcePatch(session),
    identityPatchValue
  );
  // branchDiffStats is branch-level LOC (working-branch changes vs the author's
  // contributed lines) — a distinct metric kept in dedicated branch_* columns so
  // it never collides with the gitDiffStats scalars above.
  applyBranchDiffStatsPatch(patch, session.branchDiffStats);
  setPatchValue(patch, "turns", session.turns, identityPatchValue);
  setPatchValue(
    patch,
    "steeringEpisodes",
    session.steeringEpisodes,
    identityPatchValue
  );
  setPatchValue(patch, "autonomy", session.autonomy, identityPatchValue);
  setPatchValue(
    patch,
    "activityBuckets",
    session.activityBuckets,
    toNullableJsonPatch
  );
  setPatchValue(patch, "sessionSpan", session.span, toNullableJsonPatch);
  setPatchValue(patch, "markers", session.markers, toNullableJsonPatch);
  setPatchValue(patch, "throttles", session.throttles, toNullableJsonPatch);
  setPatchValue(
    patch,
    "tracePhaseSources",
    session.tracePhaseSources,
    toNullableJsonPatch
  );
  setPatchValue(
    patch,
    "throttleSources",
    session.throttleSources,
    toNullableJsonPatch
  );
  setPatchValue(
    patch,
    "correctionSources",
    session.correctionSources,
    toNullableJsonPatch
  );
  setPatchValue(patch, "phases", session.phases, toNullableJsonPatch);
  setPatchValue(
    patch,
    "phaseIterations",
    session.phaseIterations,
    toNullableJsonPatch
  );
  setPatchValue(
    patch,
    "phaseLoopbacks",
    session.phaseLoopbacks,
    toNullableJsonPatch
  );
  return patch;
}

/**
 * Provenance for the flattened LOC scalar columns. "git" when the payload
 * carries source-tagged gitDiffStats; null when only loose scalars are present
 * (clears a stale marker on re-sync); undefined when the payload omits LOC
 * entirely so the existing column value is preserved.
 */
function resolveLocSourcePatch(
  session: SyncedAgentSession
): string | null | undefined {
  if (session.gitDiffStats) {
    return session.gitDiffStats.source;
  }
  const hasLooseScalars =
    session.linesAdded !== undefined ||
    session.linesRemoved !== undefined ||
    session.filesChanged !== undefined;
  return hasLooseScalars ? null : undefined;
}

/**
 * Persist branchDiffStats into its dedicated branch_* columns. Branch LOC has no
 * loose-scalar counterpart, so the source-tagged object owns all four columns:
 * omission (undefined) preserves the existing values, while an explicit null
 * clears them together (mirroring the nullable-clear convention of the patch).
 */
export function applyBranchDiffStatsPatch(
  patch: SessionTraceDetailPatch,
  branchDiffStats: SyncedAgentSession["branchDiffStats"]
): void {
  if (branchDiffStats === undefined) {
    return;
  }
  patch.branchLinesAdded = branchDiffStats?.linesAdded ?? null;
  patch.branchLinesRemoved = branchDiffStats?.linesRemoved ?? null;
  patch.branchFilesChanged = branchDiffStats?.filesChanged ?? null;
  patch.branchLocSource = branchDiffStats?.source ?? null;
}

function setPatchValue<T, TKey extends keyof SessionTraceDetailPatch>(
  patch: SessionTraceDetailPatch,
  key: TKey,
  value: T | undefined,
  mapValue: (value: T) => SessionTraceDetailPatch[TKey]
): void {
  if (value !== undefined) {
    patch[key] = mapValue(value);
  }
}

function identityPatchValue<T>(value: T): T {
  return value;
}

/**
 * Update-arm projection of {@link toAttributionColumns}: only non-null values,
 * so an attribution-less resync preserves previously captured attribution
 * (mirrors the parent artifact's connect-only project handling).
 */
export function toNonNullAttributionPatch(
  columns: SessionAttributionColumns
): Partial<SessionAttributionColumns> {
  return Object.fromEntries(
    Object.entries(columns).filter(([, value]) => value !== null)
  );
}
