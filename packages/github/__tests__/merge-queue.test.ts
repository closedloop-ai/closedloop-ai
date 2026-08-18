import type { Octokit } from "@octokit/rest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMergeQueueState,
  getRequiredContexts,
  type MergeQueueReadResult,
  MergeQueueReadStatus,
  type RequiredContextsReadResult,
  RequiredContextsReadStatus,
} from "../merge-queue";

// Credential-agnostic by construction (the Octokit is injected), so these tests
// need no App env and no auth mocking.
const mockGraphql = vi.fn();
const octokit = { graphql: mockGraphql } as unknown as Octokit;

const OWNER = "acme";
const REPO = "my-repo";
const BRANCH = "main";

/** A well-formed response with `entries` built from committedDate strings. */
function queueResponse(committedDates: (string | null)[], totalCount?: number) {
  return {
    repository: {
      mergeQueue: {
        entries: {
          totalCount: totalCount ?? committedDates.length,
          nodes: committedDates.map((committedDate, index) => ({
            state: "AWAITING_CHECKS",
            pullRequest: { number: 100 + index },
            headCommit:
              committedDate === null
                ? null
                : {
                    committedDate,
                    oid: `oid-${index}`,
                    statusCheckRollup: null,
                  },
          })),
        },
      },
    },
  };
}

function read(): Promise<MergeQueueReadResult> {
  return getMergeQueueState(octokit, OWNER, REPO, BRANCH);
}

function expectOkState(result: MergeQueueReadResult) {
  if (result.status !== MergeQueueReadStatus.Ok) {
    throw new Error(`expected Ok, got ${result.status}: ${result.detail}`);
  }
  return result.state;
}

beforeEach(() => {
  mockGraphql.mockReset();
});

describe("getMergeQueueState", () => {
  it("returns the parsed queue for a well-formed response", async () => {
    mockGraphql.mockResolvedValue(
      queueResponse(["2026-08-05T15:00:00Z", "2026-08-05T15:30:00Z"])
    );

    const state = expectOkState(await read());

    expect(state.entries.totalCount).toBe(2);
    expect(state.entries.nodes[0].headCommit?.committedDate).toBe(
      "2026-08-05T15:00:00Z"
    );
  });

  it("preserves a null headCommit as the real state it is", async () => {
    // An entry with no group built yet is not missing data — the derivation
    // depends on telling it apart from a built one.
    mockGraphql.mockResolvedValue(queueResponse([null]));

    expect(expectOkState(await read()).entries.nodes[0].headCommit).toBeNull();
  });

  it("preserves totalCount when it exceeds the returned page", async () => {
    // The truncation guard downstream is only possible because this survives.
    mockGraphql.mockResolvedValue(queueResponse(["2026-08-05T15:00:00Z"], 137));

    const state = expectOkState(await read());

    expect(state.entries.totalCount).toBe(137);
    expect(state.entries.nodes).toHaveLength(1);
  });

  it("queries the requested repo and branch", async () => {
    mockGraphql.mockResolvedValue(queueResponse([]));

    await read();

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("mergeQueue(branch: $branch)"),
      {
        owner: OWNER,
        name: REPO,
        branch: BRANCH,
        first: 100,
        rollupFirst: 100,
      }
    );
  });

  it("reports NotConfigured when the branch has no merge queue", async () => {
    // Distinct from a read failure: the API answered, there is simply no queue
    // (or the token cannot see one).
    mockGraphql.mockResolvedValue({ repository: { mergeQueue: null } });

    const result = await read();

    expect(result.status).toBe(MergeQueueReadStatus.NotConfigured);
  });

  it("reports NotConfigured when the repository itself is null", async () => {
    mockGraphql.mockResolvedValue({ repository: null });

    expect((await read()).status).toBe(MergeQueueReadStatus.NotConfigured);
  });

  it("reports Malformed rather than a defaulted empty queue on a bad shape", async () => {
    // The failure mode this guards: a shape change that silently reads as an
    // empty queue would publish a confidently healthy zero.
    mockGraphql.mockResolvedValue({
      repository: { mergeQueue: { entries: { totalCount: "two", nodes: [] } } },
    });

    const result = await read();

    expect(result.status).toBe(MergeQueueReadStatus.Malformed);
  });

  it("reports Malformed when totalCount is smaller than the page returned", async () => {
    // The page is drawn FROM the population, so it can never exceed it.
    // Accepting this would publish a depth smaller than the set the age was
    // computed over — two metrics from one read that contradict each other.
    mockGraphql.mockResolvedValue(
      queueResponse(["2026-08-05T15:00:00Z", "2026-08-05T15:30:00Z"], 1)
    );

    expect((await read()).status).toBe(MergeQueueReadStatus.Malformed);
  });

  it("accepts totalCount equal to the page returned", async () => {
    // The boundary the refinement must not over-reject: a fully-fetched queue.
    mockGraphql.mockResolvedValue(queueResponse(["2026-08-05T15:00:00Z"], 1));

    expect((await read()).status).toBe(MergeQueueReadStatus.Ok);
  });

  it("reports Malformed when committedDate is not a datetime", async () => {
    mockGraphql.mockResolvedValue(queueResponse(["not-a-date"]));

    expect((await read()).status).toBe(MergeQueueReadStatus.Malformed);
  });

  it("names the offending field in a Malformed detail", async () => {
    mockGraphql.mockResolvedValue(queueResponse(["not-a-date"]));

    const result = await read();

    if (result.status === MergeQueueReadStatus.Ok) {
      throw new Error("expected a Malformed result");
    }
    // A bare "malformed" would leave an operator with nothing to act on.
    expect(result.detail).toContain("committedDate");
  });

  it("reports Failed instead of throwing when the API call rejects", async () => {
    mockGraphql.mockRejectedValue(new Error("Bad credentials"));

    const result = await read();

    if (result.status === MergeQueueReadStatus.Ok) {
      throw new Error("expected a Failed result");
    }
    expect(result.status).toBe(MergeQueueReadStatus.Failed);
    expect(result.detail).toContain("Bad credentials");
  });

  it("reports Failed for a non-Error rejection", async () => {
    mockGraphql.mockRejectedValue("string rejection");

    expect((await read()).status).toBe(MergeQueueReadStatus.Failed);
  });
});

