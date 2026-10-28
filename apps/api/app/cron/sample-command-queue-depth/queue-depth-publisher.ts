/**
 * The pure half of the queue-depth sampler: gauge emission, the backlog warn,
 * and the per-tick bound. Co-located with its route rather than living in it —
 * `apps/api/AGENTS.md` reserves `route.ts` for the HTTP boundary (auth, the
 * reads, the response, error handling) and keeps type definitions and pure
 * helpers out of it.
 */

import { log } from "@repo/observability/log";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitQueueMetric } from "@repo/observability/telemetry/metrics";
import { ORIGIN } from "@repo/observability/telemetry/origin";
import type {
  CounterReconciliation,
  TargetBacklog,
  TargetBacklogPage,
} from "@/lib/desktop-command-dispatch-queries";

/**
 * Above this depth a target's backlog is reported as a warn, not just a gauge.
 *
 * A starting value, not a measured one: no fleet-wide baseline for normal queue
 * depth exists yet, because until this cron nothing sampled a target with no
 * live socket. It is set below the earliest depth ISS-8453 recorded (43,
 * already climbing when first observed) and ten times the only ceiling the
 * fleet declares today — `MAX_IN_FLIGHT_COMMANDS = 2`, a hardcoded constant in
 * `apps/desktop/src/main/app.ts`, not a per-target setting. Tune it from the
 * distribution this cron publishes rather than from a second guess.
 */
export const COMMAND_BACKLOG_WARN_THRESHOLD = 20;

/**
 * A fleet-wide stall puts every target over the threshold at once, which is
 * exactly when the warn channel must not become the outage. The deepest
 * backlogs are the actionable ones, so they are the ones named; the rest are
 * counted on the summary line rather than dropped silently.
 */
const MAX_BACKLOG_WARNS_PER_TICK = 10;

/**
 * Upper bound on what the sampler EMITS per tick — metric points, log lines,
 * and the rows either read returns — so its emission stays bounded as the fleet
 * grows.
 *
 * It is a DEFERRAL, not a discard (ISS-8674). Targets are swept
 * least-recently-gauged first and stamped when gauged, so a fleet larger than
 * this cap is covered across `ceil(fleet / cap)` ticks instead of having its
 * tail dropped forever. `targetsAwaitingSweep` on the run's summary says how
 * much of the current cycle is still owed, so a partial tick can never read as
 * a complete one.
 *
 * Registering a compute target costs an authenticated user nothing but a
 * distinct machine name — there is no durable per-account quota — so the target
 * count is not a fleet-size constant, and an unbounded per-target loop on a
 * five-minute cron is work one account can inflate permanently.
 *
 * It also bounds the DATABASE's work, because no read here grows with the
 * backlog or the fleet. `countQueuedCommandsByTarget` visits exactly
 * `limit + 1` entries of `compute_targets_queued_depth_idx` and
 * `listQueueDepthSweepPage` exactly `limit` of
 * `compute_targets_queued_depth_sweep_idx`, each index carrying its whole
 * `where` in its predicate. Before ISS-8674 the backlog read aggregated every
 * queued row and the cap only discarded the losing groups, so the sampler was
 * slowest under exactly the runaway queue it exists to report.
 *
 * The budget is spent on the deepest backlogs BEFORE the rotation, so what a
 * bound tick defers is a shallow or empty queue, never the deep one an operator
 * is trying to see. Disconnected-target coverage — the blind spot ISS-8453
 * exists to close — is unaffected either way: a target holding a backlog is
 * gauged whether or not it has a socket.
 */
export const MAX_SAMPLED_TARGETS = 500;

/**
 * How many targets a tick reconciles against their real queued rows.
 *
 * SMALL ON PURPOSE, and the only constant here whose cost is not per-row-read.
 * Reconciliation counts a target's actual queued rows, so a tick costs the sum
 * of these targets' backlogs — the very aggregate the counter exists to avoid.
 * Bounding it to a constant slice of the rotation keeps that cost at
 * `this x deepest backlog` while still covering the whole fleet over time,
 * because the slice is taken from the least-recently-swept end and therefore
 * advances with it.
 *
 * 10 against the fleet's 5-minute cadence reconciles 2,880 target-checks a day,
 * so a fleet of any plausible size is covered many times over — drift is a
 * "has the trigger stopped firing" alarm, not a per-tick invariant.
 */
