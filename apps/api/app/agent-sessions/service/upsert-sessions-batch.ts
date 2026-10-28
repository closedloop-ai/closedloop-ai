import type { DesktopAgentSessionsPayload } from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { frustrationSettingService } from "@/app/settings/frustration-setting-service";
import {
  HeldRevisionRequiresRowLevelAckError,
  SessionTimestampOutOfRangeError,
} from "@/lib/desktop-agent-sessions-errors";
import { recordObservedRepositories } from "@/lib/github/observed-repository-store";
import {
  type RecordWriteInTransaction,
  writeInShape,
} from "@/lib/record-write-in-transaction";
import {
  countStrippedTilings,
  reportStrippedTilings,
} from "./activity-tiling-strip";
import { resolveArtifactSlugMap } from "./artifact-links/slug-links";
import { deriveCommittedImplementationEvidence } from "./attribution/derive-committed-implementation-evidence";
import {
  collectPostCommitSession,
  collectPostCommitSessions,
} from "./attribution/session-evidence-links";
import { settleCommittedSessionEvidence } from "./attribution/settle-committed-session-evidence";
import {
  countDegradedMetadataSessions,
  reportDegradedMetadata,
} from "./degraded-metadata-merge";
import {
  stampIngestSyncWatermark,
  stampIngestWatermarkAfterFailedBatch,
} from "./ingest-sync-stamp";
import {
  AGENT_SESSION_UPSERT_TX_MAX_WAIT_MS,
  AGENT_SESSION_UPSERT_TX_TIMEOUT_MS,
  resolveSessionIngestSliceBudget,
  type SessionIngestSliceBudget,
  SessionIngestWorkBudget,
} from "./ingest-work-budget";
import { reportAbandonedMonitoredActivityHolds } from "./monitored-activity-hold-ceiling";
import {
  emptyMonitoredActivityOutcomeCounts,
  MonitoredActivityOutcome,
  type MonitoredActivityOutcomeCounts,
  monitoredActivityCandidateCount,
} from "./monitored-session-activity-persistence";
import { resolveProjectResolution } from "./project-resolution";
import type { UpsertSessionsContext } from "./records";
import { reportRowLevelAckNotRequested } from "./row-level-ack-contract-telemetry";
import { reportSessionBatchIndexKeyProjections } from "./session-batch-index-key-telemetry";
import {
  isSliceDeadlineFailure,
  reportLegacyBatchDeadlineFailure,
  reportSessionIngestDeadlineExceeded,
} from "./session-ingest-deadline-report";
import {
  createSessionOmissionTally,
  reportSessionOmissions,
  resolveOmissionCause,
  SessionOmissionCause,
} from "./session-omission-report";
import type { UpsertSessionSliceResult } from "./session-slice-result";
import { SessionSyncMetric } from "./session-sync-metrics";
import { createStatusFoldTally } from "./status-fold-telemetry";
import { upsertSessionSlice } from "./upsert-session-slice";
import {
  foldDroppedUsageBuckets,
  foldUnstorableCounters,
  reportDroppedUsageBuckets,
  reportUnstorableCounters,
} from "./upsert-sessions-batch-drop-tallies";
import {
  resolveSessionWireDataRevisionDisposition,
  type SentinelHoldReason,
  SessionGateHoldReason,
  type SessionHoldReason,
  WireDataRevisionSkipReason,
} from "./wire-data-revision";

/**
 * PLN-1775 M1: how many DISTINCT repositories one batch may record as discovery
 * candidates. Nothing on the wire bounds the ref count any more (ISS-8051), so
 * the distinct-name set is bounded only by the caller without this. It DROPS the
 * overflow into `tally.dropped` rather than rejecting: a real org works in far
 * fewer repositories than one payload could name, and a discovery candidate is a
 * derived hint whose loss costs nobody a session.
 */
