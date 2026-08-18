// Executes the never-scheduled decision itself (ISS-6011), against synthetic
// runs and a synthetic probe. Every case drives `deriveNeverScheduledRuns` and
// asserts the classification it returns — none of them inspects source or
// asserts that a predicate exists somewhere.
//
// Rollup nodes and the required set come from the shared fixtures, so this suite
// and the failed-groups suite cannot disagree about what a required context is.
import type { RequiredContext } from "@repo/github/merge-queue";
import type {
  OpenPullRequestHead,
  QueuedWorkflowRun,
} from "@repo/github/never-scheduled-runs";
import { describe, expect, it, vi } from "vitest";
import {
  deriveNeverScheduledRuns,
  MAX_JOB_PROBES,
  NEVER_SCHEDULED_THRESHOLD_MINUTES,
  type NeverScheduledSample,
  NeverScheduledStatus,
} from "./derive-never-scheduled";
import {
  checkRun,
  IMPOSTOR_INTEGRATION_ID,
  NOW,
  REQUIRED_CHECK_NAME,
  REQUIRED_CONTEXTS,
  REQUIRED_STATUS_NAME,
  statusContext,
} from "./merge-queue-entry-fixtures";

const HEAD_SHA = "a".repeat(40);
const CLOSED_PR_SHA = "b".repeat(40);
const BRANCH = "fix/iss-5333-gridtable-header-align";
const PR_NUMBER = 4711;
const RUN_ID = 31_121_510_116;
const MS_PER_MINUTE = 60_000;

/** Both required contexts reported by the apps that actually own them. */
const FULLY_REPORTED = [
  checkRun(REQUIRED_CHECK_NAME),
  statusContext(REQUIRED_STATUS_NAME),
];

function run(
  minutesOld: number | null,
  overrides: Partial<QueuedWorkflowRun> = {}
): QueuedWorkflowRun {
  return {
    id: RUN_ID,
    workflow: "PR Tests",
    headSha: HEAD_SHA,
    headBranch: BRANCH,
    runStartedAt:
      minutesOld === null
        ? null
        : new Date(NOW.getTime() - minutesOld * MS_PER_MINUTE).toISOString(),
    ...overrides,
  };
}

function head(
  overrides: Partial<OpenPullRequestHead> = {}
): OpenPullRequestHead {
  return {
    number: PR_NUMBER,
    headSha: HEAD_SHA,
    headBranch: BRANCH,
    // Read by the readiness sweep (ISS-6018), not by this derivation — carried
    // here only because the head shape is shared.
    baseBranch: "main",
    isDraft: false,
    mergeable: "MERGEABLE",
    rollupTruncated: false,
    comments: [],
    // Null is "this page was the whole connection", not "unknown" — the read
    // always sets it, so the fixture must too.
    commentsCursor: null,
    // Nothing reported: a never-scheduled run posts no check run at all, which
    // is the whole mechanism.
    rollupContexts: [],
    ...overrides,
  };
}

/** A probe that always answers with the same job count. */
function probing(jobs: number | null) {
  return vi.fn().mockResolvedValue(jobs);
}

function derive(input: {
  runs: QueuedWorkflowRun[];
  openPullRequests?: OpenPullRequestHead[];
  required?: RequiredContext[];
  probeScheduledJobs: (runId: number) => Promise<number | null>;
}): Promise<NeverScheduledSample> {
  return deriveNeverScheduledRuns({
    runs: input.runs,
    openPullRequests: input.openPullRequests ?? [head()],
    required: input.required ?? REQUIRED_CONTEXTS,
    now: NOW,
    probeScheduledJobs: input.probeScheduledJobs,
  });
}

async function okSample(input: Parameters<typeof derive>[0]) {
  const sample = await derive(input);
  if (sample.status !== NeverScheduledStatus.Ok) {
    throw new Error(`expected an Ok sample, got ${sample.status}`);
  }
  return sample;
}

async function unknownSample(input: Parameters<typeof derive>[0]) {
  const sample = await derive(input);
  if (sample.status !== NeverScheduledStatus.Unknown) {
    throw new Error(`expected an Unknown sample, got ${sample.status}`);
  }
  return sample;
}