export const MAX_RECONCILED_TARGETS_PER_TICK = 10;

/**
 * Gauge slots a tick reserves for the rotation, whatever the backlog page holds.
 *
 * WITHOUT THIS THE ROTATION STARVES, and it starves during the exact incident
 * this cron exists to observe. The union emits the deepest backlogs first; if
 * `MAX_SAMPLED_TARGETS` targets hold a backlog at once — a fleet-wide stall, the
 * condition ISS-8673 and ISS-8686 make routine — the backlog page fills the
 * whole budget, no rotation entry is ever reached, and the rest of the fleet is
 * permanently omitted again. That is the defect this ticket exists to end, so
 * the deepest-first preference is a preference and not a claim on the entire
 * budget.
 *
 * The reservation bounds a full sweep at `ceil(fleet / this)` ticks even with
 * every target backlogged: 100 slots on a five-minute cadence covers a
 * 5,000-target fleet in under four hours, against never. The deep backlogs give
 * up nothing that matters — they keep 400 slots, and
 * `command.queue.backlog_exceeded`, the alerting half, is derived from the
 * backlog page itself rather than from what the budget let through.
 */
export const MIN_ROTATION_SLOTS_PER_TICK = 100;

type QueueDepthSummary = {
  /** The targets this tick published a point for — never more than the cap. */
  gaugedTargetIds: string[];
  /** The rotation targets it gauged, which are the ones whose key it advances. */
  sweptTargetIds: string[];
  /**
   * Targets with a backlog that this tick actually gauged, which is a floor on
   * the fleet's total whenever `backlogPageTruncated` is set — the backlog read
   * is capped, so past the cap it cannot know how many more there are.
   */
  targetsWithBacklog: number;
  exceededCount: number;
  warnsSuppressed: number;
  deepestBacklog: number;
  /**
   * More targets hold a backlog than the deepest-first page could return.
   *
   * Sourced from that read's own probe row, never from a page being exactly
   * full: a full page is what a fleet of exactly that size returns too, and
   * inferring truncation from its length reports a completely covered fleet as
   * partial. The ones past the cap are not lost — the sweep reaches them on a
   * later tick — so this bounds the DEPTH RANKING this tick could see, not the
   * fleet's coverage, which `targetsAwaitingSweep` reports instead.
   */
  backlogPageTruncated: boolean;
  /** The per-tick budget bound before the sweep page was exhausted. */
  sweepDeferred: boolean;
};

/**
 * Emits a gauge point per gauged target and warns for the deepest backlogs.
 *
 * Every point is a MEASURED depth. Before ISS-8674 the caller passed a list of
 * ids and this filled in a zero for anything absent from the backlog page —
 * which was a false zero for any target whose backlog the backlog page's own
 * cap had dropped. Both inputs now carry the target's real count, so a zero
 * here means the counter says zero.
 *
 * The two reads overlap on purpose and are unioned deepest-first. The backlog
 * page keeps a deep queue's alerting latency at one tick however large the
 * fleet grows; the sweep page guarantees every target is reached. Neither is
 * allowed to exceed `MAX_SAMPLED_TARGETS` between them.
 */
