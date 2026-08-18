import { getAuthenticatedOctokit } from "@repo/github";
import {
  getMergeQueueState,
  getRequiredContexts,
  type MergeQueueReadResult,
  MergeQueueReadStatus,
  type MergeQueueState,
  type RequiredContextsReadResult,
  RequiredContextsReadStatus,
} from "@repo/github/merge-queue";
import {
  countScheduledJobs,
  listOpenPullRequestHeads,
  listQueuedWorkflowRuns,
  type OpenPullRequestsReadResult,
  OpenPullRequestsReadStatus,
  type QueuedRunsReadResult,
  QueuedRunsReadStatus,
} from "@repo/github/never-scheduled-runs";
import { log } from "@repo/observability/log";
import {
  DatadogMetricType,
  type DatadogSeries,
  SeriesSubmitStatus,
  submitSeries,
} from "@repo/observability/telemetry/series";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush } from "@/lib/route-utils";
import {
  countBuiltUnmergeable,
  deriveFailedGroups,
  deriveStallSample,
  type FailedGroupsSample,
  FailedGroupsStatus,
  StallSampleStatus,
} from "./derive";
import {
  blockingCount,
  logNeverScheduled,
  neverScheduledSeries,
  resolveNeverScheduled,
} from "./never-scheduled-reporting";
import { withDeadline } from "./with-deadline";

/**
 * Sampling cron for merge-queue stall detection (ISS-4450).
 *
 * Reads the live merge queue and publishes:
 *
 *   symphony.ci.merge_queue.group_age_minutes  gauge  — the paging signal
 *   symphony.ci.merge_queue.depth              gauge  — diagnostic
 *   symphony.ci.merge_queue.failed_groups      gauge  — groups red right now
 *   symphony.ci.workflow_run.never_scheduled   gauge  — see below (ISS-6011)
 *   symphony.ci.merge_queue.poll               count  — liveness, tagged outcome
 *
 * ## Why a queue poller also watches PR heads (ISS-6011)
 * The three queue gauges all read merge-group commits, so all three are blind to
 * the failure that happens BEFORE a PR reaches the queue: GitHub creates a
 * workflow run that never schedules a job, posts no check run at all, and branch
 * protection then waits forever on a required context that will never report.
 * ISS-4450 named that as its unclosed limb. The machinery it needs — App auth,
 * the live required-context set, a five-minute cadence, a publish contract that
 * refuses to fabricate a healthy reading — is all already here, so the extension
 * is an extra input set rather than a second cron.
 *
 * ## Why this is a Vercel cron and not a GitHub Actions cron
 * It was one, and the metric was correct, but GitHub delivered that
 * every-10-minutes schedule at a measured p50 of 50.5m and a max of 78.8m. Detection latency
 * then pushed the page past GitHub's own 120m `checkResponseTimeout`, i.e. past
 * the moment the queue unwedges itself — which made it a retrospective monitor
 * wearing a live monitor's name. Vercel's scheduler was measured over the same
 * window at a near-exact 5 minutes, which is what makes a ~95m detection (90m
 * threshold + one tick) fit inside that 120m deadline.
 *
 * ## The contract this route must not break
 * `outcome:ok` means THE GAUGES REACHED DATADOG, not merely that this route
 * ran. The cl-tofu heartbeat keys on `poll{outcome:ok}`, so reporting ok after
 * a failed publish would leave the stall monitor blind while everything looked
 * healthy. Every early return below therefore still publishes an outcome, and
 * none of them publishes a fabricated queue reading.
 *
 * The healthy path sends the gauges and the ok beat as ONE payload. Two
 * requests could half-land — gauges stored, beat dropped — which reads
 * downstream as a dead poller that is in fact working. One request cannot: they
 * land together or not at all, and only the not-at-all case falls through to a
 * second request carrying `outcome:error`.
 *
 * Protected by CRON_SECRET bearer token, as with every other cron route.
 */