export const MAX_OBSERVED_REPOSITORIES_PER_SYNC_REQUEST = 500;
/**
 * The desktop-sync ingest batch: resolve once what every per-session slice
 * needs, apply each session in its own bounded transaction, then stamp the
 * target watermarks.
 *
 * Lifted out of `service.ts` alongside the
 * FEA-1718 back-link, following the `buildUsageSummary` precedent: the service
 * object keeps the method because the route and its tests address it, while the
 * ingest sequencing lives with the slice it drives.
 *
 * ISS-8051: there is no batch-wide monitored-activity target budget, and
 * re-adding one would be a regression, not a hardening. The write it guarded is
 * ALREADY split — `persistMonitoredSessionActivity` runs per slice on that one
 * session's `artifactRefs`, inside that slice's own bounded transaction — so the
 * session boundary is the chunk boundary and a request-wide DISTINCT count is a
 * proxy for nothing the database ever sees. It was in fact anti-correlated with
 * the real pressure: 200 sessions naming the SAME 500 targets counted as 500 and
 * was admitted, at 500 lock acquisitions per transaction in each of 200
 * transactions, while two sessions naming 300 distinct targets each counted as
 * 600 and was refused entire — 300 per transaction. Nothing survives the
 * rejection either, because the recovery it assumed (FEA-4375 isolating one id
 * and re-sending it alone) converged only while a per-session wire cap kept a
 * lone session under the aggregate; with that cap gone, an isolated session that
 * breaches the budget draws the identical rejection forever.
 *
 * NOTHING ON THE SERVER BOUNDS A SLICE'S MONITORED-ACTIVITY WORK (ISS-9860).
 * `collectCandidates` used to truncate each session to 100 candidates and
 * re-stamp the survivors `Partial`; that cap dropped every event past it with no
 * cursor able to reach the tail again, so it is gone. The bound is now the
 * PRODUCER'S: the desktop pages a session's carriers at
 * `MONITORED_ACTIVITY_SYNC_PAGE_EVENTS` (1,000) distinct events per request
 * (`apps/desktop/src/main/agent-sync/monitored-activity-sync-pages.ts`), and the
 * server does not enforce it — a skewed or hostile client can send more, and
 * every candidate it sends is persisted. What keeps a wide page from FAILING is
 * that every per-event statement on the path is chunked by bind budget where it
 * is issued (`persistMonitoredActivityQuarantineRows`, `loadQuarantineRows`,
 * `classifyLegacyMonitoredActivityReplays`, `claimLegacyMonitoredActivityAliases`,
 * `persistBranchActivityAtomsInTransaction`), so the ceiling a page can hit is
 * `AGENT_SESSION_UPSERT_TX_TIMEOUT_MS` (30,000 ms), never Prisma's 32,767-bind
 * parameter limit. Measured 2026-09-14 against local PostgreSQL: one full
 * 1,000-event page through `persistMonitoredSessionActivity` commits in
 * 1.1-1.6 s across three runs
 * (`__tests__/integration/branch-activity-evidence-batch.integration.test.ts`
 * annotates each run), roughly one twentieth of that timeout.
 *
 * THE SLICE HAS OTHER UNBOUNDED WORK TOO. The slice's LINKS phase
 * (`session-slice-links.ts`) runs the generic branch and PR lanes BEFORE
 * `persistMonitoredSessionActivity`, and the branch
 * lane awaits `ensureBranchArtifactRow` once per DISTINCT branch identity folded
 * from the session's whole `artifactRefs` array, which ISS-8051 uncapped. So a
 * session declaring many distinct branches still drives that many sequential
 * awaits inside one transaction, and can exhaust `AGENT_SESSION_UPSERT_TX_TIMEOUT_MS`
 * on a payload the wire now accepts. Bounding that lane is ISS-8186, not a
 * property this module currently holds.
 *
 * Multi-session payloads remain accepted for version skew even though the
 * desktop now sends one session per request, and each slice commits on its own —
 * so a batch that fails partway leaves the already-committed sessions durable,
 * which is exactly what the landed-data watermark in the `finally` reports.
 *
 * ONE FAILING SESSION MUST NOT REJECT THE SESSIONS AROUND IT. A slice that threw
 * used to escape this loop, so the handler rejected the whole batch: sessions
 * queued behind the failure were never attempted, committed ones were re-sent,
 * and one permanently-uningestible session dead-lettered every healthy session
 * batched with it, on every retry. This reaches the MULTI-session fresh drain; a
 * chunked session is one chunk per request, so it has no bystanders and a
 * failing chunk still rejects its own request.
 *
 * GATED ON `wantsAcceptedSessionIds`, the only thing that makes a partial batch
 * expressible on the wire. Without it `accepted: true` means "all of it landed",
 * so continuing past a failure would let a version-skewed desktop clear rows the
 * server never stored.
 *
 * A batch where EVERY slice threw still throws: that is the server-fault shape,
 * and `ingestion_failed` is what makes the desktop back off instead of walking
 * its whole outbox through the `ack_omitted` budget. The test is every-slice-
 * threw and NOT "nothing persisted", because a slice can decline to write
 * without failing (the foreign chunk below) — still a partial outcome.
 *
 * Goal stage 2 (atomic row-level ack): resolves to the `externalSessionId`s
 * this batch actually PERSISTED, so the desktop's outbox clear can be keyed on
 * server truth rather than on what the client sent. Echoing a sent id the
 * server did not store would let the desktop clear a row that was never
 * written, which is silent loss.
 *
 * WHAT WITHHOLDS AN ID FROM THAT ECHO — more than the two an earlier version of
 * this docstring named (ISS-8781). A no-write HOLD: a foreign chunk, either
 * revision sentinel, or a revision-less payload arriving mid chunk sequence. A
 * slice that THREW and was isolated so it could not reject the rest of the
 * batch. A slice that COMMITTED while a monitored-activity target stays
 * unresolved (`persisted && retryRequired` — the session IS in the cloud and its
 * id is still withheld). And a tail the runtime budget never reached.
 * `SessionOmissionCause` is the enumeration of record; this list carries no
 * count, because a number written out in prose goes stale the moment a path is
 * added. Each was reasoned about individually and none was reportable: nothing
 * named WHICH id or WHY, so an omission could be attributed only by pulling a
 * desktop's local SQLite store. `service/session-omission-report.ts` closes
 * that, DERIVING the withheld population as `payload.sessions` minus this echo,
 * so a NEW cause cannot join the list in silence the way the last two did.
 *
 * ISS-8186 (BOUNDED WORK, NOT A BOUNDED WIRE). The loop below opens one
 * transaction per session and awaits it, so its cost is the caller's session
 * count and nothing on either transport bounds that: ~10,000 minimal sessions
 * fit inside every byte ceiling the route and the socket lane apply. Left
 * unbounded the request outruns the 60 s function ceiling and the desktop's
 * 30 s client timeout, and a client that abandoned the request reads no ack at
 * all — so the committed prefix is re-sent in full, forever, and nothing
 * converges. `SessionIngestWorkBudget.RuntimeMs` stops the loop from STARTING a
 * new slice unless what remains of that allowance COVERS the slice — its
 * connection acquisition and its transaction deadline both — and the deadline
 * the slice is handed is that remainder rather than a fixed 30 s
 * (`resolveSessionIngestSliceBudget`). Asking only whether the allowance was
 * already spent reproduced the very livelock above: a slice admitted at 19.9 s
 * could still run its full transaction timeout and push the answer past the
 * client's 30 s (davetho, #6080). The sessions the loop did not reach are
 * simply absent from the ack echo, which is the same "these landed, that one did
 * not" answer a failed slice already produces.
 *
 * GATED ON `rowLevelAck` FOR THE SAME REASON THE FAILURE SKIP IS. Without the
 * echo, `accepted: true` means "all of it landed", so stopping early would let
 * the desktop clear rows the server never attempted — silent loss. A legacy
 * client therefore keeps today's all-or-nothing behaviour exactly.
 *
 * ALWAYS AT LEAST ONE SLICE. The check is skipped for the first session of a
 * request, so every request makes strict progress and the remaining set shrinks
 * monotonically; a deferral that could return zero sessions would be a livelock,
 * not a bound. That first slice therefore keeps the full, unclamped transaction
 * guardrail — see the budget module for why shortening it would trade one
 * non-convergence for a worse one.
 *
 * What may be hoisted into the batch-wide preflight below, and what may NOT.
 * The project and slug maps are safe to resolve once here: they are pooled reads
 * and nothing locks on them. The repository-default authority map is NOT — it
 * stays in `session-slice-links.ts`, inside each slice's write transaction,
 * because eligibility authority is mutable and must not change between
 * validation and branch/PR-head materialization (ISS-5827 / COMMON-021).
 * Hoisting `resolveSessionRepositoryIdentity` up here to "remove the N+1" would break it
 * silently rather than loudly: `readLockedAuthorityRows` takes
 * `FOR SHARE OF repository, installation`, and a row lock taken through pooled
 * `withDb` is released at statement end, so the caller would still receive an
 * identical-looking map with no lock behind it and no test would distinguish
 * the two.
 */
