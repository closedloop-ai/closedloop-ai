/**
 * @file boot-maintenance.ts
 * @description The desktop store's background boot-maintenance chain, extracted
 * from `openSqliteAgentDatabase` (ISS-5064) to shrink the grandfathered
 * sqlite.ts. One fire-and-forget promise chain of idempotent heal/backfill
 * passes, started right after the Prisma layer is built and deliberately NOT
 * awaited — db open must never block on maintenance.
 *
 * Two properties of the chain are load-bearing and must survive any edit:
 *  - **Order.** Several passes read what an earlier pass writes (the comments at
 *    each step name the dependency). Do not reorder without re-reading them.
 *  - **`.catch(() => undefined)` between every step.** Each pass is isolated, so
 *    one transient failure degrades that pass only and never skips the rest of
 *    the chain. A pass that throws must not take the boot chain down with it.
 *
 * `sqlite.ts` keeps the returned promise as `bootMaintenance` and exposes it via
 * `whenBootMaintenanceSettled()`, which tests await so the background sweeps do
 * not race their fixtures.
 *
 * Pure LEAF: imports only the pass modules, never sqlite.js — so sqlite.ts
 * imports FROM here one-directionally and there is no cycle.
 */

import { repairPollutedRepoFullNames } from "../enrichment/repo-fullname-repair.js";
import { backfillActivityMetrics } from "./activity-metrics.js";
import { healUnknownBillingModes } from "./billing-mode-heal.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  backfillSessionAnalytics,
  backfillSessionTurnBuckets,
  recomputeHeadlessSessionAnalytics,
  recomputeHeadlessTurnBuckets,
  recomputeImportedAgentTurnAnalytics,
} from "./session-analytics-maintenance.js";
import { runCostRollupHealPasses } from "./token-cost-maintenance.js";

/**
 * Start the background boot-maintenance chain. Returns the settle promise; the
 * caller keeps it (never awaits it inline) so db open stays non-blocking.
 */
export function startBootMaintenance(
  prisma: DesktopPrisma,
  log: (message: string) => void
): Promise<void> {
  // FEA-2038: populate analytics rollups for any pre-existing sessions (upgrades
  // to 0004, or sessions imported before the rollup existed), in the background
  // so it never blocks db open. Runs on the caller's Prisma client.
  //
  // The whole chain is fire-and-forget so db open never blocks on maintenance,
  // but the caller keeps the returned promise as `bootMaintenance` and exposes
  // it via `whenBootMaintenanceSettled()` so callers (notably tests) that seed rows the
  // background passes also touch — e.g. the FEA-2866 `repairPollutedRepoFullNames`
  // sweep, which resolves/nulls bare `artifacts.repo_full_name` values — can await
  // it and avoid racing the sweep against their own fixtures.
  return (
    backfillSessionAnalytics(prisma, log)
      // Run the re-pricing pass once the backfill has SETTLED (resolved or
      // rejected) — it is an independent pass, so a transient backfill failure
      // must not skip it. `.catch` before `.then` decouples them while still
      // ordering re-pricing after the backfill, so any freshly created rollups are
      // repriced in the same boot.
      .catch(() => undefined)
      // The cost-rollup heal sequence (reprice → cache split → event
      // conservation → TTL-premium rollup). Order is a data dependency and is
      // owned by the helper; see runCostRollupHealPasses. Background; never
      // blocks db open.
      .then(() => runCostRollupHealPasses(prisma, log))
      .catch(() => undefined)
      // FEA-2870: re-derive the analytics rollup for headless/autonomous sessions
      // that a pre-fix rollup marked human-steered, so the autonomy trend + heatmap
      // heal for existing data. Background; never blocks db open, .catch-isolated.
      .then(() => recomputeHeadlessSessionAnalytics(prisma, log))
      .catch(() => undefined)
      // FEA-3226: re-derive the analytics rollup for imported sessions whose
      // agent_turns was frozen at 0 by the pre-fix event-name heuristic, so the
      // dashboard turn counts heal for existing data without a DATA_REVISION
      // re-import. Background; never blocks db open, .catch-isolated.
      .then(() => recomputeImportedAgentTurnAnalytics(prisma, log))
      .catch(() => undefined)
      // ISS-4869: re-queue sessions frozen at an `unknown` billing mode past the
      // durable sync cursor. Convergent; see billing-mode-heal.ts for the why.
      .then(() => healUnknownBillingModes(prisma, log))
      .catch(() => undefined)
      // FEA-3132: one-time backfill of session_turn_bucket for the pre-existing
      // corpus so the Insights autonomy trend + activity heatmap read the
      // materialized table for old sessions too. Now json_each-FREE
      // (rebuildSessionTurnBuckets parses metadata in JS), so it no longer SIGTRAPs
      // the @libsql layer on large sessions. Runs after the headless recompute so
      // metadata classification is settled. Background; never blocks db open.
      .then(() => backfillSessionTurnBuckets(prisma, log))
      .catch(() => undefined)
      // FEA-3266 (FEA-3616 follow-up): re-derive turn buckets for headless
      // sessions that kept a stale `human` bucket because they sit below the
      // is_human threshold (single human turn) and so were skipped by the
      // recomputeHeadlessSessionAnalytics self-heal above. Runs after the backfill
      // so newly-created buckets are settled. Background; never blocks db open,
      // .catch-isolated.
      .then(() => recomputeHeadlessTurnBuckets(prisma, log))
      .catch(() => undefined)
      // FEA-2866: repair artifact rows whose repo_full_name is a bare cwd basename
      // (worktree/temp/plain-folder name) the parser recorded before the write
      // path was hardened — resolve to a validated owner/repo or null the junk, so
      // the repo breakdowns stop surfacing non-repositories. Background; never
      // blocks db open, and its .catch keeps a failure from affecting the caller.
      .then(() => repairPollutedRepoFullNames(prisma, log))
      .catch(() => undefined)
      // FEA-2273: populate the activity-attribution metrics rollup for any
      // pre-existing session that has segments + an analytics rollup but no metrics
      // row (installs upgrading past this migration, or sessions imported before the
      // emission wiring existed). Runs after the analytics/turn-bucket backfills so
      // the cohort source rows it reads are settled. Background; never blocks db
      // open, .catch-isolated.
      .then(() => backfillActivityMetrics(prisma, log))
      .catch(() => undefined)
  );
}