/**
 * The route chains several network calls (App installation lookup, token mint,
 * two GraphQL reads, two REST reads, the bounded job probes, then the Datadog
 * submissions). Without an explicit ceiling a hung upstream runs to the platform
 * default and is killed mid-flight, skipping every early return below —
 * including the poll beat they exist to guarantee.
 *
 * Raised from 60 by ISS-6011, which added the job-probe phase: that phase is
 * SEQUENTIAL after the reads (it needs their results to know what to probe), so
 * it lengthens the critical path rather than riding alongside it. Still far under
 * the 5-minute cron cadence, so ticks cannot overlap.
 */
export const maxDuration = 90;

/**
 * The deadline is only real if the work below is actually bounded by it, so the
 * budget is spent explicitly rather than assumed:
 *
 *   auth + installation token mint             5s   AUTH_BUDGET_MS
 *   four reads, ALL CONCURRENT                 10s  GITHUB_READ_BUDGET_MS
 *   bounded job probes                         10s  JOB_PROBE_BUDGET_MS
 *   combined gauges + ok beat                  30.6s seriesWorstCaseMs()
 *   fallback error beat                        10s  seriesWorstCaseMs(0)
 *                                              ----
 *                                              65.6s, inside maxDuration
 *
 * The GitHub read phase is SPLIT from auth rather than sharing one budget with
 * it. Auth precedes the reads, so the two are sequential and a single value
 * applied to both would have doubled the phase. The reads themselves stay
 * concurrent and each carry the same 10s, so ISS-6011 taking the read set from
 * two to four did not lengthen the phase at all.
 *
 * The probe phase is the one addition that DOES lengthen it: what to probe is
 * decided by the reads, so it cannot start until they finish. Each probe carries
 * its OWN deadline (`PER_PROBE_BUDGET_MS`) as well, for the reason the read
 * phase learned the hard way in ISS-5141: the probes are fanned out through a
 * combinator that settles only when ALL of them settle, so one hung probe under a
 * shared deadline alone would discard every answer that had already arrived and
 * collapse the whole sample to unknown. The phase budget stays as the backstop.
 *
 * The fallback beat keeps its zero-retry reservation. At `maxDuration = 90` a
 * second full-retry send would now fit arithmetically, but the point of that send
 * is to be the SMALL one that plausibly succeeds where the full payload failed —
 * so it stays minimal by design rather than by budget pressure.
 */
const AUTH_BUDGET_MS = 5000;
const GITHUB_READ_BUDGET_MS = 10_000;
const JOB_PROBE_BUDGET_MS = 10_000;
/**
 * Half the phase budget, so a single hung probe is reported as one unresolved
 * candidate well inside the backstop instead of consuming the whole phase.
 */
const PER_PROBE_BUDGET_MS = 5000;
/** No retry: this send exists to fit in the time the failing path has left. */
const FALLBACK_BEAT_RETRIES = 0;

const LOG_TAG = "[sample-merge-queue-stall]";
const REPO_OWNER = "closedloop-ai";
const REPO_NAME = "symphony-alpha";
/** The queue is per-branch, and only the default branch has one. */
const BASE_BRANCH = "main";

const AGE_METRIC = "symphony.ci.merge_queue.group_age_minutes";
const DEPTH_METRIC = "symphony.ci.merge_queue.depth";
const POLL_METRIC = "symphony.ci.merge_queue.poll";
/**
 * OMITTED, not zeroed, on any unknown (ISS-5141). A gap in this series is the
 * monitor's cue that the reading is missing; a 0 would be indistinguishable from
 * a healthy queue. Age and depth never depend on it, so the 90-minute paging
 * signal cannot go dark because this secondary read failed.
 */
const FAILED_GROUPS_METRIC = "symphony.ci.merge_queue.failed_groups";

export const PollOutcome = {
  Ok: "ok",
  Error: "error",
} as const;
export type PollOutcome = (typeof PollOutcome)[keyof typeof PollOutcome];

/**
 * No tag carries a PR number. PR numbers are unbounded, so tagging one mints a
 * permanent Datadog timeseries per queue entry — custom-metric cardinality that
 * only ever grows.
 */
const BASE_TAG = `base:${BASE_BRANCH}`;