export async function upsertSessionsBatch(
  context: UpsertSessionsContext,
  payload: DesktopAgentSessionsPayload,
  options: UpsertSessionsBatchOptions = {}
): Promise<{ persistedSessionIds: string[] }> {
  const readNowMs = options.readNowMs ?? Date.now;
  const startedAtMs = readNowMs();
  const syncTimestamp = new Date();

  // FEA-4022: resolve the org's `calculateSessionFrustration` gate ONCE for the
  // batch BEFORE opening the interactive transaction (a pooled read, keeping the
  // transaction narrow per the serverless-tx guidance). When the org has not
  // opted in, the desktop-computed raw frustration signal is dropped at ingest —
  // never written to SessionDetail — so the column stays NULL and Insights
  // renders an empty state.
  const includeFrustration =
    await frustrationSettingService.isFrustrationEnabled(
      context.organizationId
    );

  let batchSucceeded = false;
  // Stage 2 tracks the ids actually persisted (the ack echo is keyed on them);
  // monitored-activity repair adds one deliberate distinction: a Session can
  // commit while remaining ineligible for acknowledgement until a bounded
  // unresolved target converges. The landed-data watermark therefore counts
  // committed slices separately from the acknowledgement echo.
  const persistedSessionIds: string[] = [];
  let persistedSessionCount = 0;
  // ISS-7265: the ids of every slice that COMMITTED — the committed half of the
  // strip report's population, which is NEITHER of the two contracts around it
  // (whitlockk, #5741). It is deliberately WIDER than `persistedSessionIds`: a
  // session held back by an unresolved monitored-activity target is withheld
  // from the ack echo on every attempt while its strip column is already
  // durable, so keying the report on the echo would go permanently silent on
  // exactly the rows most likely to be stuck.
  //
  // It is not the whole definition — the report also narrows to a session's
  // FINAL delivery, which `countStrippedTilings` applies from the payload's own
  // chunk marker so the population is stated in one place. See its docstring.
  const committedSessionIds: string[] = [];
  // Only the row-level ack can express "these landed, that one did not", so it
  // is what licenses skipping a failed slice at all (see the header).
  const rowLevelAck = payload.wantsAcceptedSessionIds === true;
  // ISS-8622: count the legacy shape off that SAME derivation, before anything
  // can reject the batch — `assertHoldExpressible` below throws outside the
  // `try`, and a legacy batch carrying a held revision is the population most
  // worth counting. At most one emission per (org, target) per window, NOT per
  // request: the legacy band is a normal-path property, so an un-throttled
  // count would ride every sync for the whole migration window. The bound, and
  // why it is what makes the distinct-target reading countable, are on
  // `row-level-ack-contract-telemetry.ts`.
  reportRowLevelAckNotRequested(context, rowLevelAck, payload.sessions.length);
  // ISS-8271 (cr-15119 bha_p0_f0): it is also what licenses the revision HOLD,
  // so a batch that cannot read a partial ack is rejected up front — BEFORE any
  // slice commits — when it carries a session the apply would hold.
  assertHoldExpressible(rowLevelAck, payload.sessions);
  // ISS-8186: how many sessions this request actually reached, and whether the
  // runtime budget is what stopped it. Declared out here so the `finally` can
  // report a deferral on a batch that later threw.
  let attemptedSessionCount = 0;
  let runtimeBudgetExhausted = false;
  const sliceFailures: SliceFailure[] = [];
  const statusFoldTally = createStatusFoldTally();
  const monitoredActivityOutcomeCounts = emptyMonitoredActivityOutcomeCounts();
  // ISS-8271: held-revision tallies, ONE emission per reason per batch — held
  // rows are re-sent by design (ack_omitted), so a per-row emission would be
  // caller-drivable log amplification, the same bound the neighbours keep.
  const heldRevisionCounts: Record<SentinelHoldReason, number> = {
    [WireDataRevisionSkipReason.RevisionPending]: 0,
    [WireDataRevisionSkipReason.RevisionTooNew]: 0,
    [SessionGateHoldReason.SequenceAssembling]: 0,
  };
  // ISS-8781: which ids this batch withheld from the ack echo, and why. Fed as
  // the loop runs and settled against the DERIVED withheld population after it,
  // so a cause nothing attributes is still reported rather than dropped.
  const omissionTally = createSessionOmissionTally();
  // PLN-1775 M1: repositories named by COMMITTED slices that the server holds no
  // record of, tallied across the batch and written once after the loop. A
  // failed slice contributes nothing, so what is written describes durable
  // sessions only.
  const observedRepositoryCounts = new Map<string, number>();
  // The names the cap turned away, as a SET: two sessions naming the same
  // uncounted repository are one repository discovery will miss, and a plain
  // accumulator would report it as two.
  const observedRepositoryDropped = new Set<string>();
  // ISS-8069: how many index-key columns this batch had to project down before
  // they could be written. ONE emission per batch, never one per session — the
  // same amplification bound `SliceFailed` and the status-fold tally keep.
  let indexKeyProjections = 0;
  // ISS-8330 / ISS-8881: the usage buckets this batch DROPPED because a count
  // could not be stored in `int4` — a phantom-fold merge, or since ISS-8881 an
  // un-merged single row off the wire. Same bound, and it needs one: the drop is
  // deterministic, so the desktop re-sends it on every retry, and `sessions`
  // carries no `.max()` (`desktop-agent-sessions-schema.ts:892`), so a
  // per-slice emission scales with the payload. The COUNT is every dropped
  // bucket; the SET is the distinct keys the warn may name, capped
  // independently of it.
  const droppedUsageTally = { count: 0, keys: new Set<string>() };
  // ISS-12552: sessions whose evidence links are synced, and whose
  // implementation evidence is derived, after their slice commits.
  const evidenceLinksSessionIds: string[] = [];
  const evidenceBindingSessionIds: string[] = [];
  const implementationEvidenceSessionIds: string[] = [];
  // ISS-8881: the sibling tally for session COUNTER fields that could not be
  // stored. No cap on `fields`, unlike the bucket keys above: that key space is
  // CLOSED — seven field names this code owns — so it is not caller-drivable.
  // `sessionIds` is, so it is sampled.
  const unstorableCounterTally = {
    count: 0,
    fields: new Set<string>(),
    sessionIds: [] as string[],
  };
  try {
    const { projectResolution, slugMap } = await withDb(async (db) => {
      const target = await db.computeTarget.findFirst({
        where: {
          id: context.computeTargetId,
          organizationId: context.organizationId,
        },
        select: {
          id: true,
        },
      });
      if (!target) {
        throw new Error("compute_target_not_found");
      }

      const [resolvedProjects, resolvedSlugs] = await Promise.all([
        resolveProjectResolution(db, context.organizationId, payload.sessions),
        resolveArtifactSlugMap(db, context.organizationId, payload.sessions),
      ]);

      return {
        projectResolution: resolvedProjects,
        slugMap: resolvedSlugs,
      };
    });

    for (const session of payload.sessions) {
      const sliceBudget = resolveSliceBudget({
        attemptedSessionCount,
        readNowMs,
        rowLevelAck,
        startedAtMs,
      });
      if (sliceBudget.defer) {
        runtimeBudgetExhausted = true;
        break;
      }
      attemptedSessionCount += 1;
      let outcome: UpsertSessionSliceResult;
      try {
        outcome = await upsertSliceInShape(
          options.recordSessionWrite,
          {
            context,
            // ISS-7516: batch-level — the level belongs to the sending device,
            // so every session in this batch was gated by the same setting.
            dataSyncLevel: payload.dataSyncLevel,
            includeFrustration,
            projectResolution,
            rowLevelAck,
            session,
            slugMap,
            syncTimestamp,
          },
          {
            timeout: sliceBudget.transactionTimeoutMs,
            maxWait: AGENT_SESSION_UPSERT_TX_MAX_WAIT_MS,
          }
        );
      } catch (error) {
        if (!rowLevelAck) {
          // ISS-8145: a legacy client's batch is all-or-nothing, so this
          // rethrow is the same non-convergence as the all-failed exit in
          // `settleSliceFailures`, and nothing downstream reports it. The
          // deadline test lives in the reporter — this loop is at the
          // cognitive-complexity ceiling and cannot afford a branch.
          reportLegacyBatchDeadlineFailure(
            context,
            error,
            session.externalSessionId
          );
          throw error;
        }
        sliceFailures.push({
          error,
          externalSessionId: session.externalSessionId,
        });
        omissionTally.record(
          session.externalSessionId,
          SessionOmissionCause.SliceThrew
        );
        continue;
      }
      const { persisted, retryRequired } = outcome;
      // ISS-8781: `null` for a slice whose id IS echoed, and the tally drops it —
      // no branch here, because this loop already sits at the complexity ceiling.
      omissionTally.record(
        session.externalSessionId,
        resolveOmissionCause(outcome)
      );
      indexKeyProjections += outcome.indexKeyProjections;
      foldDroppedUsageBuckets(
        droppedUsageTally,
        outcome.droppedOverflowUsageBuckets
      );
      foldUnstorableCounters(
        unstorableCounterTally,
        outcome.unstorableCounterFields,
        session.externalSessionId
      );
      recordHeldRevision(heldRevisionCounts, outcome.heldRevisionReason);
      collectPostCommitSession(
        evidenceLinksSessionIds,
        outcome.evidenceLinksSessionId
      );
      collectPostCommitSession(
        implementationEvidenceSessionIds,
        outcome.implementationEvidenceSessionId
      );
      collectPostCommitSessions(
        evidenceBindingSessionIds,
        outcome.evidenceBindingSessionIds
      );
      if (persisted) {
        persistedSessionCount += 1;
        committedSessionIds.push(session.externalSessionId);
      }
      if (persisted && !retryRequired) {
        persistedSessionIds.push(session.externalSessionId);
      }
      statusFoldTally.record(outcome);
      foldObservedRepositories(
        {
          counts: observedRepositoryCounts,
          dropped: observedRepositoryDropped,
        },
        outcome.observedRepositoryFullNames
      );
      mergeMonitoredActivityOutcomeCounts(
        monitoredActivityOutcomeCounts,
        outcome.monitoredActivityOutcomeCounts ??
          emptyMonitoredActivityOutcomeCounts()
      );
    }

    settleSliceFailures(context, sliceFailures, attemptedSessionCount);

    batchSucceeded = true;
  } finally {
    // ISS-5648 (whitlockk, PR #4786): one aggregate emission per source for the
    // whole request, never one per session. Rationale, and why `finally`:
    // `service/status-fold-telemetry.ts`.
    statusFoldTally.emit(context);
    emitMonitoredActivityOutcomeCounts(context, monitoredActivityOutcomeCounts);
    emitHeldRevisionCounts(context, heldRevisionCounts);
    reportRuntimeBudgetDeferral(context, {
      attemptedSessionCount,
      runtimeBudgetExhausted,
      sentSessionCount: payload.sessions.length,
    });
    reportSessionBatchIndexKeyProjections(context, indexKeyProjections);
    reportDroppedUsageBuckets(context, droppedUsageTally);
    reportUnstorableCounters(context, unstorableCounterTally);
    if (batchSucceeded) {
      await withDb((db) =>
        stampIngestSyncWatermark(db, {
          computeTargetId: context.computeTargetId,
          persistedSessionCount,
          syncTimestamp,
        })
      );
    } else {
      await stampIngestWatermarkAfterFailedBatch({
        computeTargetId: context.computeTargetId,
        persistedSessionCount,
        syncTimestamp,
      });
    }
    // ISS-8781: the omission report is settled here, in the `finally`, alongside
    // its neighbours — but unlike them it is GATED on `batchSucceeded`, because a
    // batch that rethrew produced no ack for anything to be omitted from. Its
    // other gate is `rowLevelAck`; both live in the report, with their reasoning.
    //
    // AFTER THE WATERMARK STAMPS, deliberately. `batchSucceeded` is set while the
    // loop is still unwinding, so a report placed with the emissions above would
    // describe an ack echo a watermark failure then prevented the handler from
    // ever sending. The report never throws, so the discovery flush and the two
    // degradation reports below still run.
    reportSessionOmissions(context, omissionTally, {
      attemptedSessionCount,
      batchSucceeded,
      persistedSessionIds,
      rowLevelAck,
      sessions: payload.sessions,
    });
    // In the `finally` so the committed slices of a batch that later threw still
    // record what they observed: the discovery candidate is the only trace an
    // installation-free org leaves, and re-deriving it costs another full sync.
    await flushObservedRepositories(context, {
      counts: observedRepositoryCounts,
      dropped: observedRepositoryDropped,
      now: syncTimestamp,
    });
    // Committed slices only, outside every slice transaction; never throws.
    await deriveCommittedImplementationEvidence(
      context.organizationId,
      implementationEvidenceSessionIds
    );
    await settleCommittedSessionEvidence(
      context.organizationId,
      evidenceLinksSessionIds,
      evidenceBindingSessionIds
    );
    // ISS-7265: one aggregate report per batch for the sessions that COMMITTED
    // their FINAL delivery without their activity tiling — `countStrippedTilings`
    // states that population and why it is neither neighbour. In the `finally`
    // for the same reason the discovery flush is: a batch that later threw still
    // persisted those slices, and the strip is the only trace the degradation
    // leaves.
    reportStrippedTilings(
      context,
      countStrippedTilings(payload.sessions, committedSessionIds)
    );
    // ISS-8641 / ISS-8714: the same shape for the sessions that landed a DEGRADED
    // `metadata` blob. Reported even though the merge now preserves what the row
    // held, because the merge repairs a RESYNC and not a first delivery — and
    // because a blob that stays oversized keeps degrading forever, which is the
    // fact an operator needs and no column records.
    reportDegradedMetadata(
      context,
      countDegradedMetadataSessions(payload.sessions, committedSessionIds)
    );
  }
  return { persistedSessionIds };
}

