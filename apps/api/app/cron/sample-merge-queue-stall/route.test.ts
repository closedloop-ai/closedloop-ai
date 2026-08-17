import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedOctokit: vi.fn(),
  getMergeQueueState: vi.fn(),
  getRequiredContexts: vi.fn(),
  listQueuedWorkflowRuns: vi.fn(),
  listOpenPullRequestHeads: vi.fn(),
  countScheduledJobs: vi.fn(),
  submitSeries: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

// The barrel is mocked wholesale rather than partially: importing it for real
// pulls in the GitHub App auth stack and demands App env this suite has no
// business carrying.
vi.mock("@repo/github", () => ({
  getAuthenticatedOctokit: mocks.getAuthenticatedOctokit,
}));

vi.mock("@repo/github/merge-queue", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMergeQueueState: mocks.getMergeQueueState,
  getRequiredContexts: mocks.getRequiredContexts,
}));

vi.mock("@repo/github/never-scheduled-runs", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listQueuedWorkflowRuns: mocks.listQueuedWorkflowRuns,
  listOpenPullRequestHeads: mocks.listOpenPullRequestHeads,
  countScheduledJobs: mocks.countScheduledJobs,
}));

vi.mock("@repo/observability/telemetry/series", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitSeries: mocks.submitSeries,
}));

vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
  scheduleLogFlushAfter: vi.fn(),
}));

// The `Sampling complete` line is not incidental logging: the ISS-5833 runbook
// entry sends whoever is auditing that decision to `builtUnmergeable` in this
// exact payload, so its shape is the contract under test.
vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: mocks.logInfo, warn: mocks.logWarn },
}));

import {
  MergeQueueReadStatus,
  RequiredContextsReadStatus,
  type RollupContextNode,
} from "@repo/github/merge-queue";
import {
  OpenPullRequestsReadStatus,
  QueuedRunsReadStatus,
} from "@repo/github/never-scheduled-runs";
import {
  DatadogMetricType,
  type DatadogSeries,
  SeriesSubmitStatus,
} from "@repo/observability/telemetry/series";
import {
  queueState as buildQueueState,
  checkRun,
  entry,
  MergeQueueEntryState,
  NOW,
  REQUIRED_CHECK_NAME,
  REQUIRED_CONTEXTS,
  REQUIRED_STATUS_NAME,
  statusContext,
} from "./merge-queue-entry-fixtures";
import { GET } from "./route";

const CRON_SECRET = "test-cron-secret";
const AGE_METRIC = "symphony.ci.merge_queue.group_age_minutes";
const DEPTH_METRIC = "symphony.ci.merge_queue.depth";
const FAILED_GROUPS_METRIC = "symphony.ci.merge_queue.failed_groups";
const NEVER_SCHEDULED_METRIC = "symphony.ci.workflow_run.never_scheduled";
const POLL_METRIC = "symphony.ci.merge_queue.poll";

