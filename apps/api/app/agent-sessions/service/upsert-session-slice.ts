import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  DISPLAYED_SESSION_STATUS,
  isRecognizedSessionStatus,
  normalizeSessionStatus,
  type SessionStatus,
  TERMINAL_SESSION_STATUSES,
} from "@repo/api/src/types/session-status";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { Prisma, SessionOrigin } from "@repo/database";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { generateSlug } from "@/lib/slug-generator";
import { acquireSessionAdvisoryLocks } from "./advisory-locks";
import { persistSessionBranchArtifactLinks } from "./artifact-links/branch-links";
import { persistSessionCommitRefs } from "./artifact-links/commit-links";
import { persistSessionPrArtifactLinks } from "./artifact-links/pr-links";
import { persistSessionPullRequestDetails } from "./artifact-links/pull-request-details";
import { resolveBranchRepoMap } from "./artifact-links/shared";
import { persistArtifactLinks } from "./artifact-links/slug-links";
import { resolveChunkGating } from "./chunk-revision-gating";
import {
  mergeJsonArrayByKey,
  normalizeNullableString,
  roundCost,
  toDate,
} from "./coercion";
import { persistSessionComponentUsage } from "./component-usage";
import {
  resolveGuardedStatus,
  resolveGuardedTimestampPatch,
  resolveSessionFreshnessGates,
  resolveTokenRollupColumns,
} from "./field-regression-guards";
import type { LoopSessionBacklink } from "./loop-session-backlink";
import { resolveLoopSessionBacklink } from "./loop-session-backlink";
import { sanitizeMetadataForPersist } from "./metadata-sanitizer";
import { persistMonitoredSessionActivity } from "./monitored-session-activity";
import {
  persistSessionChildren,
  resolveSessionPullRequestEvidence,
  toAttributionColumns,
  toNonNullAttributionPatch,
  toTraceDetailPatch,
} from "./persist-session-children";
import { resolveProjectId } from "./project-resolution";
import type {
  AgentSessionUpsertTx,
  SessionProjectResolution,
  UpsertSessionsContext,
} from "./records";
import { maybeReopenTerminalSession } from "./session-reopen";
import { SessionSyncMetric } from "./session-sync-metrics";
import { normalizeTokenUsage, sumTokenUsage } from "./synced-payload";

type UpsertSessionSliceInput = {
  context: UpsertSessionsContext;
  includeFrustration: boolean;
  projectResolution: SessionProjectResolution;
  session: SyncedAgentSession;
  slugMap: Map<string, string>;
  syncTimestamp: Date;
};

/**
 * FEA-1718: `loopBacklink` is the `Loop.sessionArtifactId` claim this slice
 * implies, DESCRIBED here and APPLIED by the caller once the transaction has
 * committed. It is not written inside the slice on purpose — the target column
 * is uniquely indexed, and AGENTS.md forbids catching a failed write and
 * continuing to issue queries in the same interactive transaction. `null` when
 * the session carries no usable `sourceLoopId`, so the caller writes nothing at
 * all rather than clearing the column.
 */
export type UpsertSessionSliceResult = {
  loopBacklink: LoopSessionBacklink | null;
  /** The slice reached the upsert, so its writes are part of this transaction. */
  persisted: boolean;
  /**
   * ISS-5981: the RAW spelling, when the payload carried one this build does not
   * model and the fold rewrote it to `active` — otherwise null.
   *
   * The value, not a boolean (wongk, #5047): the counter alone says skew is
   * happening but not what to do about it: the response is to fix the producer
   * (ISS-5592 retired the alias map, so there is no fold to teach). Without
   * carrying the spelling that decision cannot be made. The caller samples it under a bound; see
   * `status-fold-telemetry.ts`.
   */
  unmodelledStatus: string | null;
};