/**
 * ISS-8186: report the tail this request handed back, once per batch.
 *
 * Silent truncation is what would make this a data-loss design, so the deferral
 * is stated on both sides of the wire: here for the operator, and on the wire by
 * the deferred ids being ABSENT from the ack echo, which is what keeps the
 * desktop's outbox rows queued. Emitted only when the budget is what stopped the
 * loop — a batch that ran to completion has no tail to describe, and counting
 * zero would read as coverage.
 */
function reportRuntimeBudgetDeferral(
  context: UpsertSessionsContext,
  input: {
    attemptedSessionCount: number;
    runtimeBudgetExhausted: boolean;
    sentSessionCount: number;
  }
): void {
  const deferredSessionCount =
    input.sentSessionCount - input.attemptedSessionCount;
  if (!input.runtimeBudgetExhausted || deferredSessionCount <= 0) {
    return;
  }
  log.warn("Desktop agent session batch deferred a tail to the next request", {
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
    attemptedSessionCount: input.attemptedSessionCount,
    deferredSessionCount,
    runtimeBudgetMs: SessionIngestWorkBudget.RuntimeMs,
  });
  emitTelemetryMetric({
    metric: SessionSyncMetric.IngestRuntimeBudgetDeferred,
    organizationId: context.organizationId,
    computeTargetId: context.computeTargetId,
    count: deferredSessionCount,
    attemptedSessionCount: input.attemptedSessionCount,
  });
}

