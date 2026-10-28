import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countScheduledJobs,
  listPullRequestCommentPage,
  listQueuedWorkflowRuns,
  type OpenPullRequestsReadResult,
  OpenPullRequestsReadStatus,
  type QueuedRunsReadResult,
  QueuedRunsReadStatus,
} from "../never-scheduled-runs";
// The PR-node and page shapes are shared with
// `open-pull-requests-partial-read.test.ts`; see that module's header.
import {
  createOctokitMock,
  expectOkPullRequests,
  HEAD_SHA,
  OWNER,
  pullRequestNode,
  pullRequestsResponse,
  REPO,
  readPullRequests as readHeads,
} from "./never-scheduled-runs-fixtures";

// Credential-agnostic by construction (the Octokit is injected), so these tests
// need no App env and no auth mocking.
const {
  request: mockRequest,
  graphql: mockGraphql,
  octokit,
} = createOctokitMock();

const RUNS_PAGE_SIZE = 100;

function workflowRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 31_121_510_116,
    name: "PR Tests",
    head_sha: HEAD_SHA,
    head_branch: "feat/thing",
    run_started_at: "2026-08-06T19:05:08Z",
    run_attempt: 1,
    ...overrides,
  };
}

function runsResponse(runs: unknown[]) {
  return { data: { workflow_runs: runs } };
}

function readRuns(): Promise<QueuedRunsReadResult> {
  return listQueuedWorkflowRuns(octokit, OWNER, REPO);
}

function expectOkRuns(result: QueuedRunsReadResult) {
  if (result.status !== QueuedRunsReadStatus.Ok) {
    throw new Error(`expected Ok, got ${result.status}: ${result.detail}`);
  }
  return result;
}

function readPullRequests(): Promise<OpenPullRequestsReadResult> {
  return readHeads(octokit);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listQueuedWorkflowRuns", () => {
  it("normalizes GitHub's wire keys to the camelCase contract", async () => {
    mockRequest.mockResolvedValue(runsResponse([workflowRun()]));

    expect(expectOkRuns(await readRuns()).runs).toEqual([
      {
        id: 31_121_510_116,
        workflow: "PR Tests",
        headSha: HEAD_SHA,
        headBranch: "feat/thing",
        runStartedAt: "2026-08-06T19:05:08Z",
        runAttempt: 1,
      },
    ]);
  });

  it("keeps a run GitHub sent without an attempt, reading the attempt as null", async () => {
    mockRequest.mockResolvedValue(
      runsResponse([workflowRun({ run_attempt: undefined })])
    );

    expect(expectOkRuns(await readRuns()).runs[0]?.runAttempt).toBeNull();
  });

  it("asks only for queued runs, since a run with a job is never in this state", async () => {
    mockRequest.mockResolvedValue(runsResponse([]));

    await readRuns();

    expect(mockRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "queued", per_page: RUNS_PAGE_SIZE })
    );
  });

  it("keeps a run whose workflow was deleted rather than dropping it", async () => {
    // A nameless run still blocks, and dropping it would leave the tick blind to
    // the one run whose metadata is already odd.
    mockRequest.mockResolvedValue(runsResponse([workflowRun({ name: null })]));

    expect(expectOkRuns(await readRuns()).runs[0]?.workflow).toBe(
      "(unnamed workflow)"
    );
  });

  it("keeps a run with no start time, leaving the age verdict to the caller", async () => {
    mockRequest.mockResolvedValue(
      runsResponse([workflowRun({ run_started_at: null })])
    );

    expect(expectOkRuns(await readRuns()).runs[0]?.runStartedAt).toBeNull();
  });

  it("reports a full page as truncated, so a bigger population is not read as complete", async () => {
    mockRequest.mockResolvedValue(
      runsResponse(
        Array.from({ length: RUNS_PAGE_SIZE }, (_, index) =>
          workflowRun({ id: index })
        )
      )
    );

    expect(expectOkRuns(await readRuns()).truncated).toBe(true);
  });

  it("does not report truncation one run below the page size", async () => {
    mockRequest.mockResolvedValue(
      runsResponse(
        Array.from({ length: RUNS_PAGE_SIZE - 1 }, (_, index) =>
          workflowRun({ id: index })
        )
      )
    );

    expect(expectOkRuns(await readRuns()).truncated).toBe(false);
  });

  it("fails the WHOLE page when one run is unreadable", async () => {
    // Deliberately unlike the rollup nodes, which degrade to holes. A silently
    // dropped run is a run that never gets probed, so the tick would publish a
    // confident "nothing is stuck" over the very run that was.
    mockRequest.mockResolvedValue(
      runsResponse([workflowRun(), workflowRun({ id: "not-a-number" })])
    );

    expect((await readRuns()).status).toBe(QueuedRunsReadStatus.Malformed);
  });

  it("classifies a transport failure rather than throwing it at the caller", async () => {
    mockRequest.mockRejectedValue(new Error("boom"));

    const result = await readRuns();

    expect(result.status).toBe(QueuedRunsReadStatus.Failed);
    expect(result).toMatchObject({ detail: "boom" });
  });
});