function authorizedRequest(): Request {
  return new Request("https://api.test/cron/sample-merge-queue-stall", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

/** Every series across every submitSeries call, flattened. */
function allSubmitted(): DatadogSeries[] {
  return mocks.submitSeries.mock.calls.flatMap(
    (call) => call[0] as DatadogSeries[]
  );
}

function seriesFor(metric: string): DatadogSeries[] {
  return allSubmitted().filter((series) => series.metric === metric);
}

/**
 * The outcome tag of the LAST poll beat the route sent.
 *
 * Last, not only: the healthy path packs an ok beat into the gauge payload, and
 * when that payload is rejected the route follows it with a standalone error
 * beat. The final beat is the one that describes the tick.
 */
function pollTags(): string[] {
  const poll = seriesFor(POLL_METRIC);
  if (poll.length === 0) {
    throw new Error("expected at least one poll series, got none");
  }
  return poll.at(-1)?.tags ?? [];
}

/** The payload of the per-tick `Sampling complete` line the runbook reads. */
function samplingComplete(): Record<string, unknown> {
  const call = mocks.logInfo.mock.calls.find(([message]) =>
    String(message).includes("Sampling complete")
  );
  if (!call) {
    throw new Error("expected a Sampling complete log line, got none");
  }
  return call[1] as Record<string, unknown>;
}

/**
 * Ages relative to the REAL clock, because most tests here do not pin it. The
 * shared fixtures build against a fixed NOW instead, so the two are used for
 * different jobs: this one for the age/depth path, the fixtures for the
 * rollup-carrying entries the failed-groups path needs.
 */
function queueState(minutesOld: (number | null)[], totalCount?: number) {
  const now = Date.now();
  return {
    status: MergeQueueReadStatus.Ok,
    state: {
      entries: {
        totalCount: totalCount ?? minutesOld.length,
        nodes: minutesOld.map((age, index) => ({
          state: MergeQueueEntryState.AwaitingChecks,
          pullRequest: { number: 4400 + index },
          headCommit:
            age === null
              ? null
              : {
                  committedDate: new Date(now - age * 60_000).toISOString(),
                  oid: `oid-${index}`,
                  statusCheckRollup: null,
                },
        })),
      },
    },
  };
}

/** An Ok merge-queue read wrapping entries built by the shared fixtures. */
function readOf(...entries: ReturnType<typeof entry>[]) {
  return {
    status: MergeQueueReadStatus.Ok,
    state: buildQueueState(entries),
  };
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  mocks.submitSeries.mockResolvedValue(SeriesSubmitStatus.Ok);
  mocks.getAuthenticatedOctokit.mockResolvedValue({ graphql: vi.fn() });
  mocks.getRequiredContexts.mockResolvedValue({
    status: RequiredContextsReadStatus.Ok,
    contexts: REQUIRED_CONTEXTS,
  });
  // A healthy, empty never-scheduled reading by default: nothing queued, so both
  // series publish a truthful 0 and the existing merge-queue cases are unchanged
  // apart from those two extra points.
  mocks.listQueuedWorkflowRuns.mockResolvedValue({
    status: QueuedRunsReadStatus.Ok,
    runs: [],
    truncated: false,
  });
  mocks.listOpenPullRequestHeads.mockResolvedValue({
    status: OpenPullRequestsReadStatus.Ok,
    pullRequests: [],
    truncated: false,
  });
  mocks.countScheduledJobs.mockResolvedValue(0);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  // Restored here rather than at the end of the one test that pins the clock,
  // so a failure there cannot leak fake timers into every later test.
  vi.useRealTimers();
});

describe("GET /cron/sample-merge-queue-stall", () => {
  it("rejects a request without the cron secret and reads nothing", async () => {
    const response = await GET(
      new Request("https://api.test/cron/sample-merge-queue-stall")
    );

    expect(response.status).toBe(401);
    expect(mocks.getMergeQueueState).not.toHaveBeenCalled();
    expect(mocks.submitSeries).not.toHaveBeenCalled();
  });

  it("publishes both gauges and an ok poll for a healthy read", async () => {
    mocks.getMergeQueueState.mockResolvedValue(queueState([10, 4]));

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(200);
    expect(seriesFor(AGE_METRIC)).toHaveLength(1);
    expect(seriesFor(DEPTH_METRIC)[0].points[0].value).toBe(2);
    expect(pollTags()).toEqual(["outcome:ok"]);
  });

  it("publishes the age MAX as a gauge on a POSIX-second timestamp", async () => {
    // Asserting the series merely EXISTS would stay green if the route emitted
    // the head's age instead of the max, the depth instead of the age, a count
    // instead of a gauge, or a millisecond timestamp Datadog reads as the year
    // 58000. Pin the clock and assert the actual numbers.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T16:00:00Z"));
    mocks.getMergeQueueState.mockResolvedValue(queueState([5, 95, 12]));

    await GET(authorizedRequest());

    const age = seriesFor(AGE_METRIC)[0];
    expect(age.points[0].value).toBe(95);
    expect(age.type).toBe(DatadogMetricType.Gauge);
    expect(age.interval).toBeUndefined();
    expect(age.points[0].timestamp).toBe(
      Math.floor(new Date("2026-08-05T16:00:00Z").getTime() / 1000)
    );
  });

  it("packs the ok beat into the SAME payload as the gauges", async () => {
    // Two requests could half-land — gauges stored, beat dropped — which reads
    // downstream as a dead poller that is actually working. One request cannot.
    mocks.getMergeQueueState.mockResolvedValue(queueState([10]));

    await GET(authorizedRequest());

    expect(mocks.submitSeries).toHaveBeenCalledTimes(1);
    const payload = mocks.submitSeries.mock.calls[0][0] as DatadogSeries[];
    expect(payload.map((series) => series.metric)).toEqual([
      AGE_METRIC,
      DEPTH_METRIC,
      FAILED_GROUPS_METRIC,
      NEVER_SCHEDULED_METRIC,
      NEVER_SCHEDULED_METRIC,
      POLL_METRIC,
    ]);
  });

  it("tags the gauges with base only, never a PR number", async () => {
    mocks.getMergeQueueState.mockResolvedValue(queueState([10]));

    await GET(authorizedRequest());

    // PR numbers are unbounded; one as a tag mints a permanent timeseries per
    // queue entry.
    expect(seriesFor(AGE_METRIC)[0].tags).toEqual(["base:main"]);
    expect(seriesFor(DEPTH_METRIC)[0].tags).toEqual(["base:main"]);
  });

  it.each([
    MergeQueueReadStatus.Failed,
    MergeQueueReadStatus.Malformed,
    MergeQueueReadStatus.NotConfigured,
  ])("publishes no gauges and an error poll when the read is %s", async (status) => {
    mocks.getMergeQueueState.mockResolvedValue({ status, detail: "nope" });

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(200);
    // A 0 here would be a fabricated healthy reading for a queue never seen.
    expect(seriesFor(AGE_METRIC)).toHaveLength(0);
    expect(seriesFor(DEPTH_METRIC)).toHaveLength(0);
    expect(pollTags()).toEqual(["outcome:error"]);
  });

  it("still beats when the GitHub read hangs past its budget", async () => {
    // None of the three GitHub calls carries its own timeout. Without the
    // deadline the platform would kill the invocation mid-hang and the beat —
    // the one signal that says this tick failed — would never be sent.
    vi.useFakeTimers();
    mocks.getMergeQueueState.mockReturnValue(new Promise(() => undefined));

    const responsePromise = GET(authorizedRequest());
    await vi.advanceTimersByTimeAsync(15_000);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(seriesFor(AGE_METRIC)).toHaveLength(0);
    expect(pollTags()).toEqual(["outcome:error"]);
  });

  it("sends the fallback beat with no retries, to fit the time left", async () => {
    // The reservation the budget depends on: with default retries on both
    // sends, the two Datadog calls alone exceed maxDuration and the platform
    // kills the request whose only job is to report the failure.
    mocks.getMergeQueueState.mockResolvedValue(queueState([10]));
    mocks.submitSeries.mockResolvedValue(SeriesSubmitStatus.Rejected);

    await GET(authorizedRequest());

    expect(mocks.submitSeries).toHaveBeenCalledTimes(2);
    expect(mocks.submitSeries.mock.calls[1][2]).toEqual({ maxRetries: 0 });
  });

  it("reports an error poll, not a throw, when App auth fails", async () => {
    // Minting the installation token is its own network call. Letting it throw
    // would skip the beat, and the heartbeat could not then distinguish a
    // broken poller from one that never ran.
    mocks.getAuthenticatedOctokit.mockRejectedValue(new Error("bad key"));

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(200);
    expect(mocks.getMergeQueueState).not.toHaveBeenCalled();
    expect(seriesFor(AGE_METRIC)).toHaveLength(0);
    expect(pollTags()).toEqual(["outcome:error"]);
  });

  it("passes the authenticated client through to the queue read", async () => {
    const octokit = { graphql: vi.fn() };
    mocks.getAuthenticatedOctokit.mockResolvedValue(octokit);
    mocks.getMergeQueueState.mockResolvedValue(queueState([10]));

    await GET(authorizedRequest());

    // Guards the injection seam: a route that built its own client would still
    // pass every other test in this file.
    expect(mocks.getMergeQueueState).toHaveBeenCalledWith(
      octokit,
      "closedloop-ai",
      "symphony-alpha",
      "main"
    );
  });

  it("publishes no gauges and an error poll when the queue exceeds one page", async () => {
    mocks.getMergeQueueState.mockResolvedValue(queueState([10, 4], 137));

    await GET(authorizedRequest());

    expect(seriesFor(AGE_METRIC)).toHaveLength(0);
    expect(pollTags()).toEqual(["outcome:error"]);
  });

  it("reports outcome:error when Datadog rejects the gauges", async () => {
    // The contract the cl-tofu heartbeat depends on: ok means the gauges
    // LANDED. Reporting ok after a rejected publish would leave the stall
    // monitor with no data while the heartbeat said everything was fine.
    mocks.getMergeQueueState.mockResolvedValue(queueState([10]));
    mocks.submitSeries
      .mockResolvedValueOnce(SeriesSubmitStatus.Rejected)
      .mockResolvedValueOnce(SeriesSubmitStatus.Ok);

    await GET(authorizedRequest());

    expect(pollTags()).toEqual(["outcome:error"]);
  });

  it("still attempts the poll beat when the gauge publish fails", async () => {
    mocks.getMergeQueueState.mockResolvedValue(queueState([10]));
    mocks.submitSeries.mockResolvedValue(SeriesSubmitStatus.Rejected);

    await GET(authorizedRequest());

    // Two calls: the gauges, then the beat. Dropping the beat would remove the
    // only signal that says the poller is in trouble.
    expect(mocks.submitSeries).toHaveBeenCalledTimes(2);
  });

  it("never fails the request when telemetry is broken", async () => {
    mocks.getMergeQueueState.mockResolvedValue(queueState([10]));
    mocks.submitSeries.mockResolvedValue(SeriesSubmitStatus.NotConfigured);

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(200);
  });

  it("emits the poll as a count with an interval, not a gauge", async () => {
    mocks.getMergeQueueState.mockResolvedValue(queueState([10]));

    await GET(authorizedRequest());

    const poll = seriesFor(POLL_METRIC)[0];
    // Datadog requires `interval` on COUNT series; without it the rate is wrong.
    expect(poll.type).toBe(1);
    expect(poll.interval).toBe(1);
    expect(poll.points[0].value).toBe(1);
  });
});

describe("the failed_groups gauge", () => {
  it("publishes the count when a required context is red on a built group", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.getMergeQueueState.mockResolvedValue(
      readOf(
        entry({
          minutesOld: 5,
          pullRequest: 4400,
          contexts: [statusContext(REQUIRED_STATUS_NAME, { state: "FAILURE" })],
        }),
        entry({ minutesOld: 3, pullRequest: 4401 })
      )
    );

    await GET(authorizedRequest());

    const failed = seriesFor(FAILED_GROUPS_METRIC);
    expect(failed).toHaveLength(1);
    expect(failed[0].type).toBe(DatadogMetricType.Gauge);
    expect(failed[0].points[0].value).toBe(1);
  });

  it("publishes a real zero for a queue with nothing failing", async () => {
    // A measured 0 and an omitted series must not look alike: the monitor
    // recovers on the 0 and goes no-data on the omission.
    mocks.getMergeQueueState.mockResolvedValue(queueState([10, 4]));

    await GET(authorizedRequest());

    expect(seriesFor(FAILED_GROUPS_METRIC)[0].points[0].value).toBe(0);
  });

  it("OMITS the series when the required-context set cannot be read, and still publishes age and depth", async () => {
    // The whole design rule in one case: a 0 here would be a confident
    // "nothing is failing" for a required set that was never seen. Age and
    // depth do not depend on it, so the paging signal keeps working.
    mocks.getMergeQueueState.mockResolvedValue(queueState([10, 4]));
    mocks.getRequiredContexts.mockResolvedValue({
      status: RequiredContextsReadStatus.Failed,
      detail: "boom",
    });

    const response = await GET(authorizedRequest());

    expect(seriesFor(FAILED_GROUPS_METRIC)).toHaveLength(0);
    expect(seriesFor(AGE_METRIC)).toHaveLength(1);
    expect(seriesFor(DEPTH_METRIC)).toHaveLength(1);
    // Not an error: the tick DID sample the queue. Flipping the beat would page
    // the on-call for a degraded secondary signal.
    expect(pollTags()).toEqual(["outcome:ok"]);
    expect(response.status).toBe(200);
  });

  it("OMITS the series when a clean group's context page was truncated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.getMergeQueueState.mockResolvedValue(
      readOf(
        entry({
          minutesOld: 5,
          contexts: [checkRun("typecheck", { conclusion: "SUCCESS" })],
          contextsTotalCount: 150,
        })
      )
    );

    await GET(authorizedRequest());

    expect(seriesFor(FAILED_GROUPS_METRIC)).toHaveLength(0);
    expect(pollTags()).toEqual(["outcome:ok"]);
  });

  it("reads the required set for the same branch the queue was read for", async () => {
    // A required set read for a different branch would intersect against the
    // wrong contexts and quietly report zero.
    mocks.getMergeQueueState.mockResolvedValue(queueState([10]));

    await GET(authorizedRequest());

    expect(mocks.getRequiredContexts).toHaveBeenCalledWith(
      expect.anything(),
      "closedloop-ai",
      "symphony-alpha",
      "main"
    );
  });

  it("does not read the required set at all when the cron secret is missing", async () => {
    await GET(new Request("https://api.test/cron/sample-merge-queue-stall"));

    expect(mocks.getRequiredContexts).not.toHaveBeenCalled();
  });

  it("keeps the gauge, the beat and the response in agreement on one tick", async () => {
    // Cross-surface consistency: the number in the series, the number in the
    // response body, and the beat all describe the same sample.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.getMergeQueueState.mockResolvedValue(
      readOf(
        entry({
          minutesOld: 5,
          pullRequest: 4400,
          // A terminally red REQUIRED context — the only thing that makes a
          // group count since ISS-5833. This used to lean on `UNMERGEABLE`,
          // which no longer produces a failure for the tick to agree about.
          contexts: [statusContext(REQUIRED_STATUS_NAME, { state: "FAILURE" })],
        })
      )
    );

    const response = await GET(authorizedRequest());

    expect(seriesFor(FAILED_GROUPS_METRIC)[0].points[0].value).toBe(1);
    expect(await response.text()).toContain("failed=1");
    expect(pollTags()).toEqual(["outcome:ok"]);
  });

  it("ISS-5833: publishes 0 for an UNMERGEABLE-only tick, through the real route", async () => {
    // The production symptom was a GAUGE value that paged 105 times, not a pure
    // function's return, so it is pinned at the surface that actually paged. The
    // series is still PUBLISHED — a 0 is a real reading here, not an omission.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.getMergeQueueState.mockResolvedValue(
      readOf(
        entry({
          minutesOld: 5,
          pullRequest: 4540,
          state: MergeQueueEntryState.Unmergeable,
        })
      )
    );

    const response = await GET(authorizedRequest());

    expect(seriesFor(FAILED_GROUPS_METRIC)[0].points[0].value).toBe(0);
    expect(await response.text()).toContain("failed=0");
  });

  it("says unknown rather than 0 in the response body when the reading is omitted", async () => {
    mocks.getMergeQueueState.mockResolvedValue(queueState([10]));
    mocks.getRequiredContexts.mockResolvedValue({
      status: RequiredContextsReadStatus.Malformed,
      detail: "bad rule",
    });

    const response = await GET(authorizedRequest());

    expect(await response.text()).toContain("failed=unknown");
  });

  it("keeps reporting builtUnmergeable when the verdict is unknown", async () => {
    // The ruleset read failed, so no group can be judged — but the QUEUE read
    // succeeded, so how many BUILT groups sat in `UNMERGEABLE` is still known.
    // This path never reaches `deriveFailedGroups`, and a `null` here would drop
    // the population signal the runbook audits ISS-5833 with, on the exact tick
    // that most needs it: `null` has to mean genuinely unknown, not discarded.
    mocks.getMergeQueueState.mockResolvedValue(
      readOf(
        entry({ minutesOld: 5, state: MergeQueueEntryState.Unmergeable }),
        entry({ minutesOld: 3, state: MergeQueueEntryState.Unmergeable }),
        // Unbuilt, so outside the population however UNMERGEABLE it reads.
        entry({ minutesOld: null, state: MergeQueueEntryState.Unmergeable })
      )
    );
    mocks.getRequiredContexts.mockResolvedValue({
      status: RequiredContextsReadStatus.Malformed,
      detail: "bad rule",
    });

    const response = await GET(authorizedRequest());

    // The verdict genuinely is unknown, and stays omitted...
    expect(await response.text()).toContain("failed=unknown");
    expect(seriesFor(FAILED_GROUPS_METRIC)).toHaveLength(0);
    // ...while the population it would be audited against is reported.
    expect(samplingComplete()).toMatchObject({
      failedGroups: null,
      builtUnmergeable: 2,
    });
  });
});