/**
 * Decide what a batch's isolated slice failures mean, once the loop has ended.
 *
 * `attemptedSessionCount`, not `payload.sessions.length`, is the denominator
 * (ISS-8186): a budget-deferred tail is not evidence that the server is healthy,
 * so measuring against what was SENT would answer `accepted: true` with an empty
 * echo for a batch whose every attempted slice threw. The desktop would then
 * burn its bounded `ack_omitted` allowance on rows the server is failing
 * outright, instead of backing off on `ingestion_failed`.
 *
 * Every attempted slice failing is the server-fault shape, so the batch is
 * rejected rather than answered with an empty echo (see the header). No
 * per-slice report on that path — `SliceFailed` deliberately does not count an
 * outage.
 */
function settleSliceFailures(
  context: UpsertSessionsContext,
  failures: readonly SliceFailure[],
  attemptedSessionCount: number
): void {
  if (failures.length === 0) {
    return;
  }
  // ISS-8145: reported on BOTH exits, and the throwing one is the point. A batch
  // whose every slice failed is rejected as `ingestion_failed` and emitted
  // nothing at all, so a single session too large for its own deadline — the one
  // shape that cannot converge, because the re-send changes neither the payload
  // nor the deadline — was also the one shape with no counter behind it.
  reportSessionIngestDeadlineExceeded(
    context,
    failures
      .filter((failure) => isSliceDeadlineFailure(failure.error))
      .map((failure) => failure.externalSessionId)
  );
  if (failures.length === attemptedSessionCount) {
    throw failures[0].error;
  }
  reportSliceFailures(context, failures);
}

