// Derives the "workflow run that never scheduled a job" signal (ISS-6011).
//
// The third derivation in this cron, and the first that looks past the merge
// queue. `deriveStallSample` and `deriveFailedGroups` both read merge-group
// commits, so both are blind to a PR that never REACHES the queue — which is
// where engineers actually hit this. ISS-4450 named it as its unclosed limb:
//
//   "A never-dispatched check emits nothing at all. GitHub's queue waits
//    indefinitely for a check that will never report."
//
// ## Why the open-PR-head filter is the load-bearing part
//
// GitHub never reaps a run that never started, so `status=queued` is dominated by
// permanent debris: on 2026-08-12 all 35 currently-queued runs had zero scheduled
// jobs and none belonged to an open PR, dating to bursts on 2026-07-25 and
// 2026-08-06. A gauge over that set would sit at a constant 35 and alert on
// nothing. Intersecting against live open PR heads is what turns the population
// into "runs that are blocking somebody right now".
//
// ## Why a job probe, and not age alone
//
// A run held `queued` past the threshold WITH jobs is a starved or
// concurrency-gated run — a real wait, but one that resolves itself and has a
// different remedy. Zero scheduled jobs is what says nothing will ever report.
//
// ## What "blocking" does and does NOT attribute
//
// Blocking is a property of the PR HEAD, reported against each stuck run sitting
// on it — NOT a claim that this particular run owns the missing context. It
// cannot be: a run with zero jobs posted no check run, so there is nothing on it
// to read an owned context off, and mapping a workflow to the job names it would
// have produced means parsing its YAML at that SHA. Two stuck runs on one head
// therefore carry the same verdict and the same context list, which is the
// honest reading — the PR is blocked, and these are the runs that never
// dispatched on it.

import type { RequiredContext } from "@repo/github/merge-queue";
import type {
  OpenPullRequestHead,
  QueuedWorkflowRun,
} from "@repo/github/never-scheduled-runs";
import { unreportedRequiredContexts } from "@repo/github/required-context-attempts";
import { MS_PER_MINUTE, roundMinutes } from "./derive";

/**
 * Comfortably above the `PR Tests` p90 of 16.0 minutes, so a merely slow queue
 * cannot reach it (ISS-6011).
 */
export const NEVER_SCHEDULED_THRESHOLD_MINUTES = 20;

/**
 * Caps the job probes one tick will issue. Each probe is a round trip inside the
 * tick's `JOB_PROBE_BUDGET_MS` phase, and the candidate set is driven by GitHub's
 * own behavior rather than by anything this repo controls — a 27-run burst is on
 * record. Runs past the cap are counted as unresolved rather than dropped, so the
 * ceiling shows up as a lower bound instead of as a quiet zero.
 */
export const MAX_JOB_PROBES = 20;

export const NeverScheduledStatus = {
  Ok: "ok",
  /**
   * No run was confirmed BLOCKING and at least one candidate could not be
   * judged — its probe failed, it was past the probe cap, it carried no start
   * time, or the required set was empty so nothing could be intersected against.
   * Emitted rather than a 0 for the same reason `FailedGroupsStatus.Unknown` is:
   * a 0 there could be hiding a blocked PR, and a confident false-healthy is
   * worse than no reading.
   */
  Unknown: "unknown",
} as const;
export type NeverScheduledStatus =
  (typeof NeverScheduledStatus)[keyof typeof NeverScheduledStatus];

export type NeverScheduledRun = {
  runId: number;
  workflow: string;
  headBranch: string | null;
  headSha: string;
  /** Always known: a run with no open PR head is never flagged. */
  pullRequest: number;
  ageMinutes: number;
  /**
   * Required contexts with nothing reported against this PR HEAD — a property of
   * the PR, not of this run (see the attribution note in the file header).
   * Non-empty is what makes the run BLOCKING: a stuck run on a head where every
   * required context has already reported is holding nothing up.
   */
  unreportedRequiredContexts: string[];
};