describe("deriveNeverScheduledRuns", () => {
  it("flags an old queued run with zero jobs and names the PR it blocks", async () => {
    const sample = await okSample({
      runs: [run(45)],
      probeScheduledJobs: probing(0),
    });

    expect(sample.blocking).toEqual([
      {
        runId: RUN_ID,
        workflow: "PR Tests",
        headBranch: BRANCH,
        headSha: HEAD_SHA,
        pullRequest: PR_NUMBER,
        ageMinutes: 45,
        unreportedRequiredContexts: [REQUIRED_CHECK_NAME, REQUIRED_STATUS_NAME],
      },
    ]);
    expect(sample.unresolved).toBe(0);
  });

  it("does not flag a run younger than the threshold, and never probes it", async () => {
    // The probe assertion is the point: a young run must cost no round trip, so
    // a burst of freshly-created runs cannot blow the tick's probe budget.
    const probeScheduledJobs = probing(0);

    const sample = await okSample({
      runs: [run(NEVER_SCHEDULED_THRESHOLD_MINUTES - 1)],
      probeScheduledJobs,
    });

    expect(sample.blocking).toEqual([]);
    expect(sample.advisory).toEqual([]);
    expect(probeScheduledJobs).not.toHaveBeenCalled();
  });

  it("flags at exactly the threshold, so the boundary is not off by one", async () => {
    const sample = await okSample({
      runs: [run(NEVER_SCHEDULED_THRESHOLD_MINUTES)],
      probeScheduledJobs: probing(0),
    });

    expect(sample.blocking).toHaveLength(1);
  });

  it("does not flag an old run that HAS scheduled jobs", async () => {
    // Starved or concurrency-gated, not never-dispatched. It will report
    // eventually, so it is a different failure with a different remedy.
    const sample = await okSample({
      runs: [run(180)],
      probeScheduledJobs: probing(4),
    });

    expect(sample.blocking).toEqual([]);
    expect(sample.advisory).toEqual([]);
    expect(sample.unresolved).toBe(0);
  });

  it("does not flag an old zero-job run whose SHA is no longer a PR head", async () => {
    // The dominant real-world case: all 35 queued zero-job runs on 2026-08-12
    // belonged to branches whose PRs had closed. Without this filter the gauge
    // would sit at a constant 35 and alert on nothing.
    const probeScheduledJobs = probing(0);

    const sample = await okSample({
      runs: [run(4000, { headSha: CLOSED_PR_SHA })],
      probeScheduledJobs,
    });

    expect(sample.blocking).toEqual([]);
    expect(sample.advisory).toEqual([]);
    expect(sample.unresolved).toBe(0);
    expect(probeScheduledJobs).not.toHaveBeenCalled();
  });

  it("counts a stuck run on a fully-reported head as advisory, not blocking", async () => {
    const sample = await okSample({
      runs: [run(45)],
      openPullRequests: [head({ rollupContexts: FULLY_REPORTED })],
      probeScheduledJobs: probing(0),
    });

    expect(sample.blocking).toEqual([]);
    expect(sample.advisory).toHaveLength(1);
    expect(sample.advisory[0]?.unreportedRequiredContexts).toEqual([]);
  });

  it("does not let an impostor app's check stand in for the required one", async () => {
    // A required context is `{name, integration}`. A check run named `typecheck`
    // from an unrelated app must NOT make the required `typecheck` look
    // reported — that would downgrade a genuinely blocked PR to advisory, which
    // is the false-healthy direction on the paging series.
    const sample = await okSample({
      runs: [run(45)],
      openPullRequests: [
        head({
          rollupContexts: [
            checkRun(REQUIRED_CHECK_NAME, {
              integrationId: IMPOSTOR_INTEGRATION_ID,
            }),
            statusContext(REQUIRED_STATUS_NAME),
          ],
        }),
      ],
      probeScheduledJobs: probing(0),
    });

    expect(sample.blocking[0]?.unreportedRequiredContexts).toEqual([
      REQUIRED_CHECK_NAME,
    ]);
  });

  it("treats a RED required check as reported, not as never-scheduled", async () => {
    // A workflow that ran and failed is a different problem with a different
    // owner. This signal is only about the one that never ran at all.
    const sample = await okSample({
      runs: [run(45)],
      openPullRequests: [
        head({
          rollupContexts: [
            checkRun(REQUIRED_CHECK_NAME, { conclusion: "FAILURE" }),
            statusContext(REQUIRED_STATUS_NAME),
          ],
        }),
      ],
      probeScheduledJobs: probing(0),
    });

    expect(sample.blocking).toEqual([]);
    expect(sample.advisory).toHaveLength(1);
  });

  it("reads the required set from its input rather than any hardcoded list", async () => {
    // Fails if the derivation ever grows its own copy of `main`'s contexts: the
    // ruleset is owned by a separate repo with no CI to catch a stale copy.
    const sample = await okSample({
      runs: [run(45)],
      openPullRequests: [head({ rollupContexts: FULLY_REPORTED })],
      required: [{ context: "custom-gate", integrationId: null }],
      probeScheduledJobs: probing(0),
    });

    expect(sample.blocking[0]?.unreportedRequiredContexts).toEqual([
      "custom-gate",
    ]);
  });

  it("reports Unknown, not zero, when the only candidate could not be probed", async () => {
    // A failed probe is not evidence of zero jobs. Publishing 0 here would be a
    // confident "no PR is blocked" over a run we never read.
    const sample = await unknownSample({
      runs: [run(45)],
      probeScheduledJobs: probing(null),
    });

    expect(sample.reason).toContain("could not be probed");
    expect(sample.candidates).toBe(1);
  });

  it("does not let an ADVISORY finding suppress Unknown", async () => {
    // The advisory series is a different question. Letting one answer for the
    // paging series would publish `blocking:true = 0` over a candidate that was
    // never judged.
    const unprobedRunId = RUN_ID + 1;
    const probeScheduledJobs = vi
      .fn()
      .mockImplementation((runId: number) =>
        Promise.resolve(runId === unprobedRunId ? null : 0)
      );

    const sample = await unknownSample({
      runs: [run(45), run(46, { id: unprobedRunId })],
      openPullRequests: [head({ rollupContexts: FULLY_REPORTED })],
      probeScheduledJobs,
    });

    expect(sample.reason).toContain("could not be probed");
  });

  it("treats a run with no start time as unresolved rather than as young", async () => {
    const sample = await unknownSample({
      runs: [run(null)],
      probeScheduledJobs: probing(0),
    });

    expect(sample.reason).toContain("no usable start time");
  });

  it("still publishes a confirmed blocking run when another candidate went unprobed", async () => {
    // Uncertainty is per candidate. A confirmed block elsewhere remains a fact,
    // so the count publishes as a lower bound instead of going dark.
    const unprobedRunId = RUN_ID + 1;
    const probeScheduledJobs = vi
      .fn()
      .mockImplementation((runId: number) =>
        Promise.resolve(runId === unprobedRunId ? null : 0)
      );

    const sample = await okSample({
      runs: [run(45), run(46, { id: unprobedRunId })],
      probeScheduledJobs,
    });

    expect(sample.blocking).toHaveLength(1);
    expect(sample.blocking[0]?.runId).toBe(RUN_ID);
    expect(sample.unresolved).toBe(1);
  });

  it("spends its capped probes on the OLDEST candidates", async () => {
    // GitHub returns runs newest-first. Slicing that order would spend every
    // probe on the youngest candidates and push the longest-stuck runs — the
    // ones actually holding a PR — into the unresolved bucket.
    const overCap = 3;
    const total = MAX_JOB_PROBES + overCap;
    // Ascending age IS newest-first, which is the order GitHub returns. Building
    // it any other way would leave this test green with the sort deleted.
    const runs = Array.from({ length: total }, (_, index) =>
      run(30 + index, { id: RUN_ID + index })
    );
    const probeScheduledJobs = probing(0);

    const sample = await okSample({ runs, probeScheduledJobs });

    expect(probeScheduledJobs).toHaveBeenCalledTimes(MAX_JOB_PROBES);
    expect(sample.unresolved).toBe(overCap);
    // The three youngest run ids are the ones that must have been skipped.
    const probedIds = probeScheduledJobs.mock.calls.map(([id]) => id);
    expect(probedIds).not.toContain(RUN_ID);
    expect(probedIds).toContain(RUN_ID + total - 1);
  });

  it("reports Unknown when a stuck run cannot be judged against an empty required set", async () => {
    // `getRequiredContexts` can legitimately return Ok with no contexts, and its
    // own docstring forbids reading that as "nothing is wrong".
    const sample = await unknownSample({
      runs: [run(45)],
      required: [],
      probeScheduledJobs: probing(0),
    });

    expect(sample.reason).toContain("required-context set is empty");
  });

  it("still reports a truthful zero on an empty required set when nothing is stuck", async () => {
    // Uncertainty is per candidate, so a tick with nothing to judge does not go
    // dark just because the set it never needed was empty.
    const sample = await okSample({
      runs: [run(45)],
      required: [],
      probeScheduledJobs: probing(3),
    });

    expect(sample).toMatchObject({ blocking: [], advisory: [], unresolved: 0 });
  });

  it("reports a truthful empty reading when nothing is queued at all", async () => {
    // 0 is a measurement that lets a monitor recover; absence means broken.
    const sample = await okSample({ runs: [], probeScheduledJobs: probing(0) });

    expect(sample).toEqual({
      status: NeverScheduledStatus.Ok,
      blocking: [],
      advisory: [],
      unresolved: 0,
    });
  });

  it("matches a run to its PR by head SHA, not by branch name", async () => {
    // A stale run on an old SHA of a branch that has since been re-pushed is
    // debris, even though the branch is still open. Matching by name would flag
    // a PR whose current head is healthy.
    const probeScheduledJobs = probing(0);

    const sample = await okSample({
      runs: [run(45, { headSha: CLOSED_PR_SHA })],
      openPullRequests: [head({ headBranch: BRANCH })],
      probeScheduledJobs,
    });

    expect(sample.blocking).toEqual([]);
    expect(probeScheduledJobs).not.toHaveBeenCalled();
  });
});