export async function upsertSessionSlice(
  tx: AgentSessionUpsertTx,
  input: UpsertSessionSliceInput
): Promise<UpsertSessionSliceResult> {
  const {
    context,
    includeFrustration,
    projectResolution,
    session,
    slugMap,
    syncTimestamp,
  } = input;
  const normalizedTokenUsage = normalizeTokenUsage(session.tokenUsageByModel);
  const tokenTotals = sumTokenUsage(normalizedTokenUsage);
  const projectId = resolveProjectId(session, projectResolution);
  const attributionColumns = toAttributionColumns(session);
  // FEA-1718 (review, wongk): a session that materializes a validated same-org
  // loop is LOOP-origin, not DESKTOP_SYNC. This is not cosmetic — `origin` is
  // what the stale reaper and BOTH retention sweeps filter on, and each of them
  // already documents that LOOP-materialized sessions are governed by their
  // source Loop's lifecycle and are never swept. Leaving these rows at the
  // DESKTOP_SYNC default let the phantom sweep DELETE the session artifact,
  // whose `onDelete: SetNull` then silently cleared the back-link this change
  // exists to write.
  //
  // Gated on membership of the batch-validated same-org loop set, never on the
  // raw payload: `origin` decides retention exemption, so an unvalidated or
  // cross-org loop id must not be able to buy a row immunity from deletion.
  // Only ever SET, never cleared — a later delivery that omits the attribution
  // preserves the stored `sourceLoopId`, so it must preserve this too.
  const isLoopMaterialized =
    attributionColumns.sourceLoopId !== null &&
    projectResolution.sameOrgLoopIds.has(attributionColumns.sourceLoopId);
  const loopOriginPatch = isLoopMaterialized
    ? { origin: SessionOrigin.LOOP }
    : {};
  const sessionName =
    normalizeNullableString(session.name) ??
    `Session ${session.externalSessionId}`;

  await acquireSessionAdvisoryLocks(tx, session.externalSessionId);

  const existing = await tx.sessionDetail.findUnique({
    where: {
      computeTargetId_externalSessionId: {
        computeTargetId: context.computeTargetId,
        externalSessionId: session.externalSessionId,
      },
    },
    select: {
      artifactId: true,
      agents: true,
      dataRevision: true,
      pendingChunkRevision: true,
      pendingChunkTotal: true,
      pendingChunkReceived: true,
      sessionStartedAt: true,
      sessionUpdatedAt: true,
      sessionEndedAt: true,
      // ISS-5981: the STORED awaiting-input anchor. `detailData` rewrites this
      // column on every sync, so the write has to see the value it is about to
      // overwrite — see `resolveIngestAwaitingInputSince`.
      awaitingInputSince: true,
      artifact: {
        select: {
          status: true,
        },
      },
    },
  });

  // ISS-5648: THE ingest fold. ISS-4654's backfill collapsed the stored
  // `completed`/`abandoned` rows once, but this path stored the client's status
  // verbatim, so a version-skewed Desktop build (pre-#4092 producer) regrew the
  // population on its next sync and gate 3 could never stay met. Folding here
  // keeps the accept-tolerance intact — nothing is rejected — while stopping the
  // retired spelling at the column.
  //
  // TWO folds, for two different sources of the spelling:
  //   • the INCOMING value, which a straggler build is still emitting; and
  //   • the value `resolveGuardedStatus` RESOLVES TO, which is the persisted
  //     spelling untouched whenever terminal-wins fires. Without the outer fold
  //     a row that already stores `completed` (one the backfill missed, or one a
  //     straggler wrote after it ran) rewrites itself on every subsequent sync,
  //     which is the self-regrowing condition this issue is about.
  //
  // The fold is an ACCEPTED coercion, so AGENTS.md ("Handling Bad or Nonsensical
  // Data") wants it on a monitored path rather than absorbed. It is REPORTED to
  // the caller instead of emitted here: this slice runs once per session in a
  // client-supplied batch, and per-row emission on a caller-driven path is what
  // `apps/api/AGENTS.md` ("Emission and Abuse Control") forbids. `service.ts`
  // emits one aggregate count for the batch (wongk, PR #4786).
  //
  // ISS-5981: the fold is `normalizeSessionStatus`, whose return is typed
  // `SessionStatus` — so "only a lifecycle value reaches the column" is now
  // stated by the type rather than asserted in a comment. It supersedes the
  // retired-only fold, which let `waiting` and every unmodelled spelling through
  // verbatim. An unrecognized status folds to `active`: whether such a row is
  // really still running is then the reaper's and the display staleness
  // derivation's call, which is where that judgment already lives.
  const incomingStatus = normalizeSessionStatus(session.status);
  const resolvedStatus = existing
    ? resolveGuardedStatus(existing.artifact?.status, incomingStatus)
    : incomingStatus;
  const guardedStatus = normalizeSessionStatus(resolvedStatus);
  // ISS-5981: the fail-open branch of the fold. Reported, not emitted, on the
  // same batch-aggregation grounds as the two above.
  const unmodelledStatus = resolveUnmodelledStatus(session.status);
  // Resolved from the RAW incoming status, before the fold erases the `waiting`
  // spelling the anchor keys off.
  const incomingAwaitingInputSince = resolveIngestAwaitingInputSince(
    session,
    existing
  );

  const {
    shouldReplace,
    isForeignChunk,
    shouldCommitRevision,
    pendingChunkPatch,
  } = resolveChunkGating({
    incomingRevision: session.dataRevision,
    chunk: session.chunk,
    existingRevision: existing?.dataRevision,
    existingPendingRevision: existing?.pendingChunkRevision,
    existingPendingTotal: existing?.pendingChunkTotal,
    existingPendingReceived: existing?.pendingChunkReceived,
  });

  if (isForeignChunk) {
    // ISS-5981: the discarded chunk still PROVES a producer emitted a spelling
    // this build cannot model, which is the only question the unmodelled counter
    // answers, so it is reported even though nothing was written.
    return {
      loopBacklink: null,
      persisted: false,
      // Same rule as the payload source above: the discarded chunk still PROVES
      // a producer emitted a spelling this build cannot model, which is the only
      // question this counter answers.
      unmodelledStatus,
    };
  }

  // FEA-3419 / ISS-4586 / ISS-4688 / ISS-4946: which regression-guarded columns
  // this apply may write, resolved in one place — the shared
  // `updatedAt >= sessionUpdatedAt` watermark, the stricter PR gate both PR
  // lanes share, and whether a clock-poisoned watermark is being repaired.
  // Rationale for every arm lives on `resolveSessionFreshnessGates`.
  const incomingSessionUpdatedAt = new Date(session.updatedAt);
  const { hasBlobEvidence, hasLinkEvidence, hasBlobWrite, hasLinkWrite } =
    resolveSessionPullRequestEvidence(session);
  const freshness = resolveSessionFreshnessGates({
    existingSessionUpdatedAt: existing?.sessionUpdatedAt ?? null,
    incomingSessionUpdatedAt,
    receivedAt: syncTimestamp,
    hasPullRequestBlobEvidence: hasBlobEvidence,
    hasPullRequestLinkEvidence: hasLinkEvidence,
    hasPullRequestBlobWrite: hasBlobWrite,
    hasPullRequestLinkWrite: hasLinkWrite,
  });
  const shouldUpdateTokenEventCosts = freshness.shouldUpdateGuardedColumns;
  // Both emissions below fire inside the caller's `withDb.tx`, so they count
  // DECISIONS, not committed outcomes: a later rollback in the same apply (the
  // tx-timeout path, or a propagated unique-race) discards the write but leaves
  // the count, and the desktop's at-least-once retry re-counts on each attempt.
  // Acceptable for a trend counter — these answer "is this happening, and how
  // often", not "how many rows are in this state" — but a monitor built on them
  // must not be read as a row count.
  if (freshness.didRepairPoisonedWatermark) {
    // AGENTS.md "Handling Bad or Nonsensical Data": a value that cannot be right
    // is routed to the monitored path, never silently coerced.
    emitTelemetryMetric({
      metric: SessionSyncMetric.PoisonedWatermarkRepaired,
      organizationId: context.organizationId,
      computeTargetId: context.computeTargetId,
      count: 1,
    });
  }
  if (freshness.didPreservePullRequestsOnTie) {
    // ISS-4946: the equal-watermark tie-break just skipped a lane whose own
    // evidence was empty AND that had a write to lose. Usually that snapshot is
    // the stale pre-link half of a pre-3bc26f527 pair and skipping is exactly
    // right — but nothing on the wire separates it from a genuine retraction, and
    // on an ended session the frozen `updatedAt` means no later batch relitigates
    // it. Same reporting rule as the repair above: an accepted loss is monitored,
    // not absorbed silently.
    emitTelemetryMetric({
      metric: SessionSyncMetric.PrStatePreservedOnTie,
      organizationId: context.organizationId,
      computeTargetId: context.computeTargetId,
      count: 1,
    });
  }

  const mergedAgents = shouldReplace
    ? session.agents
    : mergeJsonArrayByKey(existing?.agents, session.agents, "externalAgentId");
  const sanitizedAgents = mergedAgents.map((agent) => ({
    ...agent,
    metadata: sanitizeMetadataForPersist(agent.metadata),
  }));

  const detailData = {
    harness: normalizeNullableString(session.harness) ?? "unknown",
    cwd: normalizeNullableString(session.cwd),
    model: normalizeNullableString(session.model),
    ...(session.deviceTimeZone === undefined
      ? {}
      : { deviceTimeZone: normalizeNullableString(session.deviceTimeZone) }),
    ...(shouldCommitRevision ? { dataRevision: session.dataRevision } : {}),
    ...pendingChunkPatch,
    // ISS-4654: a terminal status still clears awaitingInputSince. No re-fold —
    // `guardedStatus` is already a lifecycle value (ISS-5981).
    awaitingInputSince: TERMINAL_SESSION_STATUSES.has(guardedStatus)
      ? null
      : incomingAwaitingInputSince,
    agentCount: sanitizedAgents.length,
    metadata: sanitizeMetadataForPersist(session.metadata) ?? Prisma.DbNull,
    agents: sanitizedAgents,
    lastSyncedAt: syncTimestamp,
    ...toTraceDetailPatch(session, {
      includeFrustration: includeFrustration && shouldUpdateTokenEventCosts,
      // ISS-4586 / ISS-4688 / ISS-4946: ends_with_error and the trace-duration
      // triple share the watermark; the pullRequests blob takes the stricter PR
      // gate, resolved from the `prs` blob's OWN evidence so it cannot be let
      // through on the link lane's behalf (or vice versa).
      includeEndsWithError: shouldUpdateTokenEventCosts,
      includeTraceDurations: shouldUpdateTokenEventCosts,
      includePullRequests: freshness.shouldUpdatePullRequestsBlob,
    }),
  };

  const incomingTimestamps = {
    sessionStartedAt: new Date(session.startedAt),
    sessionUpdatedAt: incomingSessionUpdatedAt,
    sessionEndedAt: toDate(session.endedAt),
  };
  const tokenRollupColumns = resolveTokenRollupColumns(
    normalizedTokenUsage.length > 0,
    tokenTotals,
    roundCost
  );
  const guardedTimestamps = existing
    ? resolveGuardedTimestampPatch(existing, incomingTimestamps, {
        repairImplausibleUpdatedAt: freshness.didRepairPoisonedWatermark,
      })
    : incomingTimestamps;
  const slug = existing
    ? undefined
    : await generateSlug(context.organizationId, SlugPrefix.Session);

  const persisted = await tx.sessionDetail.upsert({
    where: {
      computeTargetId_externalSessionId: {
        computeTargetId: context.computeTargetId,
        externalSessionId: session.externalSessionId,
      },
    },
    create: {
      artifact: {
        create: {
          organization: { connect: { id: context.organizationId } },
          ...(projectId ? { project: { connect: { id: projectId } } } : {}),
          type: ArtifactType.Session,
          name: sessionName,
          // ISS-5648: the folded INCOMING status, deliberately not
          // `guardedStatus`. Which arm runs is decided by the DATABASE, not by
          // the `existing` read above — under READ COMMITTED a sweep that
          // deletes the row between that read and this upsert lands here with
          // `guardedStatus` carrying the deleted row's terminal status, which
          // would stamp a brand-new artifact with a status no payload claimed.
          // The incoming value is what a create arm has always written.
          //
          // Note this does NOT make the create arm uniformly incoming-derived:
          // `detailData.awaitingInputSince` is shared by both arms and keyed off
          // `guardedStatus`, so in that same race a created row can read
          // `active` with a null awaiting timestamp. Pre-existing and unchanged
          // here — closing it means splitting `detailData` per arm, which is a
          // wider change than this fold.
          status: incomingStatus,
          slug,
          createdBy: { connect: { id: context.userId } },
        },
      },
      user: { connect: { id: context.userId } },
      computeTarget: { connect: { id: context.computeTargetId } },
      externalSessionId: session.externalSessionId,
      toolUseCount: 0,
      errorCount: 0,
      ...detailData,
      ...incomingTimestamps,
      ...tokenRollupColumns,
      ...attributionColumns,
      ...loopOriginPatch,
    },
    update: {
      artifact: {
        update: {
          name: sessionName,
          status: guardedStatus,
          ...(projectId ? { project: { connect: { id: projectId } } } : {}),
        },
      },
      ...detailData,
      ...guardedTimestamps,
      ...tokenRollupColumns,
      ...toNonNullAttributionPatch(attributionColumns),
      ...loopOriginPatch,
    },
    // FEA-1718 (review, wongk): read the attribution back rather than reusing
    // the incoming payload. The update arm writes only NON-NULL attribution, so
    // a delivery that omits `sourceLoopId` PRESERVES the stored one — deriving
    // the back-link from the incoming value therefore skipped a session that was
    // still legitimately loop-linked, and disagreed with the row it had just
    // written. The committed row is the single source of truth for both the loop
    // identity and the start timestamp the claim orders on.
    select: {
      artifactId: true,
      sourceLoopId: true,
    },
  });

  const { maxEventCreatedAt } = await persistSessionChildren(
    tx,
    persisted.artifactId,
    context.organizationId,
    session,
    normalizedTokenUsage,
    { shouldReplace, shouldUpdateTokenEventCosts }
  );

  // ISS-5981: the RAW status, deliberately — this is the one place downstream of
  // the fold that must still see the spelling the producer sent.
  //
  // `maybeReopenTerminalSession` is an INPUT-tolerance surface: it folds at its
  // own write (`normalizeSessionStatus(action.incomingStatus)`), so nothing
  // unfolded reaches a column. Both of its reads of this value need the raw
  // form, and threading the folded one broke each:
  //   • `shouldReopenSession` compares it RAW against `active`/`waiting`. Folded,
  //     every unmodelled spelling and `running` arrive as `active` and pass a
  //     predicate that used to reject them — resurrecting a finished run,
  //     clearing its `session_ended_at`, and restarting its duration.
  //   • `resolveReopenAwaitingInputSince` synthesizes the anchor from
  //     `maxEventCreatedAt` only when the status IS `waiting` (ISS-5974). Folded,
  //     that branch is unreachable, and the stored fallback cannot cover it: a
  //     reopen only fires on a TERMINAL row, whose anchor both writers have
  //     already nulled. The run reopens Active with no anchor, then ages Stale.
  // The anchor is the RAW declared value for the same reason. A reopen resolves
  // its own fallback from `maxEventCreatedAt` — the moment the run actually
  // resumed — which is a better anchor for a reopened run than this write's
  // activity-clock synthesis, and is unavailable here anyway (it comes from
  // `persistSessionChildren`, above). Handing it the already-resolved value
  // would pre-empt that with a staler timestamp.
  await maybeReopenTerminalSession(
    tx,
    {
      persistedStatus: toReopenPersistedStatus(existing?.artifact?.status),
      incomingStatus: session.status,
      maxEventCreatedAt,
      persistedSessionEndedAt: guardedTimestamps.sessionEndedAt,
    },
    {
      artifactId: persisted.artifactId,
      incomingStatus: session.status,
      incomingAwaitingInputSince: toDate(session.awaitingInputSince),
    }
  );

  await persistArtifactLinks(
    tx,
    context.organizationId,
    persisted.artifactId,
    session.artifactRefs,
    slugMap
  );
  // ISS-4946 (review, #4327): delete-and-recreate, so it carries the same
  // watermark gate as the `pullRequests` blob above — ungated, a stale
  // redelivery kept the newer blob and still wiped the links, and the read
  // boundary splits on exactly that seam (`toSessionPullRequestProjection` seeds
  // `prs` from the blob while `verifiedMergedCount` comes from the links).
  // The tie arm reads `prRefs`' own evidence, because this call's `deleteMany`
  // is what does the wiping: letting it through on the blob's evidence would
  // recreate that split state from inside the gate meant to prevent it.
  if (freshness.shouldUpdatePullRequestLinks) {
    await persistSessionPrArtifactLinks(
      tx,
      context.organizationId,
      persisted.artifactId,
      session.prRefs
    );
  }
  // Re-read and lock repository-default authority inside this session's write
  // transaction. The batch-wide project/slug preflight is safe to cache, but
  // eligibility authority is mutable and must not change between validation
  // and branch/PR-head materialization (ISS-5827 / COMMON-021).
  const branchRepoIdByFullName = await resolveBranchRepoMap(
    tx,
    context.organizationId,
    [session]
  );
  await persistSessionBranchArtifactLinks(
    tx,
    context.organizationId,
    projectId,
    persisted.artifactId,
    session.artifactRefs,
    branchRepoIdByFullName
  );
  const pullRequestDetails = await persistSessionPullRequestDetails(
    tx,
    context.organizationId,
    projectId,
    persisted.artifactId,
    session.artifactRefs,
    branchRepoIdByFullName
  );
  await persistMonitoredSessionActivity(tx, {
    organizationId: context.organizationId,
    sessionArtifactId: persisted.artifactId,
    artifactRefs: session.artifactRefs,
    pullRequestDetails,
    repositoryAuthorityByFullName: branchRepoIdByFullName,
  });
  await persistSessionCommitRefs(
    tx,
    context.organizationId,
    persisted.artifactId,
    session.artifactRefs
  );
  await persistSessionComponentUsage(
    tx,
    context.computeTargetId,
    persisted.artifactId,
    session
  );
  return {
    loopBacklink: resolveLoopSessionBacklink({
      organizationId: context.organizationId,
      sessionArtifactId: persisted.artifactId,
      sourceLoopId: persisted.sourceLoopId,
    }),
    persisted: true,
    unmodelledStatus,
  };
}