/**
 * Whether this request may open another slice transaction, and under what
 * deadline.
 *
 * A helper rather than an inline condition so the loop stays under the
 * cognitive-complexity ceiling, and so the two gates that are NOT about elapsed
 * time are stated where they can be read: without the row-level echo a partial
 * batch is inexpressible, and the first session of a request is always
 * attempted so the remaining set strictly shrinks.
 *
 * Both of those exits keep the unclamped `AGENT_SESSION_UPSERT_TX_TIMEOUT_MS`
 * and, deliberately, do not read the clock at all — a legacy client's batch is
 * unbounded by contract, and the mandatory first slice must not be shortened by
 * however long the batch-wide preflight above happened to take.
 */
function resolveSliceBudget(input: {
  attemptedSessionCount: number;
  readNowMs: () => number;
  rowLevelAck: boolean;
  startedAtMs: number;
}): SessionIngestSliceBudget {
  if (!input.rowLevelAck || input.attemptedSessionCount === 0) {
    return {
      defer: false,
      transactionTimeoutMs: AGENT_SESSION_UPSERT_TX_TIMEOUT_MS,
    };
  }
  return resolveSessionIngestSliceBudget(input.startedAtMs, input.readNowMs());
}

function mergeMonitoredActivityOutcomeCounts(
  target: MonitoredActivityOutcomeCounts,
  source: MonitoredActivityOutcomeCounts
): void {
  for (const outcome of Object.values(MonitoredActivityOutcome)) {
    target[outcome] += source[outcome];
  }
}