export function publishQueueDepths(
  backlogPage: TargetBacklogPage,
  sweepPage: TargetBacklog[]
): QueueDepthSummary {
  const backlogs = backlogPage.backlogs;
  const gauged = new Set<string>();
  let sweepDeferred = false;

  // Backlogs first, but never with the whole budget: what the cap defers is
  // then a shallow or empty queue rather than the deep one an operator is
  // trying to see, WITHOUT letting a fleet-wide stall crowd the rotation out
  // entirely and re-create the permanent omission.
  const prioritized = backlogs.slice(
    0,
    MAX_SAMPLED_TARGETS - MIN_ROTATION_SLOTS_PER_TICK
  );
  for (const target of [...prioritized, ...sweepPage]) {
    if (gauged.has(target.computeTargetId)) {
      continue;
    }
    if (gauged.size >= MAX_SAMPLED_TARGETS) {
      sweepDeferred = true;
      break;
    }
    emitDepth(target.computeTargetId, target.queuedCount);
    gauged.add(target.computeTargetId);
  }

  const exceeded = backlogs
    .filter((backlog) => backlog.queuedCount >= COMMAND_BACKLOG_WARN_THRESHOLD)
    .sort((a, b) => b.queuedCount - a.queuedCount);

  for (const backlog of exceeded.slice(0, MAX_BACKLOG_WARNS_PER_TICK)) {
    log.warn("command.queue.backlog_exceeded", {
      computeTargetId: backlog.computeTargetId,
      queuedCommandCount: backlog.queuedCount,
      threshold: COMMAND_BACKLOG_WARN_THRESHOLD,
    });
  }

  return {
    gaugedTargetIds: [...gauged],
    // Only the ROTATION's own targets are stamped. Stamping a target because
    // the backlog page named it would keep every deep backlog permanently
    // fresh, pinning it at the rotation's tail — so it would never come up for
    // the reconciliation sample, and the counters most likely to be lying are
    // the ones that would never be checked.
    sweptTargetIds: sweepPage
      .map((target) => target.computeTargetId)
      .filter((id) => gauged.has(id)),
    targetsWithBacklog: backlogs.length,
    backlogPageTruncated: backlogPage.hasMore,
    sweepDeferred,
    exceededCount: exceeded.length,
    warnsSuppressed: Math.max(0, exceeded.length - MAX_BACKLOG_WARNS_PER_TICK),
    // Deepest overall, not deepest over threshold: a fleet sitting just under
    // the warn line is exactly what this number exists to make visible.
    deepestBacklog: backlogs.reduce(
      (deepest, backlog) => Math.max(deepest, backlog.queuedCount),
      0
    ),
  };
}

/**
 * Reports every target whose counter disagrees with its real queued rows.
 *
 * Takes rows that carry BOTH numbers, because they must come from ONE database
 * snapshot. Comparing a counter read earlier in the tick against a row count
 * read later makes every command enqueued or acked in between look like drift —
 * a warn that names a healthy target, on the busiest targets, which is how a
 * detector gets ignored. `reconcileQueuedCounters` reads the pair in a single
 * statement so the two can never be a round trip apart.
 *
 * Detection only. It deliberately does NOT repair: the counter is written by a
 * trigger in the same transaction as every command write, so a mismatch means
 * that guarantee has stopped holding — and silently rewriting the number would
 * hide a recurring cause behind a self-heal that looks like health. The
 * one-statement repair is in migration
 * 20260901120000_iss8674_queued_command_count for an operator to run once the
 * cause is known.
 *
 * Warns per drifted target rather than in aggregate, because the actionable
 * unit is the target: an operator needs to know WHICH gauge has been lying.
 * Bounded by the caller's sample, which is why this cannot become the fleet
 * scan it exists to keep the sampler away from.
 */
export function reportCounterDrift(
  reconciliations: CounterReconciliation[]
): CounterDriftSummary {
  const drifted = reconciliations.filter(
    (row) => row.counter !== row.actualQueuedRows
  );

  for (const row of drifted) {
    log.warn("command.queue.counter_drift", {
      computeTargetId: row.computeTargetId,
      queuedCommandCount: row.counter,
      actualQueuedRows: row.actualQueuedRows,
      delta: row.counter - row.actualQueuedRows,
    });
  }

  return { targetsReconciled: reconciliations.length, drifted };
}

function emitDepth(computeTargetId: string, value: number): void {
  emitQueueMetric({
    metric: "queued_command_count",
    value,
    computeTargetId,
    origin: ORIGIN,
    filterToken: FilterToken.CommandQueued,
  });
}

/** What the bounded reconciliation checked, and what it found. */
export type CounterDriftSummary = {
  targetsReconciled: number;
  drifted: CounterReconciliation[];
};