/**
 * ISS-5981: the RAW spelling when this build does not model it, else null — the
 * value `SessionSyncMetric.UnmodelledStatusFolded` samples.
 *
 * A named helper rather than an inline ternary only because `upsertSessionSlice`
 * sits at the cognitive-complexity ceiling; the repo's rule is to extract rather
 * than raise it.
 */
function resolveUnmodelledStatus(status: string): string | null {
  return isRecognizedSessionStatus(status) ? null : status;
}

/**
 * ISS-5981: the `awaitingInputSince` this write persists — the awaiting-input
 * signal in its only durable form, now that `waiting` is never a stored status.
 *
 * Folding the status without this is silent data loss. The wire schema declares
 * `awaitingInputSince` as `.nullable().optional()`, so a version-skewed desktop
 * can send `waiting` carrying NO timestamp; while the column held the word, that
 * payload still displayed correctly, because `resolveDisplayedSessionStatus`
 * returns WAITING from the raw value before it consults any timestamp. Rewriting
 * the status to `active` and leaving the anchor null would drop the run's only
 * claim to be blocked on a human — it would read Active, then Stale once it aged
 * past the display cutoff.
 *
 * So a `waiting` payload that declares no timestamp resolves DECLARED → STORED →
 * SYNTHESIZED, and all three tiers are load-bearing:
 *
 *   • STORED pins the moment the run FIRST asked, which is what the elapsed-time
 *     display means. `detailData.awaitingInputSince` is spread into both upsert
 *     arms unconditionally, so every sync rewrites the column; without this tier
 *     a run blocked for three days would re-anchor to "now" on every batch.
 *   • SYNTHESIZED is what the STORED tier alone cannot cover, and both gaps are
 *     reachable (#5018 review): a FIRST sync has no row to read, and the
 *     pre-ISS-5981 stored-`waiting` population — which was written with a null
 *     anchor precisely because the word carried the signal — is REWRITTEN to
 *     `active` on its next sync. With no third tier both land `null` and drop
 *     out of the Waiting facet, which is the read-visible migration this fold
 *     must not perform. It mirrors `resolveReopenAwaitingInputSince`, whose
 *     equivalent tier is `maxEventCreatedAt`; that value is not available here
 *     (it comes from `persistSessionChildren`, further down), so this uses the
 *     payload's own activity clock, which is stable across resyncs.
 *
 * Every other payload keeps its incoming value verbatim, including a null: a
 * non-`waiting` payload asserts no awaiting-input state, so clearing a stale
 * anchor is the honest write rather than a loss. The RAW comparison (not a fold)
 * mirrors `resolveReopenAwaitingInputSince`, so the value that MEANS waiting is
 * the value that anchors it.
 */
function resolveIngestAwaitingInputSince(
  session: SyncedAgentSession,
  existing: { awaitingInputSince: Date | null } | null
): Date | null {
  const declared = toDate(session.awaitingInputSince);
  if (declared || session.status !== DISPLAYED_SESSION_STATUS.WAITING) {
    return declared;
  }
  return (
    existing?.awaitingInputSince ??
    toDate(session.lastActivityAt) ??
    toDate(session.startedAt)
  );
}

/**
 * The stored session status as the reopen predicate takes it: NORMALIZED at
 * this read boundary, so `shouldReopenSession` reasons in the vocabulary rather
 * than about strings, and `null` when there is no stored row.
 *
 * This is the STORED value, deliberately, not the `guardedStatus` this write
 * resolves to. `resolveGuardedStatus` returns the incoming status whenever the
 * stored one is non-terminal, so the guarded value would report an `active` row
 * receiving an incoming `inactive` as having already finished.
 *
 * A named helper rather than a ternary at the call site only because inlining
 * it puts `upsertSessionSlice` over the cognitive-complexity ceiling.
 */
function toReopenPersistedStatus(
  status: string | null | undefined
): SessionStatus | null {
  return status ? normalizeSessionStatus(status) : null;
}
