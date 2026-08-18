/**
 * @file post-boot-maintenance.ts
 * @description ISS-4824 — the post-boot maintenance CHAIN, extracted whole from
 * `agent-dashboard-design-system-runtime.ts` (a file on the shrink-only
 * `noExcessiveLinesPerFile` grandfather list) so that runtime keeps only the thin
 * composition: build this once, then call `runPostBootMaintenance(generation)`.
 *
 * This is one cohesive responsibility, not a mechanical line slice. The passes
 * below form a single ordered pipeline that runs once after the first-launch
 * import settles, every step under the SAME generation/`shouldContinue`
 * cancellation guard: the DATA_REVISION rebuild (plus its sync-outbox
 * hand-off), the artifact-link backfill (plus the PR-attribution post-pass it
 * gates), and the activity-segment re-tiling. Scheduling, the settle/throbber
 * semantics, and the generation counter itself stay in the runtime, which owns
 * the lifecycle.
 *
 * Several dependencies arrive as ACCESSORS rather than values because they are
 * declared after this chain in the runtime (`collectorManager`,
 * `historicalParseRunner`) and are only reachable once maintenance actually runs.
 */

import { MaintenancePhase } from "../../shared/maintenance-progress-contract.js";
import { applyParseSideReport } from "../collectors/engine/collector-manager-pass-resources.js";
import {
  type DataRevisionRebuildSummary,
  runDataRevisionRebuild,
} from "../collectors/engine/data-revision-rebuild.js";
import { mergeDataRevisionRebuildSummaries } from "../collectors/engine/data-revision-rebuild-summary-merge.js";
import type { HistoricalParseRunner } from "../collectors/engine/historical-parse-runner.js";
import { runActivitySegmentBackfillRuntimeBoundary } from "../collectors/parsing/activity-segment-backfill-runtime-boundary.js";
import { runArtifactLinkBackfillRuntimeBoundary } from "../collectors/parsing/artifact-link-backfill-runtime-boundary.js";
import type { HarnessCollector } from "../collectors/types.js";
import { redriveOnDbHostExit } from "../database/db-host/db-host-exit-redrive.js";
import { runSkillShadowInventoryRepairBoundary } from "../database/skill-shadow-inventory-repair-boundary.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";
import { sendToRendererWindow } from "../ipc/renderer-ipc.js";
import { runDataRevisionSyncEnqueueAndFeed } from "./data-revision-sync-enqueue.js";

/**
 * ISS-6241: the phase vocabulary this chain produces lives in
 * `shared/maintenance-progress-contract.ts`, with the payload that carries it,
 * because the renderer validates against it — a phase this chain knows and the
 * renderer's boundary schema does not is the same drift class as a field.
 */
export type PostBootMaintenanceDeps = {
  /** True while `generation` still owns the runtime (not closed, not superseded). */
  isMaintenanceActive: (generation: number) => boolean;
  /** Publish which pass is running, for the Dashboard nav progress banner. */
  setMaintenancePhase: (generation: number, phase: MaintenancePhase) => void;
  /**
   * ISS-6241: publish how far the named phase has drained its own population.
   * Optional so a caller that only wants phase labels (and every test that
   * predates this) needs no extra wiring; the splash then keeps its
   * indeterminate Compute state, which is the honest fallback.
   */
  setMaintenancePhaseProgress?: (
    generation: number,
    phase: typeof MaintenancePhase.Rebuild,
    progress: { processed: number; total: number }
  ) => void;
  agentDatabase: DbHostAgentDatabase;
  getCollectors: () => readonly HarnessCollector[];
  getHistoricalParseRunner: () => HistoricalParseRunner | null;
  invokeStoreOp: (name: string, args?: unknown[]) => Promise<unknown>;
  getWindow: () => Electron.BrowserWindow | null;
  log: (message: string) => void;
  /** ISS-4711 adaptive-pause gate: is the renderer actively being served? */
  hasRecentRendererRead?: () => boolean;
  /** ISS-4823 adaptive-pause gate: is the db host under memory pressure? */
  isDbHostUnderMemoryPressure: () => boolean;
  injectSyncBackfillIds?: (
    ids: readonly string[],
    capturedSourceKey: string | null
  ) => void;
  /** Cooperative pause between main-process maintenance writes. */
  cooperativeDelay: (ms: number) => Promise<void>;
  /** Re-resolved on each read: the compute target can swap mid-rebuild. */
  resolveComputeTargetId: () => string | null;
};

