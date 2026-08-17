/**
 * @file sqlite-maintenance-facade.ts
 * @description The MAINTENANCE slice of the `SqliteAgentDatabase` facade —
 * collection-mode diagnostics, data-revision rebuild, session deletion, rollup
 * recompute, repo-identity/historical backfill, the PR-link remediation passes,
 * timestamp normalization, and pack install-run recording.
 *
 * Extracted verbatim from `sqlite.ts` (ISS-5400) to bring that file back under
 * the 1,000 logical-line ceiling. Nearly every method here is a thin delegation
 * to an implementation that already lives in a sibling module (the `…Fn`-aliased
 * imports below) — this move relocates the wrappers, not the logic. The single
 * deviation from a verbatim copy is one added `await`, marked inline below.
 *
 * `createStoreHealthMethods` is spread INSIDE this slice, preserving the exact
 * key ordering the single returned object literal had before the split: a later
 * key still wins over an earlier spread, so the FEA-1999 store-health reads and
 * the pack install-run methods keep their original precedence.
 */
import { staleRebuildSkip } from "../collectors/engine/data-revision.js";
import type { Harness, NormalizedSession } from "../collectors/types.js";
import { runHistoricalBackfill as runHistoricalBackfillFn } from "../enrichment/historical-backfill.js";
import { captureRepoIdentity as captureRepoIdentityFn } from "../enrichment/repo-identity.js";
import {
  type PackInstallRunEndInput,
  type PackInstallRunStartInput,
  recordInstallRunEnd as recordPackInstallRunEndFn,
  recordInstallRunStart as recordPackInstallRunStartFn,
} from "../packs/catalog-store.js";
import {
  type AnalyticsRollupRecomputeResult,
  recomputeAnalyticsRollupsFor,
} from "./analytics-recompute.js";
import { removeUnauthoredBranchPrLinks as removeUnauthoredBranchPrLinksFn } from "./branch-pr-attribution.js";
import { rebuildAgentComponentInvocationsFromStoredRows } from "./component-invocations.js";
import {
  COLLECTION_VIOLATION_SESSION_PREFIX,
  TERMINAL_STATUS_SET,
} from "./db-constants.js";
import { collectionViolationEventId } from "./deterministic-event-id.js";
import {
  correlateCommitShaPrLinks as correlateCommitShaPrLinksFn,
  propagateAllBranchPrLinks as propagateAllBranchPrLinksFn,
} from "./pr-link-maintenance.js";
import type { DesktopPrisma } from "./prisma-client.js";
import type { createSqliteTokenUsageStore } from "./read-stores.js";
import { runRebuildSessionTransaction } from "./rebuild-session-tx.js";
import type { SessionIdentityProvider } from "./session-owner-identity.js";
import type { SqliteAgentDatabase } from "./sqlite-contract.js";
import {
  createStoreHealthMethods,
  type StoreHealthMethods,
} from "./store-health-methods.js";
import { normalizeStoredTimestampFormats as normalizeStoredTimestampFormatsFn } from "./timestamp-format-maintenance.js";
import { WriteQueueClass } from "./write-queue.js";

/**
 * Everything the maintenance slice closes over in `openSqliteAgentDatabase`.
 * Passed as one bag rather than positionally: this is the real dependency
 * surface, and naming it keeps the call site readable.
 */
export type SqliteMaintenanceFacadeDeps = {
  prisma: DesktopPrisma;
  log: (message: string) => void;
  nowFn: () => string;
  detectBillingMode: (harness: string, model?: string | null) => string;
  /** ISS-6168: forwarded to the rebuild's re-INSERT path (see RebuildSessionTxDeps). */
  getUserIdentity?: SessionIdentityProvider;
  supportsRowDigest: () => Promise<boolean>;
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>;
};

/**
 * The maintenance slice, as a value. The return type is ANNOTATED rather than
 * inferred (ISS-5400): a dropped or misspelled key then fails compilation inside
 * this module, where the mistake is, instead of surfacing as a confusing
 * "missing property" on `openSqliteAgentDatabase`'s return several files away.
 */