export type NeverScheduledSample =
  | {
      status: typeof NeverScheduledStatus.Ok;
      /** Stuck, on a head missing a required context. The paging set. */
      blocking: NeverScheduledRun[];
      /** Stuck, but every required context on the head has reported. */
      advisory: NeverScheduledRun[];
      /**
       * Candidates whose verdict could not be established. Non-zero makes both
       * counts a LOWER BOUND — they are still published, because a confirmed
       * blocking run elsewhere does not stop being a fact. Surfaced on the tick
       * log so a partial reading is distinguishable from a complete one.
       */
      unresolved: number;
    }
  | {
      status: typeof NeverScheduledStatus.Unknown;
      reason: string;
      /**
       * How many runs reached the probe stage. Carried on THIS arm too so an
       * Unknown tick still says how big the population was — otherwise "nothing
       * could be judged" and "there was nothing to judge" look identical in the
       * logs, and only one of them is worth waking up for.
       */
      candidates: number;
    };

/**
 * Minutes since the run started, or NULL when that cannot be established.
 *
 * Null is not "young". A run whose start time is missing or unparseable is
 * unjudgeable, and treating it as young would silently exempt exactly the run
 * whose metadata is already odd.
 */
function ageMinutes(run: QueuedWorkflowRun, now: Date): number | null {
  if (run.runStartedAt === null) {
    return null;
  }
  const started = Date.parse(run.runStartedAt);
  if (Number.isNaN(started)) {
    return null;
  }
  // Clamped for the same reason `deriveStallSample` clamps: the clock is read
  // before the API call, so a run started in that window is "newer than now".
  return Math.max(0, (now.getTime() - started) / MS_PER_MINUTE);
}

type Candidate = {
  run: QueuedWorkflowRun;
  pullRequest: OpenPullRequestHead;
  ageMinutes: number;
};

/**
 * Runs old enough to judge, on a head that is still an open PR's, OLDEST FIRST.
 *
 * Both filters are cheap and are applied BEFORE any probe, which keeps the probe
 * count proportional to real candidates rather than to the debris pile. The sort
 * is what makes `MAX_JOB_PROBES` safe: GitHub returns runs newest-first, so
 * slicing the head of that order would spend every probe on the youngest
 * candidates and push the longest-stuck — the ones actually holding a PR — into
 * the unresolved bucket.
 */
function selectCandidates(
  runs: readonly QueuedWorkflowRun[],
  openPullRequests: readonly OpenPullRequestHead[],
  now: Date,
  thresholdMinutes: number
): { candidates: Candidate[]; unjudgeableAge: number } {
  const bySha = new Map<string, OpenPullRequestHead>();
  for (const pullRequest of openPullRequests) {
    // First wins. Two open PRs can share a head SHA (a retarget, or a branch
    // opened twice), and either answer names a genuinely blocked PR.
    if (!bySha.has(pullRequest.headSha)) {
      bySha.set(pullRequest.headSha, pullRequest);
    }
  }

  const candidates: Candidate[] = [];
  let unjudgeableAge = 0;
  for (const run of runs) {
    const pullRequest = bySha.get(run.headSha);
    if (!pullRequest) {
      // Debris: the run is stuck, but its PR is gone, so nothing is blocked.
      continue;
    }
    const age = ageMinutes(run, now);
    if (age === null) {
      unjudgeableAge++;
      continue;
    }
    if (age < thresholdMinutes) {
      continue;
    }
    candidates.push({ run, pullRequest, ageMinutes: age });
  }
  candidates.sort((left, right) => right.ageMinutes - left.ageMinutes);
  return { candidates, unjudgeableAge };
}

function toNeverScheduledRun(
  candidate: Candidate,
  unreported: string[]
): NeverScheduledRun {
  return {
    runId: candidate.run.id,
    workflow: candidate.run.workflow,
    headBranch: candidate.run.headBranch,
    headSha: candidate.run.headSha,
    pullRequest: candidate.pullRequest.number,
    ageMinutes: roundMinutes(candidate.ageMinutes),
    unreportedRequiredContexts: unreported,
  };
}