// ISS-5141: the rollup and the required-context set.

const mockRequest = vi.fn();
const requestOctokit = { request: mockRequest } as unknown as Octokit;

function requiredContextsRule(
  checks: { context: unknown; integration_id?: unknown }[]
) {
  return {
    type: "required_status_checks",
    parameters: { required_status_checks: checks },
  };
}

/** A single built entry carrying an arbitrary rollup shape (ISS-5141). */
function rollupResponse(statusCheckRollup: unknown) {
  return {
    repository: {
      mergeQueue: {
        entries: {
          totalCount: 1,
          nodes: [
            {
              state: "AWAITING_CHECKS",
              pullRequest: { number: 100 },
              headCommit: {
                committedDate: "2026-08-05T15:00:00.000Z",
                oid: "abc",
                statusCheckRollup,
              },
            },
          ],
        },
      },
    },
  };
}

function readRequired(): Promise<RequiredContextsReadResult> {
  return getRequiredContexts(requestOctokit, OWNER, REPO, BRANCH);
}

function expectOkContexts(result: RequiredContextsReadResult) {
  if (result.status !== RequiredContextsReadStatus.Ok) {
    throw new Error(`expected Ok, got ${result.status}: ${result.detail}`);
  }
  return result.contexts;
}

describe("getMergeQueueState rollup parsing", () => {
  it("parses both arms of the CheckRun | StatusContext union", async () => {
    // The split is not "Actions vs Vercel" — an Actions-owned required context
    // can arrive as a StatusContext — so dropping either arm reads the required
    // set with half of it missing.
    const response = rollupResponse({
      contexts: {
        totalCount: 2,
        nodes: [
          {
            __typename: "CheckRun",
            name: "typecheck",
            conclusion: "FAILURE",
            completedAt: "2026-08-05T15:30:00.000Z",
            startedAt: null,
            checkSuite: { app: { databaseId: 15_368 } },
          },
          {
            __typename: "StatusContext",
            context: "Vercel – app-stage",
            state: "SUCCESS",
            createdAt: "2026-08-05T15:31:00.000Z",
            creator: { __typename: "Bot" },
          },
        ],
      },
    });
    mockGraphql.mockResolvedValue(response);

    const rollup = expectOkState(await read()).entries.nodes[0].headCommit
      ?.statusCheckRollup;

    expect(rollup?.contexts.nodes).toHaveLength(2);
    expect(rollup?.contexts.totalCount).toBe(2);
  });

  it("accepts an UNKNOWN conclusion rather than failing the whole read", async () => {
    // GitHub can add an enum member at any time. Rejecting the response over one
    // unknown value would take the age and depth gauges down with it.
    const response = rollupResponse({
      contexts: {
        totalCount: 1,
        nodes: [
          {
            __typename: "CheckRun",
            name: "typecheck",
            conclusion: "SOME_FUTURE_STATE",
            completedAt: null,
            startedAt: null,
            checkSuite: null,
          },
        ],
      },
    });
    mockGraphql.mockResolvedValue(response);

    expect((await read()).status).toBe(MergeQueueReadStatus.Ok);
  });

  it("accepts a NULL databaseId rather than failing the whole read", async () => {
    // `App.databaseId` is a nullable Int in GitHub's schema. Parsing it as a
    // required number would fail MergeQueueResponseSchema over one null on one
    // CheckRun in one entry, taking age and depth down with it — not just the
    // required-context match that is the only thing needing the id.
    const response = rollupResponse({
      contexts: {
        totalCount: 1,
        nodes: [
          {
            __typename: "CheckRun",
            name: "typecheck",
            conclusion: "FAILURE",
            completedAt: "2026-08-05T15:30:00.000Z",
            startedAt: null,
            checkSuite: { app: { databaseId: null } },
          },
        ],
      },
    });
    mockGraphql.mockResolvedValue(response);

    const state = expectOkState(await read());

    // The two gauges the strictness would have taken down: depth reads
    // entries.totalCount, age reads the built head commit's committedDate.
    expect(state.entries.totalCount).toBe(1);
    expect(state.entries.nodes[0].headCommit?.committedDate).toBe(
      "2026-08-05T15:00:00.000Z"
    );
    expect(state.entries.nodes[0].headCommit?.statusCheckRollup).toBeTruthy();
  });

  it("asks for the rollup and the entry state in the query it sends", async () => {
    // The timestamps and the integration id cannot be dropped as unused fields:
    // without them attempts cannot be ordered and a required context cannot be
    // told from a same-named impostor. Nothing downstream can catch their
    // removal, because the fixtures supply whatever the query asks for.
    mockGraphql.mockResolvedValue(queueResponse([]));

    await read();

    const query = mockGraphql.mock.calls[0][0] as string;
    for (const field of [
      "statusCheckRollup",
      "completedAt",
      "startedAt",
      "createdAt",
      "databaseId",
      "creator",
      "state",
      "oid",
    ]) {
      expect(query).toContain(field);
    }
  });
});