export type PostBootMaintenance = {
  /** Run the whole ordered chain for `generation`. */
  runPostBootMaintenance: (generation: number) => Promise<void>;
};

export function createPostBootMaintenance(
  deps: PostBootMaintenanceDeps
): PostBootMaintenance {
  const runPostBootMaintenance = async (generation: number): Promise<void> => {
    const shouldContinue = () => deps.isMaintenanceActive(generation);
    deps.setMaintenancePhase(generation, MaintenancePhase.Rebuild);
    // ISS-5260: repair the component inventory BEFORE the rebuild, so the
    // sessions this parks are re-derived by the very next pass rather than
    // waiting a boot. It reads the live skill-resolution state each time, which
    // is what makes a skill that resolved AFTER a session was sealed converge —
    // a one-shot revision bump can never select that session again.
    await runSkillShadowInventoryMaintenance(shouldContinue);
    if (!shouldContinue()) {
      return;
    }
    const rebuildCancelled = await runDataRevisionMaintenance(
      shouldContinue,
      generation
    );
    if (rebuildCancelled || !shouldContinue()) {
      return;
    }
    deps.setMaintenancePhase(generation, MaintenancePhase.ArtifactLinks);
    await runArtifactLinkBackfillMaintenance(shouldContinue);
    if (!shouldContinue()) {
      return;
    }
    // FEA-2267: re-derive activity-segment tiling for sessions scanned at an
    // older ACTIVITY_CLASSIFIER_VERSION (or never scanned), under the same
    // generation/shouldContinue cancellation guard.
    await runActivitySegmentBackfillMaintenance(shouldContinue);
  };

  /**
   * ISS-5260: delete phantom `(command, /X)` inventory rows a resolved
   * `(skill, X)` shadows, and park the sessions holding their invocations so the
   * rebuild immediately following re-points them.
   *
   * Runs in the db host as a `store:` op — its `prisma.write` callbacks can't
   * cross the method proxy — the same route the two backfills below take.
   * Best-effort: the pass swallows its own failures and reports zero repairs, so
   * a bad boot costs one more boot with the phantom present rather than blocking
   * the chain behind it.
   */
  const runSkillShadowInventoryMaintenance = async (
    shouldContinue: () => boolean
  ): Promise<void> => {
    const repair = await runSkillShadowInventoryRepairBoundary({
      invokeStoreOp: deps.invokeStoreOp,
      log: deps.log,
    });
    if (!shouldContinue()) {
      return;
    }
    if (repair.deletedComponents > 0) {
      // The Commands tab reads `agent_components` directly, so a deleted
      // phantom is invisible to the renderer until it re-reads. The parked
      // sessions are handled by the rebuild's own invalidation.
      sendToRendererWindow(deps.getWindow(), "desktop:db:changed", {});
    }
  };

  // Returns true only when cancellation should block subsequent maintenance.
  const runDataRevisionMaintenance = async (
    shouldContinue: () => boolean,
    generation: number
  ): Promise<boolean> => {
    // ISS-5808 (codex review): every attempt reports its summary here, INCLUDING
    // one abandoned mid-drain by a db-host exit. A session `rebuildSessionFromParse`
    // committed just before the child died is stamped at the current revision, so
    // the re-driven attempt rightly excludes it — and when it was the last stale
    // row, the final attempt's summary is empty. Treating that empty summary as
    // authoritative dropped the committed change out of the sync-outbox enqueue and
    // skipped `invalidateHistoricalDetails()`, leaving the dashboard serving
    // pre-rebuild rows for work that HAD landed. The merge below is what makes the
    // committed results survive the re-drive.
    const attemptSummaries: DataRevisionRebuildSummary[] = [];
    const failure = await captureDataRevisionRebuildFailure(
      shouldContinue,
      attemptSummaries,
      generation
    );
    if (!shouldContinue()) {
      return true;
    }
    // The ONE committed result no summary can name: the op that was in flight
    // when the child died may have COMMITTED and merely lost its response, in
    // which case `applyRebuild` never counted it and the re-driven attempt finds
    // it already stamped. We cannot enqueue a session id we do not know — the
    // incremental `updated_at` watermark scan (`incremental-cursor-feed.ts`)
    // still carries that row to the cloud, because a rebuild that changed the
    // payload bumped exactly that column — but we CAN stop serving stale rows
    // for it. An attempt that was abandoned (a re-drive happened, or the bound
    // was exhausted) is sufficient evidence to drop the caches; over-dropping
    // costs one re-read, under-dropping is the pre-rebuild numbers staying on
    // screen.
    const abandonedAttempt = attemptSummaries.length > 1 || failure !== null;
    const cancelled = await applyDataRevisionRebuildResults(
      mergeDataRevisionRebuildSummaries(attemptSummaries),
      abandonedAttempt,
      shouldContinue
    );
    if (failure) {
      deps.log(
        `data-revision rebuild failed: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`
      );
    }
    return cancelled;
  };

  /**
   * Run the (re-driven) rebuild and hand back what it finally threw, boxed so a
   * falsy thrown value still reads as a failure, or `null` when it completed.
   *
   * Separated from the result hand-off so a failure can no longer skip it: the
   * committed rows are applied either way, and the failure is still reported —
   * an exhausted re-drive must never read as a completed pass.
   */
  const captureDataRevisionRebuildFailure = async (
    shouldContinue: () => boolean,
    attemptSummaries: DataRevisionRebuildSummary[],
    generation: number
  ): Promise<{ error: unknown } | null> => {
    try {
      // ISS-5808: `data-revision rebuild failed: db-host exited (code: 0)` was
      // logged and then discarded — the chain read the `false` below as "not
      // cancelled, keep going", advanced to the next phase, and left the
      // pre-rebuild rows served (no invalidation ran) with nothing re-attempting
      // until the next boot. This is the pass behind the "Building your history
      // timeline → Compute → Rebuild history timeline" step, so the user saw it
      // stop and had no way to tell stopped from slow.
      //
      // Re-drive it against the replacement child instead. The rebuild is
      // cursored on the DATA_REVISION stamp, so a re-run RESUMES rather than
      // re-walking the corpus, which is what makes this safe to repeat. Bounded
      // by attempt count; an exhausted re-drive still reaches the catch below and
      // still reports the failure — it must never read as a completed pass.
      await redriveOnDbHostExit(
        () => {
          // ISS-6241 (wongk review): every attempt starts from NO count.
          // `redriveOnDbHostExit` can call this more than once, and the counts
          // belong to ONE attempt's population: if the host dies after the last
          // write commits, the replacement attempt finds zero stale rows and
          // returns before it ever builds a reporter, so nothing would overwrite
          // the abandoned attempt's "99 of 100" and the splash would keep
          // rendering a position no live pass can substantiate. Re-publishing
          // the phase drops the counts and leaves the step honestly
          // indeterminate until an attempt reports its own population.
          deps.setMaintenancePhase(generation, MaintenancePhase.Rebuild);
          return runDataRevisionRebuild({
            collectors: deps.getCollectors(),
            db: deps.agentDatabase,
            log: deps.log,
            shouldContinue,
            cooperativeDelay: deps.cooperativeDelay,
            // ISS-4711: keep the full per-write cooperative pause only while the
            // renderer is actively reading; the idle fast path drops the flat
            // 50ms/session floor so a multi-thousand-session rebuild finishes in
            // minutes.
            hasRecentRendererRead: deps.hasRecentRendererRead,
            // ISS-4823: the gate's OTHER arm, now actually wired. The db host
            // publishes its memory-pressure level to main (heap watchdog →
            // DbHostResponseKind.MemoryPressure) and this reads the cached value.
            // It is NOT redundant with the db host's own throttling: that applies to
            // the two HEAVY_STORE_OPS backfills (heavy-op-gate pre-admission +
            // `yieldDbHostLoopUnderMemoryPressure`), whereas `rebuildSessionFromParse`
            // reaches the writer through the generic invoke dispatch, which takes
            // neither. Without this the rebuild ran its whole serial drain on the 0ms
            // idle fast path even while the db host was at its RSS high-water.
            isDbHostUnderMemoryPressure: () =>
              deps.isDbHostUnderMemoryPressure(),
            useStoredComponentInvocationRebuild: true,
            // ISS-5808: the committed-work carry. Fires on EVERY exit path of
            // every attempt, including the one the db-host exit abandoned.
            reportSummary: (attempt) => {
              attemptSummaries.push(attempt);
            },
            // ISS-6241: the Compute step's real denominator. Reported against
            // the "rebuild" phase specifically, so a report that lands after the
            // chain has advanced is dropped rather than mislabelled as progress
            // through the artifact-link backfill, which measures nothing.
            reportProgress: (progress) => {
              deps.setMaintenancePhaseProgress?.(
                generation,
                MaintenancePhase.Rebuild,
                progress
              );
            },
            // ISS-5266: the rebuild re-reads sources through the SAME worker, so it
            // sees the same side-report — and must apply it through the same courier
            // rather than discarding it. The rebuild never seals a fingerprint, so
            // nothing here can freeze a false zero; routing it anyway keeps the
            // record current after a rebuild instead of leaving the verdict of
            // the last import pass standing for a store the rebuild has just
            // re-read.
            parseSource: async (collector, source) => {
              const runner = deps.getHistoricalParseRunner();
              if (!runner) {
                return collector.parse(source);
              }
              const result = await runner.parseSource(collector.key, source);
              await applyParseSideReport(collector, result);
              return result.sessions;
            },
          });
        },
        { label: "data-revision rebuild", log: deps.log }
      );
    } catch (e: unknown) {
      return { error: e };
    }
    return null;
  };

  /**
   * Hand the reconciled summary to the two consumers that must see committed
   * work: the durable sync outbox and the renderer cache invalidation.
   *
   * ISS-5808: this runs even when the re-drive ultimately FAILED, because rows
   * committed by an earlier attempt are already stamped at the current revision
   * and no later rebuild will ever select them again — skipping the hand-off
   * would strand them permanently, not merely defer them. Its own failures are
   * logged rather than thrown: with the db host gone these calls can reject too,
   * and that must not take out the rest of the maintenance chain.
   *
   * Returns true only when cancellation should block subsequent maintenance.
   */
  const applyDataRevisionRebuildResults = async (
    summary: DataRevisionRebuildSummary,
    abandonedAttempt: boolean,
    shouldContinue: () => boolean
  ): Promise<boolean> => {
    try {
      // FEA-3659 / ISS-4447 / ISS-4493 / ISS-4546: explicitly enqueue the rebuild's
      // changed sessions into the durable sync outbox under the compute target
      // CAPTURED once here, and (only if this generation was not cancelled while
      // that enqueue was awaited) feed the confirmed ids into the live backfill
      // queue so they drain THIS session under the captured identity. The whole
      // hand-off lives in `runDataRevisionSyncEnqueueAndFeed` (which owns the
      // target-swap no-strand, the post-await cancellation re-check, and the
      // identity-matched inject) so this grandfathered runtime keeps only the thin
      // call.
      const capturedComputeTargetId = deps.resolveComputeTargetId();
      await runDataRevisionSyncEnqueueAndFeed({
        changedSessionIds: summary.changedSessionIds,
        capturedComputeTargetId,
        enqueueOutboxEntries:
          deps.agentDatabase.syncSource?.enqueueOutboxEntries,
        resolveLiveComputeTargetId: () => deps.resolveComputeTargetId(),
        injectSyncBackfillIds: deps.injectSyncBackfillIds,
        shouldContinue,
        log: deps.log,
      });
      if (!shouldContinue()) {
        return true;
      }
      if (
        summary.rebuilt > 0 ||
        summary.deleted > 0 ||
        summary.missingSourceRollupsRecomputed > 0 ||
        // ISS-5808 (codex review): see `abandonedAttempt` at the call site — an
        // abandoned attempt's in-flight write may have committed without ever
        // being counted, so the caches must be dropped on its behalf.
        abandonedAttempt
      ) {
        // The rebuild mutates rows outside the hook/import emit paths —
        // drop the cached historical list and nudge the renderer or the
        // dashboard keeps serving pre-rebuild numbers. (FEA-2641: the
        // missing-source rollup recompute mutates session_analytics the same
        // out-of-band way.)
        // ISS-5071: `missingSourceRollupsRecomputed` is the PRIMARY
        // session_analytics commit count, deliberately independent of whether
        // the recompute's secondary metrics refresh failed — a metrics-only
        // failure still rewrote analytics rows, so invalidation must fire even
        // though that same recompute withheld the data_revision stamp.
        deps.agentDatabase.sessions.invalidateHistoricalDetails();
        sendToRendererWindow(deps.getWindow(), "desktop:db:changed", {});
      }
    } catch (e: unknown) {
      if (!shouldContinue()) {
        return true;
      }
      deps.log(
        `data-revision rebuild result hand-off failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return false;
  };

  const runPostBackfillMaintenance = async (
    shouldContinue: () => boolean
  ): Promise<void> => {
    // Runs in the DB host via clone-safe methods; their `prisma.write` callbacks
    // can't cross the method proxy from here. See database/pr-link-maintenance.ts
    // and database/branch-pr-attribution.ts.
    // FEA-4377: drop stale branch→PR links minted before the authoring-evidence
    // gate BEFORE re-propagating, so an upgraded install stops falsely
    // attributing a workspace-only session to a PR.
    const unauthoredRemoved =
      await deps.agentDatabase.removeUnauthoredBranchPrLinks();
    if (!shouldContinue()) {
      return;
    }
    const linked = await deps.agentDatabase.propagateAllBranchPrLinks();
    if (!shouldContinue()) {
      return;
    }
    // FEA-4379: attribute out-of-band-created PRs to the authoring session by
    // matching the session's authored commit SHAs against PR head/merge SHAs.
    const correlated = await deps.agentDatabase.correlateCommitShaPrLinks();
    if (!shouldContinue()) {
      return;
    }
    if (unauthoredRemoved > 0 || linked > 0 || correlated > 0) {
      sendToRendererWindow(deps.getWindow(), "desktop:db:changed", {});
    }
  };

  const runArtifactLinkBackfillMaintenance = async (
    shouldContinue: () => boolean
  ): Promise<void> => {
    try {
      await runArtifactLinkBackfillRuntimeBoundary({
        invokeStoreOp: deps.invokeStoreOp,
        shouldContinue,
        getWindow: deps.getWindow,
      });
    } catch (e: unknown) {
      if (!shouldContinue()) {
        return;
      }
      deps.log(
        `artifact-link backfill failed: ${e instanceof Error ? e.message : String(e)}`
      );
      return;
    }
    if (!shouldContinue()) {
      return;
    }
    await runPostBackfillMaintenance(shouldContinue);
  };

  const runActivitySegmentBackfillMaintenance = async (
    shouldContinue: () => boolean
  ): Promise<void> => {
    try {
      await runActivitySegmentBackfillRuntimeBoundary({
        invokeStoreOp: deps.invokeStoreOp,
        shouldContinue,
        getWindow: deps.getWindow,
      });
    } catch (e: unknown) {
      if (!shouldContinue()) {
        return;
      }
      deps.log(
        `activity-segment backfill failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  };

  return { runPostBootMaintenance };
}