describe("listOpenPullRequestHeads", () => {
  it("returns each head SHA with the rollup reported against it", async () => {
    mockGraphql.mockResolvedValue(pullRequestsResponse([pullRequestNode()]));

    const pullRequests = expectOkPullRequests(
      await readPullRequests()
    ).pullRequests;

    expect(pullRequests).toHaveLength(1);
    expect(pullRequests[0]).toMatchObject({
      number: 4711,
      headSha: HEAD_SHA,
      headBranch: "feat/thing",
      // ISS-6018 — the readiness sweep answers per BRANCH ruleset and must not
      // answer for a draft, so both have to survive the mapping.
      baseBranch: "main",
      isDraft: false,
    });
    expect(pullRequests[0]?.rollupContexts).toEqual([
      expect.objectContaining({ __typename: "CheckRun", name: "typecheck" }),
    ]);
  });

  it("orders by most recently updated, so a cut page keeps the live PRs", async () => {
    // GitHub's default for this connection is oldest-first, which would cut the
    // PRs most likely to be carrying a stuck run.
    mockGraphql.mockResolvedValue(pullRequestsResponse([]));

    await readPullRequests();

    expect(mockGraphql.mock.calls[0]?.[0]).toContain(
      "orderBy: {field: UPDATED_AT, direction: DESC}"
    );
  });

  it("asks for a page GitHub can actually answer, with the rollup left whole", async () => {
    // Both halves are load-bearing and they pull in opposite directions
    // (ISS-6012). Measured against closedloop-ai/closedloop-ai on 2026-09-15
    // at 93 open PRs: `first: 100` with this rollup nested under it made GitHub
    // abort the query server-side at ~11.5s, 3 samples of 3, so the read could
    // never succeed — the stall cron then omitted
    // `symphony.ci.workflow_run.never_scheduled` on every tick for 34 days and
    // `ready-to-enqueue` wrote an empty plan. `first: 25` completes the whole
    // walk in 14.2s.
    //
    // The tempting other fix is shrinking the rollup instead, and it silently
    // does nothing: open PRs here carry 50-66 rollup contexts (min/max over 25
    // PRs), so a 20- or 50-node rollup page marks every PR truncated and leaves
    // the gauge exactly as dark. Hence an EXACT pin on one and a floor on the
    // other, not a single "make it smaller".
    //
    // Exact, not a `<= 25` ceiling: a ceiling also accepts 1, and against
    // `MAX_OPEN_PR_PAGES` that reads 40 of the repository's open PRs and marks
    // the rest truncated — the cron resolves that to Unknown and omits the
    // gauge again, which is the bug this test is here to prevent. Both
    // directions are measured, so both are pinned.
    mockGraphql.mockResolvedValue(pullRequestsResponse([]));

    await readPullRequests();

    const variables = mockGraphql.mock.calls[0]?.[1] as {
      first: number;
      rollupFirst: number;
    };
    expect(variables.first).toBe(25);
    expect(variables.rollupFirst).toBeGreaterThanOrEqual(100);
  });

  it("carries each comment's node id, which no comment id can outgrow", async () => {
    // NOT `databaseId`: that is the legacy 32-bit projection and GitHub returns
    // null for it on comments whose id has already outgrown it. The readiness
    // sweep keys its own marker comment on this, and a null id there means it
    // POSTs a duplicate every tick instead of updating what it owns.
    const commentId = "IC_kwDOQ4gDpM6ZAZWy";
    mockGraphql.mockResolvedValue(
      pullRequestsResponse([
        pullRequestNode({
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: commentId, body: "hi", viewerDidAuthor: true }],
          },
        }),
      ])
    );

    const result = expectOkPullRequests(await readPullRequests());

    expect(result.pullRequests[0]?.comments).toEqual([
      { id: commentId, body: "hi", viewerDidAuthor: true },
    ]);
    expect(mockGraphql.mock.calls[0]?.[0]).toContain(
      "nodes { id body viewerDidAuthor }"
    );
  });

  it("hands back the cursor when the comments run past one page", async () => {
    // The marker only stays on page one while the sweep keeps touching it, and
    // an unchanged verdict costs no write — so on a busy PR it drifts off.
    mockGraphql.mockResolvedValue(
      pullRequestsResponse([
        pullRequestNode({
          comments: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            nodes: [],
          },
        }),
      ])
    );

    expect(
      expectOkPullRequests(await readPullRequests()).pullRequests[0]
        ?.commentsCursor
    ).toBe("cursor-1");
  });

  it("degrades a rollup claiming fewer contexts than it returned to truncated", async () => {
    // totalCount is the population and nodes the page drawn from it, so the page
    // can never be larger. Reading the inverted shape through would report the
    // rollup COMPLETE, and the readiness consumer would then take a surviving
    // stale SUCCESS for the live attempt and answer "Ready to enqueue".
    mockGraphql.mockResolvedValue(
      pullRequestsResponse([
        pullRequestNode({
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      totalCount: 1,
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "typecheck",
                          conclusion: "SUCCESS",
                          completedAt: "2026-08-12T12:00:00Z",
                          startedAt: null,
                          checkSuite: { app: { databaseId: 15_368 } },
                        },
                        {
                          __typename: "CheckRun",
                          name: "test",
                          conclusion: "SUCCESS",
                          completedAt: "2026-08-12T12:00:00Z",
                          startedAt: null,
                          checkSuite: { app: { databaseId: 15_368 } },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        }),
      ])
    );

    const pullRequest = expectOkPullRequests(await readPullRequests())
      .pullRequests[0];

    expect(pullRequest?.rollupTruncated).toBe(true);
    // Caught into the unreadable sentinel rather than passed through, so the
    // surviving nodes cannot be mistaken for the live set.
    expect(pullRequest?.rollupContexts).toEqual([]);
  });

  it("treats a commit with no rollup as nothing reported", async () => {
    // The legitimate state for a young PR, and the one that makes every required
    // context unreported — which is the safe direction for this signal.
    mockGraphql.mockResolvedValue(
      pullRequestsResponse([
        pullRequestNode({
          commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
        }),
      ])
    );

    expect(
      expectOkPullRequests(await readPullRequests()).pullRequests[0]
        ?.rollupContexts
    ).toEqual([]);
  });

  it("degrades one unreadable rollup node to a hole instead of failing the read", async () => {
    mockGraphql.mockResolvedValue(
      pullRequestsResponse([
        pullRequestNode({
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      totalCount: 1,
                      nodes: [{ __typename: "Mystery" }],
                    },
                  },
                },
              },
            ],
          },
        }),
      ])
    );

    const head = expectOkPullRequests(await readPullRequests()).pullRequests[0];

    expect(head?.rollupContexts).toEqual([null]);
    // ISS-6018 — the dropped node leaves `totalCount` above the READABLE count,
    // which is exactly the gap a consumer needs to refuse to derive from.
    expect(head?.rollupTruncated).toBe(true);
  });

  it("rejects a totalCount smaller than the page it returned", async () => {
    // Accepting it would compute `truncated: false` for a page that WAS cut, and
    // an unseen open PR head silently demotes a stuck run to debris.
    mockGraphql.mockResolvedValue(
      pullRequestsResponse([pullRequestNode(), pullRequestNode()], 1)
    );

    expect((await readPullRequests()).status).toBe(
      OpenPullRequestsReadStatus.Malformed
    );
  });

  it("reports truncation when more open PRs exist than the page returned", async () => {
    mockGraphql.mockResolvedValue(
      pullRequestsResponse([pullRequestNode()], 137)
    );

    expect(expectOkPullRequests(await readPullRequests()).truncated).toBe(true);
  });

  it("does not report truncation when the page exactly covers the population", async () => {
    mockGraphql.mockResolvedValue(pullRequestsResponse([pullRequestNode()], 1));

    expect(expectOkPullRequests(await readPullRequests()).truncated).toBe(
      false
    );
  });

  it("follows the connection instead of stopping at the first page", async () => {
    // The page is ordered most-recently-updated first and the ordering is
    // stable, so the SAME tail is cut every tick: those PRs would not get a late
    // verdict, they would get none, and keep whatever stale one they carry.
    mockGraphql
      .mockResolvedValueOnce(
        pullRequestsResponse([pullRequestNode({ number: 1 })], 2, {
          hasNextPage: true,
          endCursor: "pr-cursor-1",
        })
      )
      .mockResolvedValueOnce(
        pullRequestsResponse([pullRequestNode({ number: 2 })], 2)
      );

    const result = expectOkPullRequests(await readPullRequests());

    expect(result.pullRequests.map((entry) => entry.number)).toEqual([1, 2]);
    expect(result.truncated).toBe(false);
    expect(mockGraphql.mock.calls[1]?.[1]).toMatchObject({
      after: "pr-cursor-1",
    });
  });

  it("stops at the page cap and reports the population as incomplete", async () => {
    // A connection that always claims another page would otherwise spin inside
    // a five-minute tick. Exact, not a ceiling: the cap is stated in OPEN PRs,
    // not in pages, so `OPEN_PR_PAGE_SIZE` coming down must be paid for here.
    // At 25 per page, 40 pages is the 1,000-PR ceiling the walk had when the
    // page was 100 — and `scripts/ci/ready-to-enqueue.ts` has no deadline, so
    // for that caller this cap IS the bound and a low one silently stops
    // refreshing every PR past it.
    mockGraphql.mockResolvedValue(
      pullRequestsResponse([pullRequestNode()], 9999, {
        hasNextPage: true,
        endCursor: "pr-cursor-next",
      })
    );

    const result = expectOkPullRequests(await readPullRequests());

    expect(result.truncated).toBe(true);
    expect(mockGraphql.mock.calls.length).toBe(40);
  });

  it("fails rather than reporting an empty set when the repository is invisible", async () => {
    // An empty set would read as "no open PR is blocked", which is a confident
    // answer over a repository the token could not see.
    mockGraphql.mockResolvedValue({ repository: null });

    expect((await readPullRequests()).status).toBe(
      OpenPullRequestsReadStatus.Failed
    );
  });

  it("classifies a transport failure rather than throwing it at the caller", async () => {
    mockGraphql.mockRejectedValue(new Error("boom"));

    const result = await readPullRequests();

    expect(result.status).toBe(OpenPullRequestsReadStatus.Failed);
    // Carries the page even when the error names no selection at all
    // (ISS-10438): the walk is paged, so WHICH read failed belongs in every
    // failure detail, not only in the ones that carry a GraphQL path.
    expect(result).toMatchObject({ detail: "page 0: boom" });
  });
});