function pollSeries(outcome: PollOutcome, timestamp: number): DatadogSeries {
  return {
    metric: POLL_METRIC,
    type: DatadogMetricType.Count,
    interval: 1,
    points: [{ timestamp, value: 1 }],
    tags: [`outcome:${outcome}`],
  };
}

/**
 * `extra` carries the never-scheduled gauges onto the early-return paths.
 *
 * They ride WITH the beat rather than in a second request for the same reason
 * the healthy payload packs its own beat: two requests can half-land. And they
 * ride on the ERROR paths at all because that signal is independent of the merge
 * queue — a failed or truncated queue read says nothing about whether a PR head
 * is blocked, so letting it take this reading down would be the coupling the
 * split read budgets above exist to prevent.
 */
async function reportPollOutcome(
  outcome: PollOutcome,
  timestamp: number,
  extra: DatadogSeries[] = []
): Promise<void> {
  await submitSeries([...extra, pollSeries(outcome, timestamp)], LOG_TAG, {
    maxRetries: FALLBACK_BEAT_RETRIES,
  });
}

/**
 * The four reads are independent, so they run CONCURRENTLY — and each carries its
 * own deadline, so none can decide another's outcome.
 */
type GitHubReads = {
  queue: MergeQueueReadResult;
  required: RequiredContextsReadResult;
  queuedRuns: QueuedRunsReadResult;
  openPullRequests: OpenPullRequestsReadResult;
  /**
   * Bound to the authenticated client here rather than handed out as a nullable
   * Octokit, so the "auth failed" case needs no dead null-check downstream: it
   * supplies a probe that reports every run unprobeable, which is exactly what
   * an unauthenticated tick knows.
   */
  probeScheduledJobs: (runId: number) => Promise<number | null>;
};

const UNAVAILABLE_PROBE = () => Promise.resolve(null);

/** Every read reported failed, with one shared cause. */
function allReadsFailed(detail: string): GitHubReads {
  return {
    queue: { status: MergeQueueReadStatus.Failed, detail },
    required: { status: RequiredContextsReadStatus.Failed, detail },
    queuedRuns: { status: QueuedRunsReadStatus.Failed, detail },
    openPullRequests: { status: OpenPullRequestsReadStatus.Failed, detail },
    probeScheduledJobs: UNAVAILABLE_PROBE,
  };
}

/**
 * Minting the App installation token is a network call against GitHub and can
 * fail on its own, so it is classified as a read failure rather than allowed to
 * throw — an unhandled throw here would skip the poll beat entirely and leave
 * the heartbeat unable to tell "poller broken" from "poller never ran".
 *
 * Each read then carries its OWN deadline. A single deadline around
 * `Promise.all` looked equivalent and was not: the combinator settles only when
 * ALL of them settle, so a hang confined to the required-context read — which
 * pages up to `RULES_MAX_PAGES` untimed REST calls — fired the shared deadline
 * and reported the QUEUE read as failed too, discarding a result that may have
 * arrived in 200ms. The route then published no age and no depth, which is
 * precisely the coupling this file's header and `merge-queue.ts` both promise
 * cannot occur.
 *
 * Bounding them separately does not cancel the hung call — `withDeadline` never
 * does — but it stops one read's latency from deciding another's outcome. The
 * wall-clock bound is unchanged: they still run concurrently under the same
 * budget, so the phase is `GITHUB_READ_BUDGET_MS`, not four times it.
 */