describe("getRequiredContexts", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("returns the {context, integrationId} pairs from the ruleset", async () => {
    mockRequest.mockResolvedValue({
      data: [
        { type: "pull_request" },
        requiredContextsRule([
          { context: "typecheck", integration_id: 15_368 },
          { context: "Vercel – app-stage", integration_id: 8329 },
        ]),
      ],
    });

    expect(expectOkContexts(await readRequired())).toEqual([
      { context: "typecheck", integrationId: 15_368 },
      { context: "Vercel – app-stage", integrationId: 8329 },
    ]);
  });

  it("returns an empty set when the branch has no required-status-checks rule", async () => {
    // Empty is reported honestly rather than as an error; the CALLER decides
    // that nothing to intersect against means the answer is unknown.
    mockRequest.mockResolvedValue({ data: [{ type: "pull_request" }] });

    expect(expectOkContexts(await readRequired())).toEqual([]);
  });

  it("rejects a malformed entry instead of skipping it", async () => {
    // A blank context or a non-numeric integration id matches nothing, which
    // would silently empty the required set while the caller went on to publish
    // a confident "nothing is failing".
    mockRequest.mockResolvedValue({
      data: [requiredContextsRule([{ context: "", integration_id: 15_368 }])],
    });

    expect((await readRequired()).status).toBe(
      RequiredContextsReadStatus.Malformed
    );
  });

  it("rejects a non-numeric integration id", async () => {
    mockRequest.mockResolvedValue({
      data: [
        requiredContextsRule([
          { context: "typecheck", integration_id: "15368" },
        ]),
      ],
    });

    expect((await readRequired()).status).toBe(
      RequiredContextsReadStatus.Malformed
    );
  });

  it("rejects a rules payload that is not an array", async () => {
    mockRequest.mockResolvedValue({ data: { rules: [] } });

    expect((await readRequired()).status).toBe(
      RequiredContextsReadStatus.Malformed
    );
  });

  it("reports Failed instead of throwing when the request rejects", async () => {
    mockRequest.mockRejectedValue(new Error("403"));

    const result = await readRequired();

    expect(result.status).toBe(RequiredContextsReadStatus.Failed);
    expect(
      result.status !== RequiredContextsReadStatus.Ok && result.detail
    ).toContain("403");
  });

  it("follows pages until a short one, and merges what it found", async () => {
    const fullPage = Array.from({ length: 100 }, () => ({
      type: "pull_request",
    }));
    fullPage[0] = requiredContextsRule([
      { context: "typecheck", integration_id: 15_368 },
    ]);
    mockRequest
      .mockResolvedValueOnce({ data: fullPage })
      .mockResolvedValueOnce({
        data: [
          requiredContextsRule([
            { context: "e2e-gate", integration_id: 15_368 },
          ]),
        ],
      });

    expect(expectOkContexts(await readRequired())).toEqual([
      { context: "typecheck", integrationId: 15_368 },
      { context: "e2e-gate", integrationId: 15_368 },
    ]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it("reports Failed rather than a partial set when the pages never end", async () => {
    // A partial set understates what is required, which would under-report a
    // real failure. Reporting it as unreadable is the safe direction.
    mockRequest.mockResolvedValue({
      data: Array.from({ length: 100 }, () => ({ type: "pull_request" })),
    });

    expect((await readRequired()).status).toBe(
      RequiredContextsReadStatus.Failed
    );
  });

  it("reads the rules for the branch it was asked about", async () => {
    mockRequest.mockResolvedValue({ data: [] });

    await readRequired();

    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringContaining("/rules/branches/"),
      expect.objectContaining({ owner: OWNER, repo: REPO, branch: BRANCH })
    );
  });
});

describe("the rollup sub-tree cannot fail the primary read (ISS-5141 follow-up)", () => {
  it("drops a null rollup node instead of failing the whole response", async () => {
    // The rollup exists only for failed_groups, but it is parsed inside the
    // same schema that gates age and depth. Strict parsing let this secondary
    // sub-tree return Malformed for the entire tick, which suppressed the
    // paging gauges — the coupling this file's comments promise cannot happen.
    mockGraphql.mockResolvedValue(
      rollupResponse({ contexts: { totalCount: 2, nodes: [null] } })
    );

    const state = expectOkState(await read());
    const rollup = state.entries.nodes[0].headCommit?.statusCheckRollup;

    expect(rollup?.contexts.nodes).toEqual([null]);
    // totalCount is the SERVER's count and is never recomputed from the
    // survivors, so the hole still reads as a gap downstream rather than as a
    // complete, clean page.
    expect(rollup?.contexts.totalCount).toBe(2);
  });

  it("drops an unrecognized __typename instead of failing the whole response", async () => {
    // GitHub can add a third StatusCheckRollupContext member at any time.
    mockGraphql.mockResolvedValue(
      rollupResponse({
        contexts: {
          totalCount: 1,
          nodes: [{ __typename: "SomeFutureContext", whatever: true }],
        },
      })
    );

    expect((await read()).status).toBe(MergeQueueReadStatus.Ok);
  });

  it("survives a malformed rollup CONTAINER, not just a bad node", async () => {
    // codex: tolerating bad NODES was not enough — a malformed container still
    // failed the whole response and took age and depth down. It degrades to a
    // synthetic gap rather than to null, because null is the legitimate "no
    // checks reported yet" state and would have read as CLEAN.
    mockGraphql.mockResolvedValue(
      rollupResponse({ contexts: { totalCount: "1", nodes: [] } })
    );

    const state = expectOkState(await read());
    const rollup = state.entries.nodes[0].headCommit?.statusCheckRollup;

    expect(state.entries.nodes[0].headCommit?.committedDate).toBe(
      "2026-08-05T15:00:00.000Z"
    );
    // Presents as one context we could not see, which downstream reads as a gap.
    expect(rollup?.contexts.totalCount).toBe(1);
    expect(rollup?.contexts.nodes).toEqual([]);
  });

  it("keeps a genuinely absent rollup distinct from an unreadable one", async () => {
    // A commit with no checks yet is a real, complete reading of zero.
    mockGraphql.mockResolvedValue(rollupResponse(null));

    const state = expectOkState(await read());

    expect(state.entries.nodes[0].headCommit?.statusCheckRollup).toBeNull();
  });

  it("keeps age readable when the rollup is unparseable", async () => {
    // The property that matters: the primary signal survives.
    mockGraphql.mockResolvedValue(
      rollupResponse({ contexts: { totalCount: 1, nodes: ["not-an-object"] } })
    );

    const state = expectOkState(await read());

    expect(state.entries.nodes[0].headCommit?.committedDate).toBe(
      "2026-08-05T15:00:00.000Z"
    );
  });
});

describe("getRequiredContexts tolerates an optional integration_id", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("accepts a rule with integration_id ABSENT", async () => {
    // GitHub documents the field as optional. Rejecting it turned one such rule
    // into a permanently omitted gauge for the whole branch.
    mockRequest.mockResolvedValue({
      data: [requiredContextsRule([{ context: "ci/build" }])],
    });

    expect(expectOkContexts(await readRequired())).toEqual([
      { context: "ci/build", integrationId: null },
    ]);
  });

  it("accepts a rule with integration_id NULL", async () => {
    mockRequest.mockResolvedValue({
      data: [
        requiredContextsRule([{ context: "ci/build", integration_id: null }]),
      ],
    });

    expect(expectOkContexts(await readRequired())).toEqual([
      { context: "ci/build", integrationId: null },
    ]);
  });

  it("still rejects a blank context, which really would match nothing", async () => {
    mockRequest.mockResolvedValue({
      data: [requiredContextsRule([{ context: "" }])],
    });

    expect((await readRequired()).status).toBe(
      RequiredContextsReadStatus.Malformed
    );
  });
});