describe("listPullRequestCommentPage", () => {
  function commentPageResponse(
    nodes: unknown[],
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
  ) {
    return {
      repository: { pullRequest: { comments: { pageInfo, nodes } } },
    };
  }

  it("returns the page and the cursor to continue from", async () => {
    mockGraphql.mockResolvedValue(
      commentPageResponse(
        [{ id: "IC_two", body: "second page", viewerDidAuthor: true }],
        { hasNextPage: true, endCursor: "cursor-2" }
      )
    );

    expect(
      await listPullRequestCommentPage(octokit, OWNER, REPO, 4711, "cursor-1")
    ).toEqual({
      comments: [{ id: "IC_two", body: "second page", viewerDidAuthor: true }],
      cursor: "cursor-2",
    });
  });

  it("reports a null cursor once the connection is exhausted", async () => {
    // The signal that licenses a POST: the walk finished and found nothing.
    mockGraphql.mockResolvedValue(
      commentPageResponse([], { hasNextPage: false, endCursor: "cursor-9" })
    );

    expect(
      await listPullRequestCommentPage(octokit, OWNER, REPO, 4711, "cursor-1")
    ).toEqual({ comments: [], cursor: null });
  });

  it("returns null, NOT an empty page, when the read fails", async () => {
    // An empty page means "your comment is not here" and licenses a POST. A
    // failed read means "not known" and must not — collapsing the two is how a
    // duplicate lands beside the comment the sweep already owns.
    mockGraphql.mockRejectedValue(new Error("boom"));

    expect(
      await listPullRequestCommentPage(octokit, OWNER, REPO, 4711, "cursor-1")
    ).toBeNull();
  });

  it("returns null when the connection claims another page it gives no cursor for", async () => {
    // Unreachable, and `cursor: null` downstream means "done" — so accepting it
    // would read unreachable as complete.
    mockGraphql.mockResolvedValue(
      commentPageResponse([], { hasNextPage: true, endCursor: null })
    );

    expect(
      await listPullRequestCommentPage(octokit, OWNER, REPO, 4711, "cursor-1")
    ).toBeNull();
  });
});