describe("the two GitHub reads fail independently", () => {
  it("keeps age and depth when only the required-context read hangs", async () => {
    // The coupling bug: both reads shared ONE deadline via Promise.all, which
    // settles only when both settle — so a hang in the secondary ruleset read
    // discarded a queue read that had already succeeded, and the tick published
    // no gauges at all. Age and depth must survive; only failed_groups is lost.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.getMergeQueueState.mockResolvedValue(queueState([10, 4]));
    mocks.getRequiredContexts.mockReturnValue(new Promise(() => undefined));

    const pending = GET(authorizedRequest());
    await vi.advanceTimersByTimeAsync(60_000);
    const response = await pending;

    expect(seriesFor(AGE_METRIC)).toHaveLength(1);
    expect(seriesFor(DEPTH_METRIC)[0].points[0].value).toBe(2);
    expect(seriesFor(FAILED_GROUPS_METRIC)).toHaveLength(0);
    // Still a successful sample of the thing that pages.
    expect(pollTags()).toEqual(["outcome:ok"]);
    expect(response.status).toBe(200);
  });

  it("still reports an error tick when the QUEUE read hangs", async () => {
    // The complementary direction, so the test above cannot pass by making
    // every hang harmless.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.getMergeQueueState.mockReturnValue(new Promise(() => undefined));

    const pending = GET(authorizedRequest());
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;

    expect(seriesFor(AGE_METRIC)).toHaveLength(0);
    expect(seriesFor(DEPTH_METRIC)).toHaveLength(0);
    expect(pollTags()).toEqual(["outcome:error"]);
  });

  it("gives auth its OWN 5s bound, not the read budget", async () => {
    // codex: advancing 60s proved only that auth eventually times out — the old
    // shared deadline would have passed that too. Advancing just past the 5s
    // auth budget, and NOT as far as the 10s read budget, is what pins auth to a
    // separate, shorter bound. Auth precedes both reads, so without its own
    // ceiling the per-read deadlines never start counting and the invocation is
    // killed before it can emit the beat that says the tick failed.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.getAuthenticatedOctokit.mockReturnValue(new Promise(() => undefined));

    const pending = GET(authorizedRequest());
    await vi.advanceTimersByTimeAsync(6000);
    await pending;

    expect(seriesFor(AGE_METRIC)).toHaveLength(0);
    expect(pollTags()).toEqual(["outcome:error"]);
    // No read was ever reached, so none can have been attempted.
    expect(mocks.getMergeQueueState).not.toHaveBeenCalled();
    expect(mocks.getRequiredContexts).not.toHaveBeenCalled();
    expect(mocks.listQueuedWorkflowRuns).not.toHaveBeenCalled();
    expect(mocks.listOpenPullRequestHeads).not.toHaveBeenCalled();
  });
});

