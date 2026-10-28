import { ERROR_EVENT_TERMS } from "@repo/api/src/agent-session-events";
import type {
  SyncedAgentSession,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import {
  BranchParticipationKind,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import type { SyncedArtifactRef } from "@repo/api/src/types/session-artifact-link";
import {
  normalizeSessionStatus,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import { Prisma } from "@repo/database";
import { normalizeRepositoryIdentity } from "@repo/lib/sessions/repository-identity";
import { isStorableInt4Count } from "@/lib/int4-column-bounds";
import { persistSessionActivityMetrics } from "./activity-metrics-persistence";
import {
  type ActivityTilingSkipReason,
  type ActivityTilingSkipReport,
  persistSessionActivitySegments,
} from "./activity-segment-persistence";
import {
  isPaginatedPrListPageZero,
  isPrRefContinuationPart,
} from "./artifact-links/session-pr-link-merge";
import { collectBranchRefs } from "./artifact-links/shared";
import { normalizeNullableString, roundCost, toDate } from "./coercion";
import { resolveGuardedStatus } from "./field-regression-guards";
import type { AgentSessionUpsertTx } from "./records";
import { persistSessionEventRows } from "./session-event-persistence";
import { resolvePullRequestsBlobPatchInput } from "./session-pull-requests-blob";
import {
  UNSTORABLE_ROLLUP_FIELD_PREFIX,
  UNSTORABLE_SESSION_DETAIL_FIELD_PREFIX,
} from "./session-sync-metrics";
import { persistSessionTokenEvents } from "./token-event-persistence";

/**
 * Persist a session's event + token-usage child rows (keyed on the session's
 * artifact id) and recompute the event-derived counts. Extracted from the
 * upsert loop to keep that method's cognitive complexity in check.
 *
 * Org isolation (apps/api/AGENTS.md "Org scoping"). These child tables carry no
 * `organization_id` column of their own — org lives on the parent `artifacts`
 * row (JOIN-REACHED design, see the schema doc comments) — so tenant isolation
 * holds in two complementary layers:
 *
 *   1. OWNERSHIP IS PROVEN ONCE AT THE CALLER, WITHOUT AN EXTRA QUERY HERE. The
 *      only caller (`upsertSessions` in `../service.ts`) runs a fail-closed
 *      `computeTarget.findFirst({ id, organizationId })` — in
 *      `service/resolve-batch-lookups.ts`, a pooled read BEFORE any per-session
 *      transaction opens, so it gates the whole batch rather than each write —
 *      that throws `compute_target_not_found` for a cross-org target, then derives
 *      `artifactId` from a `session_detail` row keyed on that same
 *      `computeTargetId` (its `findUnique`/`upsert` both key on
 *      `computeTargetId_externalSessionId`, and the create arm connects the
 *      artifact to `organizationId`). Because `session_detail.computeTargetId`
 *      FK-references the org-verified compute target, the `artifactId` handed to
 *      this helper is provably owned by `organizationId` — so the WRITE lanes
 *      that key on `agentSessionId = artifactId` alone (the raw
 *      `agent_session_events` INSERT, the token-usage `createMany`, and the
 *      downstream token-event / activity-segment / analytics writes) cannot
 *      touch another tenant's rows. This ownership proof is the caller's single
 *      compute-target check, not a per-session round-trip in this hot path
 *      (which would regress the 4-to-2 round-trip collapse this file exists to
 *      make; ISS-4439).
 *   2. IN-QUERY PREDICATES (defence in depth). The Prisma delete lanes still
 *      filter on `session.artifact.organizationId`, and the two raw statements
 *      (the counts SELECT and the `session_detail` UPDATE) still constrain via
 *      the `artifacts` row that owns the session, so a cross-org `artifactId`
 *      matches nothing — the counts scan reads zero rows and the UPDATE touches
 *      zero rows — even if the caller's guarantee were ever bypassed.
 */
export type PersistSessionChildrenResult = {
  lastActivityAt: Date | null;
  maxEventCreatedAt: Date | null;
  /**
   * ISS-7265: whether activity-segment rows were actually WRITTEN by this slice.
   * Distinct from "the payload carried rows" — `persistSessionActivitySegments`
   * has three paths that carry rows and persist none of them — and it is the
   * only honest basis for clearing a recorded tiling strip.
   */
  activityTilingPersisted: boolean;
  /**
   * ISS-8603: why this slice's tiling append was refused, or `null` if it was
   * not. Carried UP rather than emitted here for the reason
   * `unstorableCounterFields` below is — the batch emits once per request. NOT
   * derivable from `activityTilingPersisted`: three different refusals all
   * produce that same `false`.
   */
  activityTilingSkipReason: ActivityTilingSkipReason | null;
  /**
   * ISS-8881: the rollup counter fields this payload could not store, carried UP
   * rather than reported here. The slice merges them with the trace-detail
   * counters it collected separately, and the batch emits once per request — the
   * amplification bound `session-slice-result.ts` states for its siblings.
   */
  unstorableCounterFields: string[];
};

export async function persistSessionChildren(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  organizationId: string,
  session: SyncedAgentSession,
  normalizedTokenUsage: readonly SyncedAgentSessionTokenUsage[],
  options: {
    /** The guarded lifecycle status this slice writes to `artifacts.status`. */
    guardedStatus: SessionStatus;
    shouldReplace: boolean;
    shouldUpdateTokenEventCosts: boolean;
  }
): Promise<PersistSessionChildrenResult> {
  // ISS-8881: collected here, reported once per REQUEST by the batch.
  const unstorableCounterFields: string[] = [];
  if (options.shouldReplace) {
    await tx.agentSessionEvent.deleteMany({
      where: {
        agentSessionId: artifactId,
        // Org-scope the destructive delete through the parent artifact so a
        // cross-org artifactId can never wipe another tenant's event rows.
        session: { artifact: { organizationId } },
      },
    });
  }

  // Batch upsert events into the child table, deduped and chunked so the
  // statement width is bounded independently of the session's event count
  // (ISS-10168). The bound and the two ceilings it clears are named on
  // `AGENT_SESSION_EVENT_INSERT_CHUNK_SIZE`.
  await persistSessionEventRows(tx, artifactId, session.events);

  // Recompute event-derived counts AND the latest genuine-activity timestamp
  // from the full child table in ONE conditional-aggregation scan. Two
  // COUNT(*) FILTER predicates collapse what were two sequential COUNT
  // round-trips — tool-use and errors — into one table scan (FEA-2913), and
  // MAX("event_created_at") folds the previously-separate `_max` aggregate into
  // that same scan over the identical `WHERE agent_session_id = $1` rows
  // (ISS-4439). The FILTER predicates mirror the previous Prisma `count`
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
  // The org predicate is the last positional bind ($N, after artifactId and the
  // ERROR_EVENT_TERMS ILIKE params) so the existing param positions ($1 =
  // artifactId, $2.. = error terms) are unchanged. It scopes the scan through
  // the parent `artifacts` row: a cross-org artifactId matches no artifact, so
  // the EXISTS is false and the aggregate reads zero rows.
  const countsOrgParam = ERROR_EVENT_TERMS.length + 2;
  const [counts] = await tx.$queryRawUnsafe<
    {
      toolUseCount: bigint;
      errorCount: bigint;
      maxEventCreatedAt: Date | null;
    }[]
  >(
    `SELECT
       COUNT(*) FILTER (
         WHERE "event_type" = 'tool_use'
            OR ("tool_name" IS NOT NULL AND "tool_name" <> '')
       ) AS "toolUseCount",
       COUNT(*) FILTER (WHERE ${errorFilter}) AS "errorCount",
       MAX("event_created_at") AS "maxEventCreatedAt"
     FROM "agent_session_events"
     WHERE "agent_session_id" = $1::uuid
       AND EXISTS (
         SELECT 1 FROM "artifacts"
          WHERE "artifacts"."id" = $1::uuid
            AND "artifacts"."organization_id" = $${countsOrgParam}::uuid
       )`,
    artifactId,
    ...ERROR_EVENT_TERMS.map((term) => `%${term}%`),
    organizationId
  );
  const totalToolUse = Number(counts?.toolUseCount ?? 0);
  const totalErrors = Number(counts?.errorCount ?? 0);
  const maxEventCreatedAt = counts?.maxEventCreatedAt ?? null;

  // Genuine-activity timestamp (PLN-1034): the latest real agent event, floored
  // at the session start. Derived ONLY from the cloud's persisted event stream
  // (the authoritative MAX("event_created_at") above) — NOT session_updated_at
  // (bumped by OTEL ingest / enrichment / sync), and NOT the incoming payload's
  // lastActivityAt (a Desktop hint the cloud should not trust over its own
  // events). The monotonic GREATEST — including the column's own existing value —
  // now runs inside this single UPDATE (ISS-4439) so the counts and the advanced
  // timestamp land in one write with no preceding read of session_detail, and a
  // replacement sync (events deleted + re-inserted with a smaller/older set) can
  // still never move it backward. The parent sessionDetail.upsert always created
  // this row before persistSessionChildren runs, so the UPDATE matches exactly
  // one row. GREATEST ignores NULL operands, mirroring maxDate's skip semantics.
  const startedAt = new Date(session.startedAt);
  const startedAtParam = Number.isNaN(startedAt.getTime()) ? null : startedAt;
  // Org-scope the authoritative counts/last_activity_at write through the parent
  // `artifacts` row ($6, appended so $1..$5 keep their positions). The
  // `session_detail.artifact_id` -> `artifacts.id` join is 1:1, so this matches
  // exactly one row for an in-org session and zero rows for a cross-org
  // artifactId. `last_activity_at`/`artifact_id` are session_detail-only columns
  // so they stay unqualified (unambiguous under the join).
  const [updatedDetail] = await tx.$queryRawUnsafe<
    { lastActivityAt: Date | null }[]
  >(
    `UPDATE "session_detail"
        SET "tool_use_count" = $2,
            "error_count" = $3,
            "last_activity_at" = GREATEST("last_activity_at", $4::timestamp, $5::timestamp)
       FROM "artifacts"
      WHERE "artifact_id" = $1::uuid
        AND "artifacts"."id" = "artifact_id"
        AND "artifacts"."organization_id" = $6::uuid
      RETURNING "last_activity_at" AS "lastActivityAt"`,
    artifactId,
    totalToolUse,
    totalErrors,
    startedAtParam,
    maxEventCreatedAt,
    organizationId
  );
  const lastActivityAt = updatedDetail?.lastActivityAt ?? null;

  // Token usage is a full per-model snapshot, replaced atomically. An empty
  // array means the payload carried no replacement data (non-desktop caller,
  // all-empty model strings dropped by normalizeTokenUsage, or a future
  // contract that omits tokenUsageByModel), so leave any previously persisted
  // rows untouched rather than destroying them. This mirrors the attribution
  // and agents resync rules above: a payload that simply omits data must never
  // clear it. Only when replacement rows are present do we delete + recreate.
  // ISS-8515: BOTH conditions, and the second is new. Omission still preserves
  // (the array is empty when the payload carried no replacement rows), and now
  // staleness preserves too — ruling 1 requires the per-model table to move in the
  // same freshness unit as the rollup columns and the cost, so a stale batch
  // changes none of the three. Without this gate the aggregate and the per-model
  // rows could be written from different vintages, and the session read serves
  // the counts and the cost as a matched pair.
  if (normalizedTokenUsage.length > 0 && options.shouldUpdateTokenEventCosts) {
    await tx.agentSessionTokenUsage.deleteMany({
      where: {
        agentSessionId: artifactId,
        // Org-scope the destructive delete through the parent artifact (same
        // boundary as the event delete above).
        session: { artifact: { organizationId } },
      },
    });
    await tx.agentSessionTokenUsage.createMany({
      data: normalizedTokenUsage.map((row) => ({
        agentSessionId: artifactId,
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        // FEA-3419: additive TTL subdivision; null = never reported (absent).
        cacheWrite5mTokens: row.cacheWrite5mTokens ?? null,
        cacheWrite1hTokens: row.cacheWrite1hTokens ?? null,
        estimatedCost: roundCost(row.estimatedCostUsd ?? 0),
      })),
    });
  }

  // FEA-2730: persist the two new per-session sections. Both follow the same
  // "a payload that omits data must never clear it" rule as tokenUsage above.
  await persistSessionTokenEvents(
    tx,
    artifactId,
    organizationId,
    session,
    options.shouldUpdateTokenEventCosts
  );
  await persistSessionAnalytics(
    tx,
    artifactId,
    session,
    options.shouldUpdateTokenEventCosts,
    options.guardedStatus,
    unstorableCounterFields
  );
  // ISS-8603: filled in by the lane below, reported once per REQUEST by the
  // batch.
  const activityTilingSkips: ActivityTilingSkipReport = {
    refusalReason: null,
  };
  // ISS-4541: chunk-aware activity-segment persistence. `shouldReplace` is the
  // caller's chunk-0-of-an-advancing-revision signal (from `resolveChunkGating`):
  // chunk 0 delete-replaces the stored tiling; every later chunk appends its slice
  // idempotently. See `persistSessionActivitySegments`.
  const activityTilingPersisted = await persistSessionActivitySegments(
    tx,
    artifactId,
    organizationId,
    session,
    options.shouldReplace,
    activityTilingSkips
  );

  // ISS-10721: the activity-metrics rollup rides the same payload as the tiling
  // it summarizes, and is keyed on the session rather than on a chunk, so it is
  // upserted here once per part that carries it — behind the same freshness
  // watermark as the per-event costs and the analytics rollup, so a reordered
  // delivery cannot regress it past what the guarded columns accepted.
  await persistSessionActivityMetrics(
    tx,
    artifactId,
    session,
    options.shouldUpdateTokenEventCosts
  );

  return {
    activityTilingPersisted,
    activityTilingSkipReason: activityTilingSkips.refusalReason,
    lastActivityAt,
    maxEventCreatedAt,
    unstorableCounterFields,
  };
}

/**
 * The five `AgentSessionUsageRollup` counters that are Postgres `int4`.
 *
 * ISS-8881: their neighbours `inputTokens`/`outputTokens`/`cacheReadTokens`/
 * `cacheWriteTokens` are `BigInt` and genuinely safe at the wire's 2^53
 * envelope, and `runtimeMs` is `BigInt?` — which is why the reasoning already in
 * this file does not cover these five. They are the only unguarded fields in the
 * object.
 *
 * Derived from an exhaustive `Record` rather than written out as a bare array so
 * a sixth `int4` counter cannot be added to the rollup without failing `tsc`
 * here — the side-inventory hole the root `AGENTS.md` names.
 */
const ROLLUP_INT4_COUNTERS: Record<
  | "humanTurns"
  | "agentTurns"
  | "eventCount"
  | "toolInvocations"
  | "errorEvents",
  true
> = {
  agentTurns: true,
  errorEvents: true,
  eventCount: true,
  humanTurns: true,
  toolInvocations: true,
};

const ROLLUP_COUNTER_FIELDS = Object.keys(ROLLUP_INT4_COUNTERS) as Array<
  keyof typeof ROLLUP_INT4_COUNTERS
>;

/**
 * Whether a rollup counter can be stored in its `int4` column.
 *
 * SCOPE, stated so the next reader does not over-trust this guard: it covers the
 * five `int4` COUNTERS only. `estimatedCost` on the same statement is
 * `Decimal(14,6)` and reaches it through `roundCost`, which rounds without
 * bounding, while the wire declares only `.finite().nonnegative()` — so a
 * sufficiently large cost still raises `22003` on this very write, with the same
 * deterministic poison-retry shape. That is a different column type and a
 * different ticket; ISS-8881 is the nine int4 counters.
 */
function isStorableRollupCounter(value: number): boolean {
  return isStorableInt4Count(value);
}

/**
 * FEA-2730 (G10): upsert the desktop's per-session analytics rollup (1:1 on the
 * session artifact id; authoritative per Q16). Omission preserves any prior
 * rollup, mirroring the tokenUsage/attribution "omission never clears" rule.
 */
async function persistSessionAnalytics(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  session: SyncedAgentSession,
  /**
   * ISS-7176 (whitlockk): the caller's freshness watermark — the SAME
   * `freshness.shouldUpdateGuardedColumns` that already gates the per-event costs.
   * Desktop sync is at-least-once and can reorder, so without it a delayed older
   * batch would overwrite a newer whole-session cost, and this column is now the
   * DISPLAYED authority rather than a rollup nobody read.
   */
  shouldUpdateCost: boolean,
  /**
   * ISS-9434: the guarded lifecycle status this same slice writes to
   * `artifacts.status`. The rollup's own status column is resolved against it so
   * the two records of one fact cannot disagree — see the note at the write.
   */
  guardedStatus: SessionStatus,
  /**
   * ISS-8881: sink for the rollup counters this payload could not store. The
   * batch folds it into ONE emission per request — a per-session warn here would
   * be caller-drivable log amplification on an uncapped `sessions` array, the
   * bound `session-slice-result.ts` states for its sibling reports.
   */
  unstorableCounterFields?: string[]
): Promise<void> {
  const analytics = session.sessionAnalytics;
  if (!analytics) {
    return;
  }
  const unstorable = ROLLUP_COUNTER_FIELDS.filter(
    (field) => !isStorableRollupCounter(analytics[field])
  );
  const data = {
    startedAt: toDate(analytics.startedAt),
    startedDay: analytics.startedDay ?? null,
    // ISS-9434: the one cloud status column that still had an open path for a
    // retired spelling. `session_analytics.status` is `SELECT s.status` off the
    // desktop `sessions` table, so a skewed store holding `waiting` — or, before
    // desktop migration 0042, `completed`/`abandoned` — landed that string here
    // verbatim. It now takes the same fold the lifecycle column takes: FAIL-OPEN
    // to `active`, never a rejection, because the wire schema deliberately keeps
    // this a bare nullable string (see the note there) and a bound that threw
    // would 400 every session in the request — the array is unbounded since
    // ISS-8051, so the batch is whatever the pre-parse byte budget admitted.
    //
    // AND the same GUARD. The fold alone was not parity, which the first version
    // of this comment wrongly claimed: the lifecycle write resolves through
    // `resolveGuardedStatus`, so a stored terminal status outranks a
    // non-terminal incoming one. Without it here, a straggler batch stamps
    // `active` on the rollup of a session whose artifact row the guard is
    // holding at `inactive` — two records of one fact, disagreeing, which is the
    // defect class this ticket exists to close. `options.guardedStatus` is the
    // value this same slice writes to `artifacts.status`, so the two cannot part.
    //
    // No new counter: this and `session.status` are the same desktop column, and
    // the batch-level `agent_sessions.sync.unmodelled_status_folded` tally
    // already carries the raw spelling for that fleet condition. Not a proof that
    // every fold HERE is reported — a materialized rollup can lag the session row
    // by a vintage — but not worth a second emission for one copy of one column.
    //
    // ABSENT stays absent, rather than a fabricated `active`; the parser has
    // already folded a blank string to null, so the truthiness test drops none.
    status: analytics.status
      ? normalizeSessionStatus(
          resolveGuardedStatus(
            guardedStatus,
            normalizeSessionStatus(analytics.status)
          )
        )
      : null,
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
  // ISS-8881: the rollup is VALID-OR-ABSENT as a whole row, never partially
  // written. All five counters are `Int @default(0)` NOT NULL, so the row can
  // express neither "absent" nor "unknown" for one of them — on a CREATE an
  // omitted key stores a real `0` (a fabricated measurement, #6370), and on an
  // UPDATE a per-field omission leaves the PRIOR sync's counter beside this
  // sync's tokens and cost while `rollupUpdatedAt`/`lastSyncedAt` are stamped
  // current, which is a composite no reader can tell from a real snapshot. The
  // root `AGENTS.md` names both: store a valid record or nothing, never a
  // partially-corrupt one.
  //
  // So one unstorable counter withholds the whole write. On a resync the prior
  // row survives intact at its OWN vintage — nothing is lost, it is simply not
  // refreshed — and on a first sync no row is written at all, which the one
  // production reader (`agent-components/analytics-service.ts` `deriveRuntimeMs`)
  // already handles: it falls back to `sessionEndedAt - sessionStartedAt`, the
  // same path every session without a rollup takes. It is never read as a zero.
  // The next sync carrying sound counters writes the row normally.
  if (unstorable.length > 0) {
    // ISS-8881 (marisolashgrove review): QUALIFIED with the table, because the two
    // producers of this array have opposite outcomes and an operator reading a
    // bare `eventCount` cannot tell them apart. A `sessionDetail.*` field is
    // omitted from a row that still writes; a `usageRollup.*` field withholds
    // the ENTIRE row — tokens, cost, runtimeMs and all five counters.
    unstorableCounterFields?.push(
      ...unstorable.map((field) => `${UNSTORABLE_ROLLUP_FIELD_PREFIX}${field}`)
    );
  } else {
    await tx.agentSessionUsageRollup.upsert({
      where: { artifactId },
      create: { artifactId, ...data },
      update: data,
      select: { artifactId: true },
    });
  }

  // ISS-7813: the DISPLAYED whole-session cost lives on `SessionDetail.estimatedCost`,
  // which every list/detail read projects.
  //
  // It is NOT the only writer of that column: `resolveTokenRollupColumns`
  // (`field-regression-guards.ts`) also stamps a token-derived total through both
  // arms of the `sessionDetail.upsert` earlier in this same transaction. As of
  // ISS-8515 that writer is FRESHNESS-GATED on the same watermark this one uses, so
  // the two can no longer disagree by vintage — a stale batch writes neither, and on
  // a fresh batch this write still runs later and still wins.
  //
  // ISS-7176 ruled on 2026-08-20 that `token_usage` is NOT a cost source, which
  // settled the question this comment used to call "still open against #5502".
  //
  // Written from the same payload field as the rollup above, but NULL-preserving: that
  // column is `NOT NULL` and folds an absent cost to 0, which is the conflation this
  // ticket removes — on `SessionDetail` a null means "never priced" and a 0 means a
  // real $0.00, and the cost facets depend on telling those apart.
  //
  // Skipped entirely when the field is ABSENT (a Desktop build predating this sends
  // no cost at all), following the same "omission never clears" rule as the rollup
  // above — an older client leaves whatever was last written rather than blanking it.
  if (shouldUpdateCost && analytics.estimatedCostUsd !== undefined) {
    await tx.sessionDetail.update({
      where: { artifactId },
      data: {
        estimatedCost:
          analytics.estimatedCostUsd === null
            ? null
            : roundCost(analytics.estimatedCostUsd),
      },
      // Narrow `RETURNING *` to the primary key: the row is discarded, and the
      // `*Detail` tables key on `artifactId`. Keeps the single-row semantics —
      // including the P2025 throw when the session row is missing, which would be
      // a real ordering bug here, not something to swallow with `updateMany`.
      select: { artifactId: true },
    });
  }
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
  baseBranch: string | null;
};

type NullableJsonPatch =
  | Prisma.NullableJsonNullValueInput
  | Prisma.InputJsonValue;

type SessionTraceDetailPatch = {
  billingMode?: string | null;
  endsWithError?: boolean | null;
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
  frustrationRaw?: number | null;
  frustrationScoreVersion?: number | null;
};

/**
 * ISS-4431: resolve the best repository identity from the session's branch-kind
 * artifact refs. Preference: a ref with `branchParticipation === Wrote` wins
 * (strongest write evidence); otherwise the first qualifying ref is used.
 * Returns a `normalizeRepoFullName`-canonicalized value, or `null` when no
 * branch ref carries a `repositoryFullName`.
 */
export function resolveRepositoryFromBranchRefs(
  artifactRefs: SyncedArtifactRef[] | undefined
): string | null {
  const branchRefs = collectBranchRefs(artifactRefs);
  if (branchRefs.length === 0) {
    return null;
  }
  let best: string | null = null;
  for (const ref of branchRefs) {
    if (
      !(
        ref.repositoryFullName &&
        normalizeRepositoryIdentity(ref.repositoryFullName)
      )
    ) {
      continue;
    }
    if (ref.branchParticipation === BranchParticipationKind.Wrote) {
      return normalizeRepoFullName(ref.repositoryFullName);
    }
    best ??= ref.repositoryFullName;
  }
  return best ? normalizeRepoFullName(best) : null;
}

export function toAttributionColumns(
  session: SyncedAgentSession
): SessionAttributionColumns {
  return {
    repositoryFullName:
      normalizeNullableString(session.attribution?.repositoryFullName) ??
      resolveRepositoryFromBranchRefs(session.artifactRefs),
    worktreePath: normalizeNullableString(session.attribution?.worktreePath),
    sourceArtifactId: normalizeNullableString(
      session.attribution?.sourceArtifactId
    ),
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
 *
 * FEA-4022: the frustration signal is persisted ONLY when the org opted into
 * `calculateSessionFrustration` (`options.includeFrustration`). When the org has
 * NOT opted in, the fields are left off the patch entirely (undefined), so the
 * column is preserved — never written and never cleared by an omitting caller —
 * matching the additive omission semantics of every other trace field.
 *
 * ISS-4586: `endsWithError` is regression-guarded like the frustration/cost/time
 * columns — it feeds the reaper's ERROR-vs-INACTIVE classification, so a late
 * retry of an OLDER batch must not flip a newer sync's flag (e.g. overwrite a
 * recovered session's `false` with a stale `true`). The caller passes
 * `includeEndsWithError` from the `updatedAt >= sessionUpdatedAt` freshness
 * watermark (true on create); when stale, the field is left off the patch and
 * the stored value is preserved.
 *
 * ISS-4946: the legacy `pullRequests` blob is regression-guarded the same way
 * (`includePullRequests`) — ISS-4768 gave it a destructive CLEAR branch, so a
 * redelivered older batch could wipe a newer sync's PR list. That option is
 * truthy-gated like `includeEndsWithError` (NOT `!== false` like
 * `includeTraceDurations`), so omitting it preserves the stored blob instead of
 * silently restoring the unconditional clear. Its value must be the same gate
 * the session→PR link lane uses (`resolveSessionPullRequestWriteGate`) — the two
 * lanes describe one PR state and a row where only one of them was written is a
 * state the read boundary reconciles wrongly.
 *
 * ISS-9859: what the blob patch then CARRIES depends on the stored blob too,
 * because a continuation part of a paginated PR sequence appends its page to it
 * rather than replacing it. That is `storedPullRequests`, and
 * `resolvePullRequestsBlobPatchInput` owns the whole decision.
 */
export function toTraceDetailPatch(
  session: SyncedAgentSession,
  options?: {
    includeFrustration?: boolean;
    includeEndsWithError?: boolean;
    includeTraceDurations?: boolean;
    includePullRequests?: boolean;
    /**
     * ISS-9859: the blob the stored row holds, `null` when it holds none. A
     * continuation part of a paginated PR sequence appends its page to this;
     * omitted, such a part leaves the column alone rather than writing its page
     * over every earlier one. See `resolvePullRequestsBlobPatchInput`.
     */
    storedPullRequests?: Prisma.JsonValue;
    /**
     * ISS-8881: sink for the counter fields this payload could not store. A
     * mutable option rather than a second return value so the ~30 existing call
     * sites (`persist-frustration-gate.test.ts`,
     * `persist-pull-requests-blob.test.ts`) stay untouched, and so the drop is
     * derived exactly once — the alternative, re-deriving storability at the
     * caller, is two copies of one rule.
     */
    unstorableCounterFields?: string[];
  }
): SessionTraceDetailPatch {
  const patch: SessionTraceDetailPatch = {};
  setPatchValue(
    patch,
    "billingMode",
    session.billingMode,
    normalizeNullableString
  );
  // ISS-4586: additive boolean flag — undefined (older desktop build omits it)
  // preserves the stored value; a boolean/null is written as-is so the reaper
  // reads the desktop's latest ends_with_error signal. Gated behind the caller's
  // freshness watermark so a delayed older batch can't regress the flag.
  if (options?.includeEndsWithError) {
    setPatchValue(
      patch,
      "endsWithError",
      session.endsWithError,
      identityPatchValue
    );
  }
  // ISS-4946: gated like `endsWithError` above. ISS-4768 made an omitted `prs`
  // with a present `prRefs` CLEAR the stored blob, and that write was
  // unconditional — so a redelivered older batch (desktop sync is at-least-once
  // and can reorder) wiped a newer sync's list, permanently on an ended session.
  // The whole write is gated, not just the clear: a stale batch's own `prs` list
  // overwriting a newer one is the same regression. Truthy-gated so a call site
  // that forgets the option fails toward PRESERVING the blob rather than toward
  // restoring that destructive clear.
  if (options?.includePullRequests) {
    setPatchValue(
      patch,
      "pullRequests",
      resolvePullRequestsBlobPatchInput(session, options.storedPullRequests),
      toNullableJsonPatch
    );
  }
  // ISS-4688 (whitlockk, #4121): the trace-duration triple is gated behind the SAME
  // freshness watermark as `endsWithError` above. These three were written
  // unconditionally, so a delayed sync from an older Desktop build — arriving at
  // the same dataRevision, after a newer one already landed — overwrote
  // `wallClock` with its stale value and pinned every Duration display (the
  // Sessions list cell, the detail Duration card, and the Properties row that
  // now shares their derivation) to the older number.
  //
  // The three are gated TOGETHER, not just `wallClock`: they are one decomposition
  // (`wall` is the headline, `active`/`waiting` its sub-facts), so gating only the
  // headline would let a stale batch pair a new `activeAgent` with an old
  // `wallClock` and produce an internally inconsistent row — a worse failure than
  // the one being fixed. An absent option preserves the previous write-always
  // behavior for callers that have not opted in.
  if (options?.includeTraceDurations !== false) {
    setPatchValue(
      patch,
      "wallClock",
      session.wallClock,
      normalizeNullableString
    );
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
  }
  // FEA-3922/FEA-3923: the per-session lines/files columns are now sourced ONLY
  // from the transcript-derived loose scalars, NEVER from the git-derived
  // gitDiffStats. This is a source-of-truth change, not a correctness patch on
  // git. The two git provenances are genuinely different measurements and must
  // not be conflated: `loc_source="git"` is real per-session, authored-commit
  // LOC, whereas `loc_source="branch_fallback"` is the shared whole-branch/PR
  // total — a single figure fanned out identically to every authoring session on
  // the branch (per the canonical agent-session contract). We deliberately make
  // the transcript the authoritative per-session source of truth so the shared
  // branch_fallback total can never masquerade as one session's own diff
  // (FEA-3922) and gh's spurious files_changed=0 can never surface (FEA-3923).
  // The desktop git-enrichment sweep that populated these columns is already
  // dormant (FEA-2608); this ingest is the effective off-switch. The full git-LOC
  // stack (gitLocRows, branch_fallback, loc_source, gitDiffStats plumbing, the
  // dormant enrichment modules) is tracked for removal in ISS-4423.
  setPatchValue(patch, "linesAdded", session.linesAdded, identityPatchValue);
  setPatchValue(
    patch,
    "linesRemoved",
    session.linesRemoved,
    identityPatchValue
  );
  setPatchValue(
    patch,
    "filesChanged",
    session.filesChanged,
    identityPatchValue
  );
  // Provenance is now always cleared (null) whenever any LOC signal is present:
  // the columns hold transcript scalars, never git-tagged values. `undefined`
  // when the payload omits LOC entirely so the existing column value is preserved.
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
  // ISS-8881: bounded, unlike the LOC family above — see `setStorableCounterPatch`.
  setStorableCounterPatch(
    patch,
    "turns",
    session.turns,
    options?.unstorableCounterFields
  );
  setStorableCounterPatch(
    patch,
    "steeringEpisodes",
    session.steeringEpisodes,
    options?.unstorableCounterFields
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
  // FEA-4022: persist the raw frustration signal + scorer version ONLY when the
  // org opted in. Gated at ingest (the desktop always computes it locally), so
  // an org that has not opted in never has the value written cloud-side — the
  // column stays NULL and Insights renders an empty state. Omission preserves
  // whatever the cloud already stored (like every other trace field).
  if (options?.includeFrustration) {
    setPatchValue(
      patch,
      "frustrationRaw",
      session.frustrationRaw,
      identityPatchValue
    );
    setPatchValue(
      patch,
      "frustrationScoreVersion",
      session.frustrationScoreVersion,
      identityPatchValue
    );
  }
  return patch;
}

/**
 * Provenance for the flattened LOC scalar columns. FEA-3922/FEA-3923: the
 * per-session scalars are now always transcript-derived, never git, so this is
 * `null` whenever any LOC signal is present (clears a stale "git"/"branch_fallback"
 * marker left by an older sync) and `undefined` when the payload omits LOC
 * entirely so the existing column value is preserved. `session.gitDiffStats` is
 * intentionally NOT consulted — see the write comment in `toTraceDetailPatch`.
 */
function resolveLocSourcePatch(
  session: SyncedAgentSession
): string | null | undefined {
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
 * Write a nullable counter into the patch only when the column can hold it.
 *
 * ISS-8881: `turns` and `steeringEpisodes` land in Postgres `int4` columns
 * (`SessionDetail.turns` / `.steering_episodes`). The wire declares them
 * `z.number().int().nonnegative()` (`lib/desktop-agent-sessions-schema.ts:633-634`)
 * — so it refuses a fractional or negative value, but carries no `.max()`,
 * 21 lines below `boundedLocFieldSchema`, whose comment names this exact
 * failure. A past-the-ceiling value makes the `sessionDetail.upsert` raise
 * `22003`, which fails the slice, withholds the session from
 * `persistedSessionIds`, and has the desktop re-send the identical payload
 * forever.
 *
 * THE NULL IS NOT A REJECTION. These fields are `.nullable().optional()` on the
 * wire and `Int?` in the column, and today `setPatchValue` writes whenever the
 * value is not `undefined` — so an explicit `null` CLEARS the column, and that
 * is valid input with a defined meaning. Folding null into the storability test
 * would turn a clear into a no-op, which is a behaviour change on VALID input.
 * The contract is three-way:
 *
 *   undefined         → key ABSENT   → column untouched (omission never clears)
 *   null              → key present  → column CLEARED, exactly as today
 *   storable integer  → key present  → written
 *   anything else     → key ABSENT   → column untouched, field reported
 *
 * The last row covers the whole impossible set rather than just "too big": a
 * fractional or negative `turns` is as fabricated a measurement as an overflowed
 * one. Only the overflow is reachable through the route today — the wire refuses
 * the other two — so the rest is defence in depth at the write, matching
 * `lib/int4-column-bounds.ts`. Reported rather than clamped for the reason
 * #6370 gives — a stored ceiling value is indistinguishable from a real count.
 */
function setStorableCounterPatch(
  patch: SessionTraceDetailPatch,
  key: "turns" | "steeringEpisodes",
  value: number | null | undefined,
  unstorableFields?: string[]
): void {
  if (value === undefined) {
    return;
  }
  if (value === null) {
    patch[key] = null;
    return;
  }
  if (isStorableInt4Count(value)) {
    patch[key] = value;
    return;
  }
  unstorableFields?.push(`${UNSTORABLE_SESSION_DETAIL_FIELD_PREFIX}${key}`);
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

/**
 * ISS-4946 (whitlockk review, PR #4327): whether this snapshot carries PR evidence,
 * reported PER LANE. Used as the equal-watermark tie-breaker in
 * `resolveSessionPullRequestWriteGate`, where a pre-3bc26f527 build's empty
 * pre-link snapshot and populated post-link snapshot share one `updatedAt` and
 * only the populated one may win.
 *
 * The two shapes are reported SEPARATELY, and that separation is load-bearing.
 * The obvious version of this helper ORs them into one boolean handed to both
 * lanes, which reintroduces the exact defect the gate exists to prevent: the two
 * producers have different admission predicates (see `session-pr-status.ts`),
 * so a snapshot can legitimately carry
 * `prs: [ ... ]` with `prRefs: []`. Under an OR that snapshot clears the gate on
 * blob evidence alone, the blob lane writes its list, and then
 * `persistSessionPrArtifactLinks` runs with an empty ref list and its
 * `deleteMany` wipes every `session_pr` row — settling the record into
 * populated-blob-plus-zero-links, the split state this whole change was written
 * to eliminate.
 *
 * Each lane must therefore prove evidence for ITSELF before it is allowed to
 * perform a destructive replacement at a tie. A lane with nothing to write
 * preserves instead.
 *
 * `hasBlobWrite` / `hasLinkWrite` are a SEPARATE question from evidence: whether
 * the lane would have written anything had the gate admitted it. A pre-link
 * -extraction build sends neither `prs` nor `prRefs`, so the blob patch resolves
 * to `undefined` (no column in the patch) and `persistSessionPrArtifactLinks`
 * early-returns on an undefined ref list — the gate's skip suppresses nothing.
 * Only a lane that actually had a write to lose belongs in the tie counter, per
 * the AGENTS.md rule that a quality signal increments inside the branch its
 * precondition held in.
 *
 * ISS-9859: a continuation part of a paginated PR sequence only ADDS, so it has
 * a write to lose only when its own page is non-empty. For `prs` that follows
 * from `resolvePullRequestsBlobPatchInput`. For `prRefs` it is stated here: an
 * empty strong-ref page still yields prose twins minted from `artifactRefs`,
 * but those ride every part whole, so the first page carried the same twins and
 * skipping this part loses nothing.
 */
export function resolveSessionPullRequestEvidence(
  session: SyncedAgentSession
): {
  hasBlobEvidence: boolean;
  hasLinkEvidence: boolean;
  hasBlobWrite: boolean;
  hasLinkWrite: boolean;
  /** ISS-9859: page 0 of a paginated PR list, which the tie admits. */
  isPrListPageZero: boolean;
} {
  return {
    isPrListPageZero: isPaginatedPrListPageZero(session),
    hasBlobEvidence: (session.prs?.length ?? 0) > 0,
    hasLinkEvidence: (session.prRefs?.length ?? 0) > 0,
    // `null` stands for "no stored blob". The stored value decides what a
    // write carries, never whether there is one.
    hasBlobWrite:
      resolvePullRequestsBlobPatchInput(session, null) !== undefined,
    hasLinkWrite: isPrRefContinuationPart(session)
      ? (session.prRefs?.length ?? 0) > 0
      : session.prRefs !== undefined,
  };
}