describe("countScheduledJobs", () => {
  it("returns the job count GitHub reports", async () => {
    mockRequest.mockResolvedValue({ data: { total_count: 7 } });

    expect(await countScheduledJobs(octokit, OWNER, REPO, 1)).toBe(7);
  });

  it("returns 0 for the never-scheduled run this signal exists to find", async () => {
    mockRequest.mockResolvedValue({ data: { total_count: 0 } });

    expect(await countScheduledJobs(octokit, OWNER, REPO, 1)).toBe(0);
  });

  it("asks for one job, since only the count is read", async () => {
    mockRequest.mockResolvedValue({ data: { total_count: 0 } });

    await countScheduledJobs(octokit, OWNER, REPO, 4242);

    expect(mockRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ run_id: 4242, per_page: 1 })
    );
  });

  it("returns null, NOT zero, when the response cannot be read", async () => {
    // Zero is the stall verdict. Reporting an unreadable probe as zero would
    // manufacture the exact failure this signal detects.
    mockRequest.mockResolvedValue({ data: { total_count: "lots" } });

    expect(await countScheduledJobs(octokit, OWNER, REPO, 1)).toBeNull();
  });

  it("returns null, NOT zero, when the request fails", async () => {
    mockRequest.mockRejectedValue(new Error("boom"));

    expect(await countScheduledJobs(octokit, OWNER, REPO, 1)).toBeNull();
  });
});
