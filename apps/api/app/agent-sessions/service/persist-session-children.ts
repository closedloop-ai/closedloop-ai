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
import { Prisma } from "@repo/database";
import { normalizeRepositoryIdentity } from "@repo/lib/sessions/repository-identity";
import { persistSessionActivitySegments } from "./activity-segment-persistence";
import { collectBranchRefs } from "./artifact-links/shared";
import { normalizeNullableString, roundCost, toDate } from "./coercion";
import type { AgentSessionUpsertTx } from "./records";
import { persistSessionTokenEvents } from "./token-event-persistence";

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
};

export async function persistSessionChildren(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  organizationId: string,
  session: SyncedAgentSession,
  normalizedTokenUsage: readonly SyncedAgentSessionTokenUsage[],
  options: {
    shouldReplace: boolean;
    shouldUpdateTokenEventCosts: boolean;
  }
): Promise<PersistSessionChildrenResult> {
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
  if (normalizedTokenUsage.length > 0) {
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
  await persistSessionAnalytics(tx, artifactId, session);
  // ISS-4541: chunk-aware activity-segment persistence. `shouldReplace` is the
  // caller's chunk-0-of-an-advancing-revision signal (from `resolveChunkGating`):
  // chunk 0 delete-replaces the stored tiling; every later chunk appends its slice
  // idempotently. See `persistSessionActivitySegments`.
  await persistSessionActivitySegments(
    tx,
    artifactId,
    organizationId,
    session,
    options.shouldReplace
  );

  return { lastActivityAt, maxEventCreatedAt };
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
  endsWithError?: boolean | null;
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
 */
export function toTraceDetailPatch(
  session: SyncedAgentSession,
  options?: {
    includeFrustration?: boolean;
    includeEndsWithError?: boolean;
    includeTraceDurations?: boolean;
    includePullRequests?: boolean;
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
  setPatchValue(patch, "branch", session.branch, normalizeNullableString);
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
      resolvePullRequestsBlobPatchInput(session),
      toNullableJsonPatch
    );
  }
  // ISS-4688 (wongk, #4121): the trace-duration triple is gated behind the SAME
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
 * ISS-4768 (wongk review): what the legacy `pullRequests` blob patch should carry
 * for this snapshot — the payload's own list, an explicit CLEAR, or nothing.
 *
 * An omitted `prs` is NOT always "this build does not send PRs". The desktop
 * producer emits the field conditionally — `...(prs.length > 0 ? { prs } : {})`
 * in `apps/desktop/src/main/database/session-trace.ts` — so a CURRENT-generation
 * session whose PR set legitimately recalculated to EMPTY (a link retracted, a PR
 * ref reclassified) also arrives with `prs` omitted. Treating that as "preserve"
 * left the previously stored blob in place forever, and because the same snapshot's
 * `prRefs: []` DOES delete the session→PR links, the row settled into
 * stale-blob-plus-zero-links — precisely the state the read boundary's authoring
 * gate reads as "no link adjudicates this PR, keep it". The phantom would outlive
 * the very sync that retracted it.
 *
 * `prRefs` disambiguates, and is the only field that can: it is emitted
 * UNCONDITIONALLY by every build that extracts session→PR links (`prRefs:
 * boundedPrRefs` in `sync-source.ts`), and the chunked-sync builders replicate the
 * whole session into every chunk (`baseFor` spreads `...session`), so a
 * continuation chunk can never present `prRefs` without `prs` by accident.
 *   - `prs` present → write it (unchanged).
 *   - `prs` omitted, `prRefs` present → a current producer that recalculated to
 *     empty. CLEAR the blob so the stored row matches what the producer sees.
 *   - `prs` omitted, `prRefs` omitted → a pre-link-extraction build that sends
 *     neither. PRESERVE (Compatibility Guardrail: this is the genuine legacy row
 *     the read boundary's compat escape exists for).
 */
function resolvePullRequestsBlobPatchInput(
  session: SyncedAgentSession
): SyncedAgentSession["prs"] | undefined {
  if (session.prs !== undefined) {
    return session.prs;
  }
  return session.prRefs === undefined ? undefined : null;
}

/**
 * ISS-4946 (wongk review, PR #4327): whether this snapshot carries PR evidence,
 * reported PER LANE. Used as the equal-watermark tie-breaker in
 * `resolveSessionPullRequestWriteGate`, where a pre-3bc26f527 build's empty
 * pre-link snapshot and populated post-link snapshot share one `updatedAt` and
 * only the populated one may win.
 *
 * The two shapes are reported SEPARATELY, and that separation is load-bearing.
 * The obvious version of this helper ORs them into one boolean handed to both
 * lanes, which reintroduces the exact defect the gate exists to prevent: the two
 * producers have independent 100-row caps and different admission predicates
 * (see `session-pr-status.ts`), so a snapshot can legitimately carry
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
 */
export function resolveSessionPullRequestEvidence(
  session: SyncedAgentSession
): {
  hasBlobEvidence: boolean;
  hasLinkEvidence: boolean;
  hasBlobWrite: boolean;
  hasLinkWrite: boolean;
} {
  return {
    hasBlobEvidence: (session.prs?.length ?? 0) > 0,
    hasLinkEvidence: (session.prRefs?.length ?? 0) > 0,
    hasBlobWrite: resolvePullRequestsBlobPatchInput(session) !== undefined,
    hasLinkWrite: session.prRefs !== undefined,
  };
}