function emitMonitoredActivityOutcomeCounts(
  context: UpsertSessionsContext,
  counts: MonitoredActivityOutcomeCounts
): void {
  const total = monitoredActivityCandidateCount(counts);
  if (total === 0) {
    return;
  }
  emitTelemetryMetric({
    metric: SessionSyncMetric.MonitoredActivityOutcomeRecorded,
    organizationId: context.organizationId,
    computeTargetId: context.computeTargetId,
    count: total,
    insertedCount: counts[MonitoredActivityOutcome.Inserted],
    replayedCount: counts[MonitoredActivityOutcome.Replayed],
    transportTargetSkippedCount:
      counts[MonitoredActivityOutcome.TransportTargetSkipped],
    targetIntentionallyAbsentCount:
      counts[MonitoredActivityOutcome.TargetIntentionallyAbsent],
    targetRepositoryUnfetchableCount:
      counts[MonitoredActivityOutcome.TargetRepositoryUnfetchable],
    targetRepositoryOutOfScopeCount:
      counts[MonitoredActivityOutcome.TargetRepositoryOutOfScope],
    // ISS-9181 narrowed this to the retry-owned remainder. It used to count
    // every unresolved target, including the ones that could never converge.
    targetRetryRequiredCount:
      counts[MonitoredActivityOutcome.TargetRetryRequired],
    // ISS-9182 breaks that total down without touching it. A held candidate the
    // classifier returned no disposition for is in the total and in none of
    // these four.
    //
    // ISS-11427: so they no longer sum to AT MOST the total, and a naive
    // `total - sum(these four)` can now go negative. A candidate the ceiling
    // resolved keeps its CLASSIFIED member — that is what makes "classified
    // not-materialized, abandoned at the ceiling" readable — while leaving the
    // held total, because it is no longer held. The relation is
    // `sum(these four) <= targetRetryRequiredCount + targetHoldExpiredCount +
    // targetHoldSettledCount`, and the unattributed-hold population is that
    // difference.
    targetRepositoryIdentityUnknownCount:
      counts[MonitoredActivityOutcome.TargetRepositoryIdentityUnknown],
    targetAuthorityConflictCount:
      counts[MonitoredActivityOutcome.TargetAuthorityConflict],
    targetProviderIdentityAmbiguousCount:
      counts[MonitoredActivityOutcome.TargetProviderIdentityAmbiguous],
    targetNotMaterializedCount:
      counts[MonitoredActivityOutcome.TargetNotMaterialized],
    futureRetryRequiredCount:
      counts[MonitoredActivityOutcome.FutureRetryRequired],
    // ISS-11427: how many holds this batch RESOLVED at the ceiling instead of
    // leaving the desktop to exhaust its `ack_omitted` budget. Counts a
    // candidate of its own, so it is outside the ISS-9182 breakdown above.
    targetHoldExpiredCount: counts[MonitoredActivityOutcome.TargetHoldExpired],
    // Held candidates on a target an earlier delivery's ceiling settled. Outside
    // `targetHoldExpiredCount` so the abandonment warn below fires once per target.
    targetHoldSettledCount: counts[MonitoredActivityOutcome.TargetHoldSettled],
  });
  reportAbandonedMonitoredActivityHolds(
    context,
    counts[MonitoredActivityOutcome.TargetHoldExpired]
  );
}

/**
 * ISS-8271 (cr-15119 bha_p0_f0): a session the apply would HOLD is re-sent only
 * through omission from the row-level ack echo. A batch that did not request
 * the echo (`wantsAcceptedSessionIds` absent — a build older than #4862, while
 * the sentinel stamps go back to ISS-4572) acks every sent id on success, so
 * holding would let that desktop durably clear an outbox row the server never
 * wrote: silent loss, strictly worse than the deterministic 400 those builds
 * received before ISS-8271. Reject the whole batch up front instead — nothing
 * has committed yet — restoring their exact previous contract (row retained,
 * bounded validation dead-letter) while opted-in batches keep the hold.
 */
function assertHoldExpressible(
  rowLevelAck: boolean,
  sessions: DesktopAgentSessionsPayload["sessions"]
): void {
  if (rowLevelAck) {
    return;
  }
  for (const session of sessions) {
    if (resolveSessionWireDataRevisionDisposition(session).kind === "skip") {
      throw new HeldRevisionRequiresRowLevelAckError();
    }
  }
}

/**
 * Truthiness-guarded like the status-fold tally: absent reads as "not held".
 *
 * ISS-8781: `foreign_chunk` is a hold reason but NOT a sentinel one, so it is
 * dropped here rather than counted — `SentinelRevisionHeld` is a monitoring
 * contract whose population must not change. The exclusion is enforced by
 * `counts`'s key type, so deleting this guard stops the file compiling rather
 * than quietly widening an existing Datadog query.
 */
function recordHeldRevision(
  counts: Record<SentinelHoldReason, number>,
  reason: SessionHoldReason | null | undefined
): void {
  if (!reason || reason === SessionGateHoldReason.ForeignChunk) {
    return;
  }
  counts[reason] += 1;
}

/**
 * ISS-8271: one `sentinel_revision_held` emission per reason per batch, in the
 * same `finally` as its neighbours so a batch that threw part-way still
 * reports the holds its processed slices decided. Silent when nothing was
 * held, so the metric measures the held population rather than sync traffic.
 */
function emitHeldRevisionCounts(
  context: UpsertSessionsContext,
  counts: Record<SentinelHoldReason, number>
): void {
  for (const [reason, count] of Object.entries(counts)) {
    if (count === 0) {
      continue;
    }
    emitTelemetryMetric({
      metric: SessionSyncMetric.SentinelRevisionHeld,
      organizationId: context.organizationId,
      computeTargetId: context.computeTargetId,
      reason,
      count,
    });
  }
}

/** One session's write slice that threw, and which session it was. */
type SliceFailure = {
  error: unknown;
  externalSessionId: string;
};

/** A poison cohort is a handful of rows; past that, the count describes it. */
const SLICE_FAILURE_LOG_SAMPLE = 5;

/**
 * Report the slices this batch skipped, at the layer that still knows WHICH
 * sessions they were: the handler's failure log names only the compute target,
 * and no longer fires for a partial batch at all.
 *
 * ONE emission per batch, and only once the batch is known to be partial.
 * `payload.sessions` is caller-supplied up to 200 under a 120-request-per-minute
 * limit, so a per-row log and metric would be an authenticated-caller
 * amplification vector (`apps/api/AGENTS.md`, "Emission and Abuse Control").
 */
