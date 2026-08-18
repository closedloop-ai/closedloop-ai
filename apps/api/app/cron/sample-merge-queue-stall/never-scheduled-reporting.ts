// Turns the never-scheduled derivation into the tick's gauges and operator log
// (ISS-6011).
//
// Split out of `route.ts` because it is a SECOND signal with its own inputs,
// its own unknown rules, and its own metric — the route's job is to run the tick,
// not to own two derivations' reporting. Everything here is decided from read
// results and a clock; the only I/O is the injected job probe.

import {
  type RequiredContextsReadResult,
  RequiredContextsReadStatus,
} from "@repo/github/merge-queue";
import {
  type OpenPullRequestsReadResult,
  OpenPullRequestsReadStatus,
  type QueuedRunsReadResult,
  QueuedRunsReadStatus,
} from "@repo/github/never-scheduled-runs";
import { log } from "@repo/observability/log";
import {
  DatadogMetricType,
  type DatadogSeries,
} from "@repo/observability/telemetry/series";
import {
  deriveNeverScheduledRuns,
  type NeverScheduledSample,
  NeverScheduledStatus,
} from "./derive-never-scheduled";
import { withDeadline } from "./with-deadline";

/**
 * Queued workflow runs on an open PR head that have never scheduled a job. Split
 * into two bounded series by a `blocking:` tag rather than two metric names: the
 * sum answers "how often does this burst", which is the input ISS-6012 turns on,
 * while `blocking:true` alone is what a monitor pages from.
 *
 * OMITTED, not zeroed, on any unknown — same rule as `failed_groups`.
 */
export const NEVER_SCHEDULED_METRIC =
  "symphony.ci.workflow_run.never_scheduled";

export type NeverScheduledInputs = {
  queuedRuns: QueuedRunsReadResult;
  openPullRequests: OpenPullRequestsReadResult;
  required: RequiredContextsReadResult;
  probeScheduledJobs: (runId: number) => Promise<number | null>;
};

/**
 * Bridges every unreadable input into the same "unknown" the derivation already
 * models. A read failure must never reach the gauge as a 0: that would publish a
 * confident "no PR is blocked" over a set that was never seen.
 */
function unknown(reason: string): NeverScheduledSample {
  return { status: NeverScheduledStatus.Unknown, reason, candidates: 0 };
}

/**
 * The one reason a TRUNCATED input is fatal to the tick rather than merely noted.
 *
 * Both pages under-report, so neither can invent a page — but an open PR head
 * this tick never saw makes every stuck run on it fail the head lookup and get
 * classified as closed-PR debris. The tick would then publish a confident
 * `blocking:true = 0` over heads it never read, which is the exact false-healthy
 * `deriveStallSample` already refuses when the queue is deeper than one page.
 */
function truncationReason(inputs: {
  queuedRuns: Extract<QueuedRunsReadResult, { truncated: boolean }>;
  openPullRequests: Extract<OpenPullRequestsReadResult, { truncated: boolean }>;
}): string | null {
  if (inputs.openPullRequests.truncated) {
    return "more open pull requests than one page, so some heads were never read";
  }
  if (inputs.queuedRuns.truncated) {
    return "more queued workflow runs than one page, so some runs were never read";
  }
  return null;
}

export async function resolveNeverScheduled(
  inputs: NeverScheduledInputs,
  now: Date,
  probeBudgetMs: number
): Promise<NeverScheduledSample> {
  if (inputs.queuedRuns.status !== QueuedRunsReadStatus.Ok) {
    return unknown(
      `queued-runs read ${inputs.queuedRuns.status}: ${inputs.queuedRuns.detail}`
    );
  }
  if (inputs.openPullRequests.status !== OpenPullRequestsReadStatus.Ok) {
    return unknown(
      `open-pull-requests read ${inputs.openPullRequests.status}: ${inputs.openPullRequests.detail}`
    );
  }
  // The required set is read LIVE and never hardcoded, for the reason
  // `getRequiredContexts` documents: the ruleset is owned by a separate repo, so
  // a copy here would keep naming a context that is no longer required. An `Ok`
  // but EMPTY set is NOT rejected here — the derivation resolves it per
  // candidate, so an idle tick still reports a truthful zero.
  if (inputs.required.status !== RequiredContextsReadStatus.Ok) {
    return unknown(
      `required-context read ${inputs.required.status}: ${inputs.required.detail}`
    );
  }

  const truncated = truncationReason({
    queuedRuns: inputs.queuedRuns,
    openPullRequests: inputs.openPullRequests,
  });
  if (truncated !== null) {
    return unknown(truncated);
  }

  const sample = await withDeadline(
    deriveNeverScheduledRuns({
      runs: inputs.queuedRuns.runs,
      openPullRequests: inputs.openPullRequests.pullRequests,
      required: inputs.required.contexts,
      now,
      probeScheduledJobs: inputs.probeScheduledJobs,
    }),
    probeBudgetMs,
    () => unknown(`job probes exceeded ${probeBudgetMs}ms`)
  );
  return sample;
}

/**
 * The gauges for one tick's reading, or NOTHING when it is unknown. Two bounded
 * series off one metric; the `blocking` tag is the only dimension, and it can
 * only ever take two values.
 */
export function neverScheduledSeries(
  sample: NeverScheduledSample,
  timestamp: number,
  tags: string[]
): DatadogSeries[] {
  if (sample.status !== NeverScheduledStatus.Ok) {
    return [];
  }
  return [
    { blocking: true, value: sample.blocking.length },
    { blocking: false, value: sample.advisory.length },
  ].map(({ blocking, value }) => ({
    metric: NEVER_SCHEDULED_METRIC,
    type: DatadogMetricType.Gauge,
    points: [{ timestamp, value }],
    tags: [...tags, `blocking:${blocking}`],
  }));
}

/**
 * The operator-facing half. The PR number, run id and unreported contexts ride in
 * the log rather than in tags for the same cardinality reason as the
 * failing-group line — but unlike that one, this is what makes the alert
 * ACTIONABLE, so it names the PR, the runs that never dispatched on it, and the
 * required contexts still waiting.
 */
export function logNeverScheduled(
  sample: NeverScheduledSample,
  logTag: string
): void {
  if (sample.status !== NeverScheduledStatus.Ok) {
    log.warn(
      `${logTag} cannot determine whether a workflow run never scheduled a job`,
      { reason: sample.reason, candidates: sample.candidates }
    );
    return;
  }
  if (sample.blocking.length > 0) {
    log.warn(
      `${logTag} workflow runs never scheduled a job and are blocking open PRs`,
      {
        neverScheduled: sample.blocking.length,
        // A non-zero value makes the count above a lower bound. Logged beside it
        // so a partial tick is not silently read as a complete one.
        unresolved: sample.unresolved,
        runs: sample.blocking,
      }
    );
  }
  if (sample.advisory.length > 0) {
    log.info(`${logTag} workflow runs never scheduled a job, none required`, {
      neverScheduled: sample.advisory.length,
      unresolved: sample.unresolved,
      runs: sample.advisory,
    });
  }
}

/** The paging count, or `null` when this tick could not establish one. */
export function blockingCount(sample: NeverScheduledSample): number | null {
  return sample.status === NeverScheduledStatus.Ok
    ? sample.blocking.length
    : null;
}