/**
 * A queued run `minutesOld` old, sitting on `headSha`.
 *
 * Built against the pinned `NOW` the describe below installs, so the 20-minute
 * threshold is exact arithmetic rather than a wall-clock tolerance.
 */
function queuedRun(
  minutesOld: number,
  headSha: string,
  runId = 31_121_510_116
) {
  return {
    id: runId,
    workflow: "PR Tests",
    headSha,
    headBranch: "fix/iss-5333-gridtable-header-align",
    runStartedAt: new Date(NOW.getTime() - minutesOld * 60_000).toISOString(),
  };
}

function openHead(headSha: string, rollupContexts: RollupContextNode[] = []) {
  return {
    number: 4711,
    headSha,
    headBranch: "fix/iss-5333-gridtable-header-align",
    rollupContexts,
  };
}

function neverScheduledValue(blocking: boolean): number | undefined {
  return seriesFor(NEVER_SCHEDULED_METRIC).find((series) =>
    series.tags?.includes(`blocking:${blocking}`)
  )?.points[0].value;
}

describe("the never_scheduled gauge (ISS-6011)", () => {
  const STUCK_SHA = "c".repeat(40);

  /** One stuck run on one open PR head, which every case below starts from. */
  function oneStuckRun(rollupContexts: RollupContextNode[] = []) {
    mocks.listQueuedWorkflowRuns.mockResolvedValue({
      status: QueuedRunsReadStatus.Ok,
      runs: [queuedRun(45, STUCK_SHA)],
      truncated: false,
    });
    mocks.listOpenPullRequestHeads.mockResolvedValue({
      status: OpenPullRequestsReadStatus.Ok,
      pullRequests: [openHead(STUCK_SHA, rollupContexts)],
      truncated: false,
    });
  }

  beforeEach(() => {
    // The threshold is a clock boundary, so it is pinned rather than raced.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.getMergeQueueState.mockResolvedValue(queueState([10]));
  });

  it("publishes a truthful zero on both series when nothing is queued", async () => {
    await GET(authorizedRequest());

    expect(neverScheduledValue(true)).toBe(0);
    expect(neverScheduledValue(false)).toBe(0);
  });

  it("flags a stuck run through the real route and names the PR it blocks", async () => {
    oneStuckRun();

    const response = await GET(authorizedRequest());

    expect(neverScheduledValue(true)).toBe(1);
    // The probe has to run against the run the reads actually produced —
    // asserting only the gauge would stay green if the route probed nothing and
    // the derivation happened to default to zero jobs.
    expect(mocks.countScheduledJobs).toHaveBeenCalledWith(
      expect.anything(),
      "closedloop-ai",
      "symphony-alpha",
      31_121_510_116
    );
    const warned = mocks.logWarn.mock.calls.find(([message]) =>
      String(message).includes("never scheduled a job and are blocking")
    );
    expect(warned?.[1]).toMatchObject({
      unresolved: 0,
      runs: [
        expect.objectContaining({
          pullRequest: 4711,
          runId: 31_121_510_116,
          unreportedRequiredContexts: [
            REQUIRED_CHECK_NAME,
            REQUIRED_STATUS_NAME,
          ],
        }),
      ],
    });
    expect(await response.text()).toContain("never_scheduled=1");
  });

  it("counts a run on a fully-reported head as advisory, not blocking", async () => {
    oneStuckRun([
      checkRun(REQUIRED_CHECK_NAME),
      statusContext(REQUIRED_STATUS_NAME),
    ]);

    await GET(authorizedRequest());

    expect(neverScheduledValue(true)).toBe(0);
    expect(neverScheduledValue(false)).toBe(1);
  });

  it("publishes the gauges even when the merge-queue read fails", async () => {
    // The independence contract. A PR head being blocked has nothing to do with
    // whether the queue could be read, so a queue failure must not take this
    // reading down with it.
    mocks.getMergeQueueState.mockResolvedValue({
      status: MergeQueueReadStatus.Failed,
      detail: "nope",
    });
    oneStuckRun();

    await GET(authorizedRequest());

    expect(seriesFor(AGE_METRIC)).toHaveLength(0);
    expect(neverScheduledValue(true)).toBe(1);
    expect(pollTags()).toEqual(["outcome:error"]);
  });

  it("publishes the gauges even when the queue is deeper than one page", async () => {
    mocks.getMergeQueueState.mockResolvedValue(queueState([10], 137));
    oneStuckRun();

    await GET(authorizedRequest());

    expect(seriesFor(AGE_METRIC)).toHaveLength(0);
    expect(neverScheduledValue(true)).toBe(1);
  });

  it.each([
    QueuedRunsReadStatus.Failed,
    QueuedRunsReadStatus.Malformed,
  ])("OMITS both series when the queued-runs read is %s", async (status) => {
    // A 0 here would be a fabricated "no PR is blocked" over a set never seen.
    mocks.listQueuedWorkflowRuns.mockResolvedValue({ status, detail: "nope" });

    await GET(authorizedRequest());

    expect(seriesFor(NEVER_SCHEDULED_METRIC)).toHaveLength(0);
    // The queue gauges are independent in the other direction too.
    expect(seriesFor(AGE_METRIC)).toHaveLength(1);
  });

  it("OMITS both series when the open-pull-requests read fails", async () => {
    mocks.listOpenPullRequestHeads.mockResolvedValue({
      status: OpenPullRequestsReadStatus.Failed,
      detail: "nope",
    });

    await GET(authorizedRequest());

    expect(seriesFor(NEVER_SCHEDULED_METRIC)).toHaveLength(0);
  });

  it("OMITS both series when the required-context read fails", async () => {
    mocks.getRequiredContexts.mockResolvedValue({
      status: RequiredContextsReadStatus.Failed,
      detail: "nope",
    });
    oneStuckRun();

    await GET(authorizedRequest());

    expect(seriesFor(NEVER_SCHEDULED_METRIC)).toHaveLength(0);
  });

  it.each([
    ["open pull requests", { openPullRequests: true, queuedRuns: false }],
    ["queued runs", { openPullRequests: false, queuedRuns: true }],
  ])("OMITS both series when the %s page was truncated", async (_label, truncation) => {
    // An unseen open PR head makes a stuck run on it fail the head lookup and
    // read as closed-PR debris, so publishing would assert "nothing is
    // blocked" over heads this tick never read.
    mocks.listQueuedWorkflowRuns.mockResolvedValue({
      status: QueuedRunsReadStatus.Ok,
      runs: [queuedRun(45, STUCK_SHA)],
      truncated: truncation.queuedRuns,
    });
    mocks.listOpenPullRequestHeads.mockResolvedValue({
      status: OpenPullRequestsReadStatus.Ok,
      pullRequests: [openHead(STUCK_SHA)],
      truncated: truncation.openPullRequests,
    });

    await GET(authorizedRequest());

    expect(seriesFor(NEVER_SCHEDULED_METRIC)).toHaveLength(0);
    expect(seriesFor(AGE_METRIC)).toHaveLength(1);
  });

  it("OMITS both series when the job probes hang past their budget", async () => {
    // The probe phase carries its own deadline for the same reason every other
    // phase does. Without it the platform kills the invocation mid-hang and the
    // beat that says the tick failed never goes.
    oneStuckRun();
    mocks.countScheduledJobs.mockReturnValue(new Promise(() => undefined));

    const pending = GET(authorizedRequest());
    await vi.advanceTimersByTimeAsync(11_000);
    await pending;

    expect(seriesFor(NEVER_SCHEDULED_METRIC)).toHaveLength(0);
    expect(seriesFor(AGE_METRIC)).toHaveLength(1);
  });

  it("bounds each probe separately, so one hang cannot discard the answers that arrived", async () => {
    // The ISS-5141 lesson applied to the probe fan-out: the combinator settles
    // only when ALL probes settle, so a phase deadline alone would throw away a
    // confirmed blocking run because an unrelated probe hung.
    const hungRunId = 31_121_510_117;
    mocks.listQueuedWorkflowRuns.mockResolvedValue({
      status: QueuedRunsReadStatus.Ok,
      runs: [queuedRun(45, STUCK_SHA), queuedRun(46, STUCK_SHA, hungRunId)],
      truncated: false,
    });
    mocks.listOpenPullRequestHeads.mockResolvedValue({
      status: OpenPullRequestsReadStatus.Ok,
      pullRequests: [openHead(STUCK_SHA)],
      truncated: false,
    });
    mocks.countScheduledJobs.mockImplementation((_client, _owner, _repo, id) =>
      id === hungRunId ? new Promise(() => undefined) : Promise.resolve(0)
    );

    const pending = GET(authorizedRequest());
    // Past the 5s per-probe budget, but well inside the 10s phase backstop.
    await vi.advanceTimersByTimeAsync(6000);
    await pending;

    expect(neverScheduledValue(true)).toBe(1);
    const warned = mocks.logWarn.mock.calls.find(([message]) =>
      String(message).includes("never scheduled a job and are blocking")
    );
    // The hung probe is reported as one unresolved candidate, which is what
    // makes the published 1 readable as a lower bound.
    expect(warned?.[1]).toMatchObject({ unresolved: 1 });
  });

  it("reads open PR heads and queued runs for the same repository as the queue", async () => {
    await GET(authorizedRequest());

    for (const read of [
      mocks.listQueuedWorkflowRuns,
      mocks.listOpenPullRequestHeads,
    ]) {
      expect(read).toHaveBeenCalledWith(
        expect.anything(),
        "closedloop-ai",
        "symphony-alpha"
      );
    }
  });
});