function reportSliceFailures(
  context: UpsertSessionsContext,
  failures: readonly SliceFailure[]
): void {
  log.error("Desktop agent session slices failed", {
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
    failedSessionCount: failures.length,
    // ISS-8735: the raw error is KEPT — the logger's JSON replacer preserves an
    // Error's name/message/stack — and `field` plus `refusedValue` are LIFTED
    // out beside it. That lift is what makes them reachable at all: the
    // replacer returns only `{name, message, stack}` for an Error, so an own
    // property left on the instance never reaches the log line (review:
    // marisolashgrove). The value is the field an operator actually needs to work
    // out which desktop build emitted it, and the message carries only the
    // column name.
    failures: failures.slice(0, SLICE_FAILURE_LOG_SAMPLE).map((failure) =>
      failure.error instanceof SessionTimestampOutOfRangeError
        ? {
            ...failure,
            field: failure.error.field,
            refusedValue: failure.error.value,
          }
        : failure
    ),
  });
  emitTelemetryMetric({
    metric: SessionSyncMetric.SliceFailed,
    organizationId: context.organizationId,
    count: failures.length,
  });
}

/**
 * Tally one committed slice's unrecorded repositories into the batch's tally,
 * recording the DISTINCT names the cap turned away.
 *
 * The cap admits no new name once the set is full but keeps counting the ones
 * already in it, so truncation loses unseen repositories rather than corrupting
 * the evidence weight of the repositories being written.
 */
function foldObservedRepositories(
  tally: { counts: Map<string, number>; dropped: Set<string> },
  fullNames: readonly string[]
): void {
  for (const fullName of fullNames) {
    const observed = tally.counts.get(fullName);
    if (
      observed === undefined &&
      tally.counts.size >= MAX_OBSERVED_REPOSITORIES_PER_SYNC_REQUEST
    ) {
      tally.dropped.add(fullName);
      continue;
    }
    tally.counts.set(fullName, (observed ?? 0) + 1);
  }
}

/**
 * Write the batch's discovery candidates once, after every slice has committed.
 *
 * Failure is counted and dropped: the sessions are already durable, the candidate is re-derived by the next sync of
 * the same session for free, and letting it propagate would abort a request
 * whose real work has landed.
 *
 * The `recorded` metric fires only after the write succeeds — a count of rows
 * that were not written is worse than no count, because it reads as coverage.
 */
async function flushObservedRepositories(
  context: UpsertSessionsContext,
  input: {
    counts: ReadonlyMap<string, number>;
    dropped: ReadonlySet<string>;
    now: Date;
  }
): Promise<void> {
  if (input.counts.size === 0) {
    return;
  }
  try {
    await recordObservedRepositories({
      organizationId: context.organizationId,
      observations: [...input.counts].map(
        ([repositoryFullName, observedSessionCount]) => ({
          repositoryFullName,
          observedSessionCount,
        })
      ),
      now: input.now,
    });
  } catch (error) {
    log.error("Desktop agent session observed repositories write failed", {
      computeTargetId: context.computeTargetId,
      organizationId: context.organizationId,
      repositoryCount: input.counts.size,
      error: parseError(error),
    });
    emitTelemetryMetric({
      metric: SessionSyncMetric.ObservedRepositoryWriteFailed,
      organizationId: context.organizationId,
      computeTargetId: context.computeTargetId,
      count: 1,
    });
    return;
  }
  emitTelemetryMetric({
    metric: SessionSyncMetric.ObservedRepositoryRecorded,
    organizationId: context.organizationId,
    computeTargetId: context.computeTargetId,
    count: input.counts.size,
    // Never silently truncated: a dropped repository is one this org works in
    // that discovery will not see this pass.
    droppedCount: input.dropped.size,
  });
}

/**
 * ISS-8186: injection seam for the ingest runtime budget's clock.
 *
 * Additive and optional, so every production caller (both transports, and the
 * service object they address) is unchanged. It exists because the budget must
 * be provable without asserting on real elapsed time, which
 * `scripts/lint/rules/no-timing-assertions.ts` forbids — the same seam
 * `drainBranchMaterializationRetries` takes as `readNowMs`.
 */
export type UpsertSessionsBatchOptions = {
  readNowMs?: () => number;
  /**
   * ISS-12552: records an API-key caller's receipt for one
   * session inside that session's own slice transaction, so a slice and its
   * receipt commit or roll back together and the other slices are unaffected.
   */
  recordSessionWrite?: RecordWriteInTransaction<UpsertSessionSliceResult>;
};

/**
 * One session's slice transaction. Unrecorded (no receipt for this request)
 * it is the slice transaction as it shipped before receipts; recorded, the
 * session's receipt joins it, so the two commit or roll back together.
 */
function upsertSliceInShape(
  record: RecordWriteInTransaction<UpsertSessionSliceResult> | undefined,
  slice: Parameters<typeof upsertSessionSlice>[1],
  txOptions: { timeout: number; maxWait: number }
): Promise<UpsertSessionSliceResult> {
  return writeInShape(record, {
    unrecorded: () =>
      withDb.tx((tx) => upsertSessionSlice(tx, slice), txOptions),
    recorded: (recordWrite) =>
      withDb.tx(async (tx) => {
        const written = await upsertSessionSlice(tx, slice);
        await recordWrite(tx, written);
        return written;
      }, txOptions),
  });
}