async function readGitHub(): Promise<GitHubReads> {
  const timedOut = `GitHub read exceeded ${GITHUB_READ_BUDGET_MS}ms`;

  // Auth stays bounded too. It precedes every read, so leaving it outside a
  // deadline would reopen the hang the budget exists to prevent — the per-read
  // deadlines below can only start counting once this resolves.
  let octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null;
  try {
    octokit = await withDeadline(
      getAuthenticatedOctokit(),
      AUTH_BUDGET_MS,
      () => null
    );
  } catch (error) {
    return allReadsFailed(
      `could not authenticate: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (octokit === null) {
    return allReadsFailed(`authentication exceeded ${AUTH_BUDGET_MS}ms`);
  }

  const client = octokit;
  const [queue, required, queuedRuns, openPullRequests] = await Promise.all([
    withDeadline(
      getMergeQueueState(client, REPO_OWNER, REPO_NAME, BASE_BRANCH),
      GITHUB_READ_BUDGET_MS,
      () => ({ status: MergeQueueReadStatus.Failed, detail: timedOut })
    ),
    withDeadline(
      getRequiredContexts(client, REPO_OWNER, REPO_NAME, BASE_BRANCH),
      GITHUB_READ_BUDGET_MS,
      () => ({ status: RequiredContextsReadStatus.Failed, detail: timedOut })
    ),
    withDeadline(
      listQueuedWorkflowRuns(client, REPO_OWNER, REPO_NAME),
      GITHUB_READ_BUDGET_MS,
      () => ({ status: QueuedRunsReadStatus.Failed, detail: timedOut })
    ),
    withDeadline(
      listOpenPullRequestHeads(client, REPO_OWNER, REPO_NAME),
      GITHUB_READ_BUDGET_MS,
      () => ({ status: OpenPullRequestsReadStatus.Failed, detail: timedOut })
    ),
  ]);
  return {
    queue,
    required,
    queuedRuns,
    openPullRequests,
    // PER PROBE, not per phase. The probes fan out through a combinator that
    // settles only when all of them do, so one hung jobs call under the phase
    // deadline alone would discard every answer that had already arrived. A
    // null is exactly what the derivation counts as one unresolved candidate.
    probeScheduledJobs: (runId) =>
      withDeadline(
        countScheduledJobs(client, REPO_OWNER, REPO_NAME, runId),
        PER_PROBE_BUDGET_MS,
        () => null
      ),
  };
}

/**
 * Bridges an unreadable required set into the same "unknown" the derivation
 * already models, so the route has ONE thing to branch on. A read failure here
 * must never reach the gauge as a 0: that would publish a confident
 * "no group is failing" for a required set that was never seen.
 */
function resolveFailedGroups(
  state: MergeQueueState,
  required: RequiredContextsReadResult
): FailedGroupsSample {
  if (required.status !== RequiredContextsReadStatus.Ok) {
    return {
      status: FailedGroupsStatus.Unknown,
      reason: `required-context read ${required.status}: ${required.detail}`,
      // The QUEUE read succeeded to get here, so the population is known even
      // though no verdict is. Recomputed rather than dropped: this arm never
      // reaches `deriveFailedGroups`, and a null here would be a number we had.
      builtUnmergeable: countBuiltUnmergeable(state),
    };
  }
  return deriveFailedGroups(state, required.contexts);
}

export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, LOG_TAG);
  if (denied) {
    return denied;
  }

  const now = new Date();
  const timestamp = Math.floor(now.getTime() / 1000);

  const reads = await readGitHub();

  // Derived BEFORE the merge-queue early returns below, and published on them,
  // because it does not depend on the queue read at all.
  const neverScheduled = await resolveNeverScheduled(
    reads,
    now,
    JOB_PROBE_BUDGET_MS
  );
  logNeverScheduled(neverScheduled, LOG_TAG);
  const neverScheduledGauges = neverScheduledSeries(neverScheduled, timestamp, [
    BASE_TAG,
  ]);

  const read = reads.queue;
  if (read.status !== MergeQueueReadStatus.Ok) {
    // No queue gauges. A 0 here would be a fabricated healthy reading for a queue
    // we never saw — the one thing this signal must never do.
    log.warn(`${LOG_TAG} could not read the merge queue`, {
      readStatus: read.status,
      detail: read.detail,
    });
    await reportPollOutcome(PollOutcome.Error, timestamp, neverScheduledGauges);
    scheduleLogFlush();
    return new Response(`OK: no sample (${read.status})`, { status: 200 });
  }

  const sample = deriveStallSample(read.state, now);
  if (sample.status === StallSampleStatus.Truncated) {
    log.warn(
      `${LOG_TAG} merge queue is deeper than one page — cannot trust the age max`,
      { depth: sample.depth }
    );
    await reportPollOutcome(PollOutcome.Error, timestamp, neverScheduledGauges);
    scheduleLogFlush();
    return new Response(`OK: no sample (truncated, depth=${sample.depth})`, {
      status: 200,
    });
  }

  const failed = resolveFailedGroups(read.state, reads.required);
  if (failed.status === FailedGroupsStatus.Unknown) {
    log.warn(`${LOG_TAG} cannot determine whether any merge group is failing`, {
      reason: failed.reason,
    });
  } else if (failed.failedGroups > 0) {
    // The detail rides in the log rather than in a metric tag: a PR number is an
    // unbounded tag value, and tagging one would mint a permanent Datadog
    // timeseries per queue entry. The gauge is what alerts; this is what tells
    // whoever it woke which PR and which context to look at.
    log.warn(`${LOG_TAG} merge groups are failing right now`, {
      failedGroups: failed.failedGroups,
      failing: failed.failing,
    });
  }

  // Gauges and the ok beat go together, so the beat cannot claim the sample
  // landed when only half the pair did.
  const submitted = await submitSeries(
    [
      {
        metric: AGE_METRIC,
        type: DatadogMetricType.Gauge,
        points: [{ timestamp, value: sample.groupAgeMinutes }],
        tags: [BASE_TAG],
      },
      {
        metric: DEPTH_METRIC,
        type: DatadogMetricType.Gauge,
        points: [{ timestamp, value: sample.depth }],
        tags: [BASE_TAG],
      },
      // Spread rather than branched around the whole payload: an unknown drops
      // THIS series only, and the age gauge, depth gauge and ok beat still go.
      ...(failed.status === FailedGroupsStatus.Ok
        ? [
            {
              metric: FAILED_GROUPS_METRIC,
              type: DatadogMetricType.Gauge,
              points: [{ timestamp, value: failed.failedGroups }],
              tags: [BASE_TAG],
            },
          ]
        : []),
      ...neverScheduledGauges,
      pollSeries(PollOutcome.Ok, timestamp),
    ],
    LOG_TAG
  );

  const outcome =
    submitted === SeriesSubmitStatus.Ok ? PollOutcome.Ok : PollOutcome.Error;
  if (outcome === PollOutcome.Error) {
    // The combined payload did not land, so nothing yet says this tick ran.
    // A lone beat is small enough to plausibly succeed where the full payload
    // failed, and it is what distinguishes "poller broke" from "poller gone".
    await reportPollOutcome(PollOutcome.Error, timestamp);
  }

  // `null` rather than 0 when unknown, in the log line as in the metric: the two
  // must not tell different stories about the same tick.
  const failedGroups =
    failed.status === FailedGroupsStatus.Ok ? failed.failedGroups : null;

  // Same `null`-when-unknown rule, for the same reason.
  const blockedByNeverScheduled = blockingCount(neverScheduled);

  // Diagnostic only, and deliberately NOT a metric: ISS-5833 stopped counting
  // `UNMERGEABLE` as a failure, which also removed the only trace that such a
  // group existed at all. Logging the tally keeps it countable against
  // `failedGroups` so the change stays falsifiable in production. Same reasoning
  // as the warn line above — a per-entry detail belongs in a log, not in a tag.
  //
  // Reported on BOTH verdicts, unlike `failedGroups` above, because it is read
  // from queue state rather than from contexts — and this line is only reached
  // on a successful queue read. An `Unknown` tick is precisely when someone
  // audits whether the exclusion was justified, so a `null` there would drop the
  // population signal on the tick that needs it most.
  log.info(`${LOG_TAG} Sampling complete`, {
    depth: sample.depth,
    groupAgeMinutes: sample.groupAgeMinutes,
    failedGroups,
    builtUnmergeable: failed.builtUnmergeable,
    blockedByNeverScheduled,
    submitted,
  });

  scheduleLogFlush();
  return new Response(
    `OK: depth=${sample.depth} age=${sample.groupAgeMinutes}m failed=${failedGroups ?? "unknown"} never_scheduled=${blockedByNeverScheduled ?? "unknown"} outcome=${outcome}`,
    { status: 200 }
  );
};