function unresolvedReason(counts: {
  unjudgeableAge: number;
  unprobed: number;
  overCap: number;
  unjudgeableSet: number;
}): string {
  const clauses: string[] = [];
  if (counts.unjudgeableAge > 0) {
    clauses.push(
      `${counts.unjudgeableAge} queued run(s) carried no usable start time`
    );
  }
  if (counts.unprobed > 0) {
    clauses.push(
      `${counts.unprobed} candidate run(s) could not be probed for jobs`
    );
  }
  if (counts.overCap > 0) {
    clauses.push(
      `${counts.overCap} candidate run(s) exceeded the ${MAX_JOB_PROBES}-probe cap`
    );
  }
  if (counts.unjudgeableSet > 0) {
    clauses.push(
      `${counts.unjudgeableSet} never-scheduled run(s) could not be judged because the required-context set is empty`
    );
  }
  return `${clauses.join("; ")}, and no run was confirmed blocking`;
}

/**
 * Flags queued workflow runs on open PR heads that have never scheduled a job.
 *
 * `probeScheduledJobs` is injected rather than called directly so the decision
 * below can be executed end to end against synthetic runs, with no network and
 * no Octokit — the probe is the only I/O in the whole derivation. The caller is
 * responsible for bounding each probe; a probe that cannot answer returns null.
 */
export async function deriveNeverScheduledRuns(input: {
  runs: readonly QueuedWorkflowRun[];
  openPullRequests: readonly OpenPullRequestHead[];
  required: readonly RequiredContext[];
  now: Date;
  probeScheduledJobs: (runId: number) => Promise<number | null>;
  thresholdMinutes?: number;
}): Promise<NeverScheduledSample> {
  const { candidates, unjudgeableAge } = selectCandidates(
    input.runs,
    input.openPullRequests,
    input.now,
    input.thresholdMinutes ?? NEVER_SCHEDULED_THRESHOLD_MINUTES
  );

  // An empty required set is NOT an early return, matching `deriveFailedGroups`:
  // uncertainty is PER CANDIDATE, so a tick with no stuck run at all still
  // reports a truthful 0 rather than going dark on a set it never needed.
  const contextVerdictsKnown = input.required.length > 0;

  const probed = candidates.slice(0, MAX_JOB_PROBES);
  const overCap = candidates.length - probed.length;
  const jobCounts = await Promise.all(
    probed.map((candidate) => input.probeScheduledJobs(candidate.run.id))
  );

  const blocking: NeverScheduledRun[] = [];
  const advisory: NeverScheduledRun[] = [];
  let unprobed = 0;
  let unjudgeableSet = 0;

  for (const [index, candidate] of probed.entries()) {
    const jobs = jobCounts[index];
    if (typeof jobs !== "number") {
      unprobed++;
      continue;
    }
    if (jobs > 0) {
      // Scheduled, just waiting. Starved or concurrency-gated, not stuck.
      continue;
    }
    if (!contextVerdictsKnown) {
      // Confirmed never-scheduled, but with nothing to intersect against there
      // is no way to say whether it holds a required context. Unresolved, not
      // advisory — an absence of evidence is not evidence of absence.
      unjudgeableSet++;
      continue;
    }
    const unreported = unreportedRequiredContexts(
      candidate.pullRequest.rollupContexts,
      input.required
    );
    const run = toNeverScheduledRun(candidate, unreported);
    if (unreported.length > 0) {
      blocking.push(run);
    } else {
      advisory.push(run);
    }
  }

  const unresolved = unjudgeableAge + unprobed + overCap + unjudgeableSet;

  // Gated on the PAGING set alone, matching `deriveFailedGroups`. An advisory
  // finding is a different series and says nothing about whether the unresolved
  // candidates were blocking, so letting one suppress Unknown would publish a
  // confident `blocking:true = 0` over runs that were never judged.
  if (unresolved > 0 && blocking.length === 0) {
    return {
      status: NeverScheduledStatus.Unknown,
      reason: unresolvedReason({
        unjudgeableAge,
        unprobed,
        overCap,
        unjudgeableSet,
      }),
      candidates: candidates.length,
    };
  }

  return { status: NeverScheduledStatus.Ok, blocking, advisory, unresolved };
}
