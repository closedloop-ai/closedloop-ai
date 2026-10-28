import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import {
  countQueuedCommandsByTarget,
  countTargetsAwaitingSweep,
  listQueueDepthSweepPage,
  markQueueDepthSwept,
  reconcileQueuedCounters,
} from "@/lib/desktop-command-dispatch-queries";
import { scheduleLogFlush } from "@/lib/route-utils";
import {
  MAX_RECONCILED_TARGETS_PER_TICK,
  MAX_SAMPLED_TARGETS,
  publishQueueDepths,
  reportCounterDrift,
} from "./queue-depth-publisher";

const ROUTE_TAG = "[sample-command-queue-depth]";

/**
 * Publishes `queued_command_count` for every compute target on a schedule,
 * rather than off a relay socket.
 *
 * ISS-8453: the gauge's only prior call paths — the hello handshake
 * (`hello-handler.ts`) and the presence sampler (`fleet-capacity-sampler.ts`)
 * — both require a live relay socket, so a target holding a backlog with no
 * connected desktop published no queue depth at all. That gap holds whichever
 * account of the 2026-08-28 incident turns out to be right; whether it is what
 * happened there is open under ISS-8634, and this does not settle it.
 *
 * The gauge is the diagnostic half. The alerting half is
 * `command.queue.backlog_exceeded`, emitted from `queue-depth-publisher.ts`,
 * which is a log line and so does not wait on the metric-pipeline rules
 * FEA-3314 still owns. `command.queue.counter_drift` is the second such line
 * and needs its own monitor before it can page anyone.
 *
 * ISS-8674 made the tick's database work a constant and its coverage complete.
 * Two bounded reads, unioned: the deepest backlogs, so a deep queue's alerting
 * latency stays at one tick however large the fleet grows; and the
 * least-recently-swept page, so no target is permanently omitted by the cap.
 * Whatever the tick gauges is stamped, which is what advances that rotation.
 *
 * Deliberately observes rather than bounds. Capping a backlog means refusing or
 * discarding a user's command, which is a product decision and not one an
 * observability gap justifies making here.
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, ROUTE_TAG);
  if (denied) {
    return denied;
  }

  try {
    // Taken before the reads so a target gauged by THIS tick is never counted
    // as still owing a sweep. Reading it after would race the stamp below and
    // under-report what remains.
    const cycleStart = new Date();
    const [backlogPage, sweepPage] = await Promise.all([
      countQueuedCommandsByTarget(MAX_SAMPLED_TARGETS),
      listQueueDepthSweepPage(MAX_SAMPLED_TARGETS),
    ]);
    const summary = publishQueueDepths(backlogPage, sweepPage);

    await markQueueDepthSwept(summary.sweptTargetIds, cycleStart);

    // Reconciled from the sweep page's head, which is the least-recently-swept
    // end, so the sample advances with the rotation instead of re-checking the
    // same targets forever.
    const reconciledSample = sweepPage.slice(
      0,
      MAX_RECONCILED_TARGETS_PER_TICK
    );
    const drift = reportCounterDrift(
      await reconcileQueuedCounters(
        reconciledSample.map((target) => target.computeTargetId)
      )
    );

    const targetsAwaitingSweep = await countTargetsAwaitingSweep(cycleStart);
    const runSummary = {
      targetsSampled: summary.gaugedTargetIds.length,
      targetsWithBacklog: summary.targetsWithBacklog,
      exceededCount: summary.exceededCount,
      warnsSuppressed: summary.warnsSuppressed,
      deepestBacklog: summary.deepestBacklog,
      backlogPageTruncated: summary.backlogPageTruncated,
      sweepDeferred: summary.sweepDeferred,
      targetsAwaitingSweep,
      targetsReconciled: drift.targetsReconciled,
      driftedTargetCount: drift.drifted.length,
    };

    log.info(`${ROUTE_TAG} sampling complete`, runSummary);
    scheduleLogFlush();

    return new Response(
      `OK: sampled ${runSummary.targetsSampled} targets, ${runSummary.targetsWithBacklog} with a backlog, ${runSummary.exceededCount} over threshold, deepest ${runSummary.deepestBacklog}, ${targetsAwaitingSweep} awaiting sweep, ${runSummary.driftedTargetCount} drifted of ${runSummary.targetsReconciled} reconciled`,
      { status: 200 }
    );
  } catch (error) {
    // The 500 trips Vercel's cron failure alerting but does not say WHICH read
    // broke. Without this line a sampler built to end a blind spot can itself
    // go dark for an unnamed reason.
    log.error(`${ROUTE_TAG} sampling failed`, { error });
    scheduleLogFlush();
    return new Response("sample-command-queue-depth failed", { status: 500 });
  }
};