export function createMaintenanceFacade(
  deps: SqliteMaintenanceFacadeDeps
): Pick<
  SqliteAgentDatabase,
  | "captureRepoIdentity"
  | "correlateCommitShaPrLinks"
  | "deleteSessionRow"
  | "listExistingSessionIds"
  | "listStaleRevisionSessions"
  | "normalizeStoredTimestampFormats"
  | "propagateAllBranchPrLinks"
  | "rebuildComponentInvocationsFromStoredRows"
  | "rebuildSessionFromParse"
  | "recomputeAnalyticsRollups"
  | "recordCollectionModeViolation"
  | "recordPackInstallRunEnd"
  | "recordPackInstallRunStart"
  | "removeUnauthoredBranchPrLinks"
  | "runHistoricalBackfill"
> &
  StoreHealthMethods {
  const {
    prisma,
    log,
    nowFn,
    detectBillingMode,
    getUserIdentity,
    supportsRowDigest,
    tokenUsage,
  } = deps;
  return {
    async recordCollectionModeViolation(
      harness: string,
      externalSessionId: string
    ): Promise<void> {
      if (!(harness && externalSessionId)) {
        return;
      }
      try {
        // Synthetic diagnostic session_id (never a real harness session id): keeps
        // the violation row out of any real session's event stream and out of
        // reach of rebuildSessionFromParse's `DELETE FROM events WHERE session_id
        // = $1`, so the row durably persists once written. The real session id is
        // preserved in the data payload.
        const diagnosticSessionId = `${COLLECTION_VIOLATION_SESSION_PREFIX}${harness}:${externalSessionId}`;
        await prisma.write((client) =>
          client.$executeRawUnsafe(
            "INSERT INTO events (id, session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING",
            collectionViolationEventId(harness, externalSessionId),
            diagnosticSessionId,
            null,
            "mutual_exclusivity_violation",
            null,
            harness,
            JSON.stringify({ harness, externalSessionId }),
            nowFn()
          )
        );
      } catch (error) {
        log(
          `recordCollectionModeViolation failed (harness=${harness}): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    async listExistingSessionIds(): Promise<Set<string>> {
      const rows = await prisma.read((reader) =>
        reader.session.findMany({ select: { id: true } })
      );
      return new Set(rows.map((row) => row.id));
    },
    async listStaleRevisionSessions(
      currentRevision: number
    ): Promise<Array<{ id: string; harness: string | null; status: string }>> {
      // ISS-5400: `await`ed rather than returned bare — the only deviation from a
      // verbatim move, so the extracted method satisfies `useAwait` on its own.
      return await prisma.read((reader) =>
        reader.session.findMany({
          where: { dataRevision: { not: currentRevision } },
          select: { id: true, harness: true, status: true },
        })
      );
    },
    async rebuildSessionFromParse(
      session: NormalizedSession,
      harness: Harness
    ): Promise<{
      rebuilt: boolean;
      activeRace: boolean;
      contentChanged?: boolean;
    }> {
      if (!(session.sessionId && session.startedAt)) {
        return { rebuilt: false, activeRace: false };
      }
      // Resolved before the transaction opens (and cached) so the capability
      // probe can never raise a prepare error inside the rebuild's own tx.
      const hasRowDigest = await supportsRowDigest();
      try {
        // ISS-4710: the DATA_REVISION rebuild re-derives thousands of sessions,
        // one heavy `$transaction` each, all serialized on the single writer.
        // Tag them `bulk` so the write queue's weighted round-robin lets the
        // hot-path transcript/component `interactive` writes interleave and keep
        // uploading during a first-boot rebuild instead of queueing behind it.
        return await prisma.write(
          (client) =>
            client.$transaction((tx) =>
              runRebuildSessionTransaction(tx, {
                session,
                harness,
                hasRowDigest,
                tokenUsage,
                detectBillingMode,
                getUserIdentity,
                log,
                now: nowFn,
              })
            ),
          undefined,
          { class: WriteQueueClass.Bulk }
        );
      } catch (error) {
        log(
          `sqlite rebuildSessionFromParse failed for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
        );
        return { rebuilt: false, activeRace: false };
      }
    },
    async rebuildComponentInvocationsFromStoredRows(
      sessionId: string,
      currentRevision: number
    ): Promise<{
      rebuilt: boolean;
      activeRace: boolean;
      contentChanged?: boolean;
    }> {
      if (!sessionId) {
        return { rebuilt: false, activeRace: false };
      }
      try {
        return await prisma.write((client) =>
          client.$transaction(async (tx) => {
            // The boot-time stale list is advisory — see `staleRebuildSkip`.
            const current = await tx.session.findUnique({
              where: { id: sessionId },
              select: { status: true, dataRevision: true },
            });
            const skip = staleRebuildSkip(current, currentRevision);
            if (skip) {
              return skip;
            }
            const result = await rebuildAgentComponentInvocationsFromStoredRows(
              tx,
              sessionId,
              currentRevision,
              nowFn(),
              log
            );
            return {
              rebuilt: true,
              activeRace: false,
              contentChanged: result.invocationSetChanged,
            };
          })
        );
      } catch (error) {
        log(
          `sqlite rebuildComponentInvocationsFromStoredRows failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
        );
        return { rebuilt: false, activeRace: false };
      }
    },
    async deleteSessionRow(sessionId: string): Promise<void> {
      /* Cloud-side copies of sessions deleted here are removed by FEA-1787's
         phantom-purge script — no local tombstone mechanism exists. */
      await prisma.write((client) =>
        client.$transaction(async (tx) => {
          /*
           * Re-check status inside the transaction: a session that became
           * non-terminal (active, running) between listing and this tx must
           * not be deleted — it heals via ordinary reimport.
           */
          const current = await tx.session.findUnique({
            where: { id: sessionId },
            select: { status: true },
          });
          if (current && !TERMINAL_STATUS_SET.has(current.status)) {
            return;
          }
          await tx.event.deleteMany({ where: { sessionId } });
          // token_events is @@ignore'd (no PK → excluded from the generated
          // client), so it has no typed delegate; delete it raw inside the
          // same transaction.
          await tx.$executeRawUnsafe(
            "DELETE FROM token_events WHERE session_id = $1",
            sessionId
          );
          // FEA-2267: session_activity_segments has no FK cascade (segments are
          // re-derived per import), so purge it explicitly in the same tx —
          // otherwise the activity-timing rows orphan on session deletion.
          await tx.sessionActivitySegment.deleteMany({ where: { sessionId } });
          // FEA-3132: session_turn_bucket has no FK cascade either (buckets are
          // re-materialized per import by rebuildSessionTurnBuckets), so purge it
          // explicitly too — otherwise the turn-count rows orphan on deletion.
          await tx.sessionTurnBucket.deleteMany({ where: { sessionId } });
          await tx.tokenUsage.deleteMany({ where: { sessionId } });
          await tx.codexTraceSpan.deleteMany({ where: { sessionId } });
          // claude_code_* OTel rows. Deleting the SESSION genuinely removes
          // them; only the ISS-4606 re-parse path must leave them alone (an
          // OTel push is not re-derivable from a transcript re-read).
          await tx.claudeCodeCostEvent.deleteMany({ where: { sessionId } });
          await tx.claudeCodePermissionEvent.deleteMany({
            where: { sessionId },
          });
          await tx.claudeCodeApiRequest.deleteMany({ where: { sessionId } });
          // FEA-1899: PR rows are now artifacts; detach via the link table only.
          await tx.sessionArtifactLink.deleteMany({ where: { sessionId } });
          await tx.artifactLinkBackfillSeen.deleteMany({
            where: { sessionId },
          });
          // activity_segment_backfill_seen FK-cascades on the session delete
          // below, but delete it explicitly too, mirroring the sibling marker.
          await tx.activitySegmentBackfillSeen.deleteMany({
            where: { sessionId },
          });
          // FEA-3436: pr_backfill_seen has no FK cascade (session-keyed marker,
          // no relation), so a manual delete here previously orphaned its row
          // until the next retention sweep. Purge it explicitly, matching
          // sweepExpiredSessions. The PR rows themselves are artifacts detached
          // via the link table above (FEA-1899); this only clears the marker.
          await tx.prBackfillSeen.deleteMany({ where: { sessionId } });
          // FEA-2347: the derived analytics rollups have no FK cascade and were
          // previously left for ingest-time rebuild — but a delete with no
          // following reimport (permanent/phantom purge) then orphaned them,
          // inflating any aggregate not joined to `sessions`. Purge all three in
          // the same tx so a delete leaves nothing session-attributable behind;
          // a reimport (DATA_REVISION rebuild) recomputes them regardless.
          await tx.sessionAnalytics.deleteMany({ where: { sessionId } });
          await tx.sessionToolAnalytics.deleteMany({ where: { sessionId } });
          await tx.agentComponentSessionUsage.deleteMany({
            where: { sessionId },
          });
          // FEA-2273: session_activity_metrics is the same no-FK derived-rollup
          // class — purge it so a manual delete leaves no cohort/coverage row to
          // orphan and inflate the aggregate metrics reads.
          await tx.sessionActivityMetrics.deleteMany({ where: { sessionId } });
          // agents cascade via FK on sessions(id) (foreign_keys=ON on the
          // adapter connection — verified), but the explicit child deletes
          // above cover tables without ON DELETE CASCADE.
          await tx.session.deleteMany({ where: { id: sessionId } });
        })
      );
    },
    recomputeAnalyticsRollups(
      sessionIds: string[]
    ): Promise<AnalyticsRollupRecomputeResult> {
      // FEA-3056/FEA-3143 (D6): the memory-bounded chunk+recompute+metrics-refresh
      // body is shared with the FEA-3743 timestamp heal via `recomputeAnalyticsRollupsFor`.
      // FEA-3597: the per-chunk outcome is PROPAGATED, not discarded — the
      // data-revision rebuild gates a `data_revision` stamp on it.
      return recomputeAnalyticsRollupsFor(prisma, sessionIds, nowFn, log);
    },
    async captureRepoIdentity(gitPath: string, cwd: string) {
      const now = nowFn();
      try {
        const result = await captureRepoIdentityFn(gitPath, cwd, prisma, now);
        return { repoFullName: result.repoFullName };
      } catch (error) {
        log(
          `captureRepoIdentity failed for ${cwd}: ${error instanceof Error ? error.message : String(error)}`
        );
        return { repoFullName: null };
      }
    },
    async runHistoricalBackfill(gitPath: string, batchSize: number) {
      const now = nowFn();
      try {
        return await runHistoricalBackfillFn(gitPath, prisma, batchSize, now);
      } catch (error) {
        log(
          `historical backfill failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return 0;
      }
    },
    propagateAllBranchPrLinks(): Promise<number> {
      return propagateAllBranchPrLinksFn(prisma, log);
    },
    correlateCommitShaPrLinks(): Promise<number> {
      return correlateCommitShaPrLinksFn(prisma, log);
    },
    removeUnauthoredBranchPrLinks(): Promise<number> {
      return removeUnauthoredBranchPrLinksFn(prisma, log);
    },
    async normalizeStoredTimestampFormats(): Promise<number> {
      const { rewritten, healedSessionIds } =
        await normalizeStoredTimestampFormatsFn(prisma, log, nowFn);
      // Propagate the healed `sessions.started_at` into the derived, sync-emitted
      // `session_analytics.started_at` copy (see the boot heal for rationale).
      // Best-effort — a recompute failure must not mask the rewrite count.
      await recomputeAnalyticsRollupsFor(
        prisma,
        healedSessionIds,
        nowFn,
        log
      ).catch((e: unknown) => {
        log(
          `normalizeStoredTimestampFormats analytics recompute failed: ${e instanceof Error ? e.message : String(e)}`
        );
      });
      return rewritten;
    },
    ...createStoreHealthMethods(prisma),
    recordPackInstallRunStart(
      input: PackInstallRunStartInput
    ): Promise<number> {
      return recordPackInstallRunStartFn(prisma, input);
    },
    recordPackInstallRunEnd(
      id: number,
      input: PackInstallRunEndInput
    ): Promise<void> {
      return recordPackInstallRunEndFn(prisma, id, input);
    },
  };
}
