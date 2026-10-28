/**
 * @file boot-maintenance.ts
 * @description The desktop store's background boot-maintenance chain, extracted
 * from `openSqliteAgentDatabase` (ISS-5064) to shrink sqlite.ts. One
 * fire-and-forget promise chain of idempotent heal/backfill passes, started
 * right after the Prisma layer is built and deliberately NOT awaited — db open
 * must never block on maintenance.
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
import { repairStrandedComponentTombstones } from "../packs/component-tombstone-repair.js";
import { backfillActivityMetrics } from "./activity-metrics.js";
import { healSweptAgentEndedAt } from "./agent-ended-at-heal.js";
import { requeueBackfilledAuthoritativeCosts } from "./authoritative-cost-resync-heal.js";
import { healUnknownBillingModes } from "./billing-mode-heal.js";
import { requeueTruncatedComponentUsage } from "./component-usage-resync-heal.js";
import { healFallbackCostSourceStamps } from "./cost-source-provenance-heal.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  backfillSessionAnalytics,
  backfillSessionTurnBuckets,
  recomputeHeadlessSessionAnalytics,
  recomputeHeadlessTurnBuckets,
  recomputeImportedAgentTurnAnalytics,
  recomputeLegacyMessageAgentTurnBuckets,
  recomputeLegacySessionAnalyticsCost,
} from "./session-analytics-maintenance.js";
import { healStrandedSubagents } from "./stranded-subagent-heal.js";
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
      // ISS-7762: re-stamp rows a pre-fix build wrote as `genai_prices_v1` when
      // the price actually came from the unknown-model fallback tier. Runs AFTER
      // the cost-rollup sequence so it re-rolls session snapshots those passes
      // have already settled. Touches provenance only, never a cost value.
      // Background; never blocks db open, .catch-isolated.
      .then(() => healFallbackCostSourceStamps(prisma, log))
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
      // ISS-7820: re-derive `session_analytics.est_cost` for the legacy rows
      // migration 0072 copied across verbatim, so an UPGRADED install converges
      // on the widened column's "unknown" instead of keeping the pre-fix
      // confident number forever (the analytics backfill above only covers
      // sessions with NO rollup row, which an upgrade has none of). Runs after
      // the cost-rollup heal sequence so the pricing it reads is already
      // settled. Background; never blocks db open, .catch-isolated.
      .then(() => recomputeLegacySessionAnalyticsCost(prisma, log))
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
      // ISS-8259: re-derive turn buckets for sessions that synced no round-trip
      // series and so have no `agent` bucket, now that the legacy `$.messages`
      // Agent fallback is back. Neither pass above reaches them — the backfill
      // takes only sessions with NO buckets, the headless recompute only headless
      // ones — so without this the parity fix would be inert on an existing
      // install. Runs after both so their rows are settled. Background; never
      // blocks db open, .catch-isolated.
      .then(() => recomputeLegacyMessageAgentTurnBuckets(prisma, log))
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
      // ISS-6906: re-enter uninstalls the PRE-ISS-6881 collector tombstoned into
      // the component-sync keyset lane, which their unadvanced ordering key left
      // permanently behind the durable cursor. Convergent and self-clearing — a
      // repaired row stops matching the predicate — so it costs one indexed read on
      // a device with nothing stranded. Order-independent of every pass above (it
      // reads and writes only `agent_components`); it sits last so an unrelated
      // failure above cannot delay the passes that DO have data dependencies.
      // Background; never blocks db open, .catch-isolated.
      .then(() => repairStrandedComponentTombstones(prisma, log))
      .catch(() => undefined)
      // ISS-7069: advance `agents.ended_at` for agents the PRE-ISS-6893 sweep
      // ended EARLIER than their own last event, and re-queue their sessions so
      // the correction reaches the cloud (the wrong values are already exported).
      // Reimport cannot reach this population — `advanceTerminalEndedAt` touches
      // the MAIN agent only and never re-derives from events — and the live sweep
      // excludes terminal agents by construction. Convergent and self-clearing;
      // see agent-ended-at-heal.ts. Order-independent of every pass above (no
      // rollup derives from `agents.ended_at`), so it sits last for the same
      // reason the tombstone repair does. `now` is read HERE, when the step runs,
      // not when the chain was built. Background; never blocks db open,
      // .catch-isolated.
      .then(() => healSweptAgentEndedAt(prisma, new Date().toISOString(), log))
      .catch(() => undefined)
      // ISS-7474: close subagents the PRE-ISS-6902 terminal hook left at
      // `working` on a session it had already flipped to `error`. No sweep can
      // reach them — `sweepStaleActiveSessions` selects `active` sessions only —
      // so they assert a running subagent to the cloud forever. Convergent and
      // self-clearing; see stranded-subagent-heal.ts. Order-independent of every
      // pass above (it reads and writes only `agents`, plus the sync bump on
      // their sessions), so it sits at the tail of the chain for the same reason
      // the two passes above do. `now` is read HERE, when the step runs, not when
      // the chain was built. Background; never blocks db open, .catch-isolated.
      .then(() => healStrandedSubagents(prisma, new Date().toISOString(), log))
      .catch(() => undefined)
      // ISS-6998: re-queue sessions whose component usage reached the cloud
      // TRUNCATED at MAX_SYNCED_COMPONENT_USAGE, before ISS-6884 made it a
      // paginated stream. Unlike every convergent pass above it selects on a
      // count its own write does not change, so it is gated by the durable
      // `component_usage_resync_seen` marker (migration 0065) rather than by the
      // predicate draining — see component-usage-resync-heal.ts.
      //
      // ORDER IS A DATA DEPENDENCY, not convenience. It counts
      // `agent_component_session_usage`, which is a DERIVED aggregate that
      // `backfillSessionAnalytics` (the head of this chain) deletes and rebuilds
      // from `agent_component_invocations` via
      // `rebuildAgentComponentSessionUsageFromInvocations`. Running this pass
      // before that rebuild would count a stale — or, for a session being
      // re-derived, momentarily EMPTY — aggregate and mark the session as asked
      // for on the strength of it. It must stay after the backfill.
      // Background; never blocks db open, .catch-isolated.
      .then(() => requeueTruncatedComponentUsage(prisma, log))
      .catch(() => undefined)
      // ISS-7229: re-queue sessions whose authoritative cost migration 0074
      // filled locally and never offered to the cloud — it wrote the column
      // without touching `updated_at`, and delivery selects on that cursor. Like
      // the pass above it selects on something its own write does not change
      // (`authoritative_cost_usd IS NOT NULL`), so it is gated by the durable
      // `authoritative_cost_resync_seen` marker (migration
      // 0077_iss7229_authoritative_cost_resync_seen) rather than by
      // the predicate draining — see authoritative-cost-resync-heal.ts.
      //
      // ORDER-INDEPENDENT of every pass above: it reads `authoritative_cost_usd`,
      // which only the OTel rollup writes, and writes `updated_at` plus its own
      // marker table. Nothing in this chain derives from either, so it sits last
      // for the same reason the tombstone repair does — an unrelated failure
      // above must not delay the passes that DO have data dependencies.
      // Background; never blocks db open, .catch-isolated.
      .then(() => requeueBackfilledAuthoritativeCosts(prisma, log))
      .then(() => undefined)
      .catch(() => undefined)
  );
}
