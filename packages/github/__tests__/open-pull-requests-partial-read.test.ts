// What the open-PR read does when GitHub refuses PART of the answer (ISS-10452).
//
// Split out of `never-scheduled-runs.test.ts`, which the salvage cases took past
// the 1,000-line ceiling: this is one responsibility — the HTTP 200 that carries
// a populated `data` AND an `errors[]` — and it is the concern
// `open-pull-requests-partial-read.ts` owns.
//
// The behaviour, and why discarding it was an outage: `octokit.graphql` throws on
// any `errors` entry, so the catch threw away every readable node with the
// refused ones — ~16 of 1,411 on 2026-09-16 took the whole read down, the stall
// gauge published nothing, and the readiness sweep failed every run.

import { beforeEach, describe, expect, it } from "vitest";
import { OpenPullRequestsReadStatus } from "../never-scheduled-runs";
import {
  createOctokitMock,
  expectOkPullRequests as expectOk,
  OTHER_HEAD_SHA,
  pullRequestNode,
  pullRequestsResponse,
  readPullRequests as readHeads,
} from "./never-scheduled-runs-fixtures";

const { graphql: mockGraphql, octokit } = createOctokitMock();

/**
 * GitHub's own words, written as literals rather than derived from anything
 * here: they are a third-party payload, and a fixture built from our own
 * constant would agree with our own mistake.
 */
const PERMISSION_ERROR_MESSAGE = "Resource not accessible by integration";
const SERVER_ABORT_MESSAGE =
  "We couldn't respond to your request in time. Sorry about that.";

/**
 * The `path` of a refused rollup CONTAINER — one level shallower than a refused
 * context node, and the case the payload cannot show, because the field is
 * nullable and comes back as the same null as "no checks yet".
 */
const REFUSED_ROLLUP_PATH = [
  "repository",
  "pullRequests",
  "nodes",
  1,
  "commits",
  "nodes",
  0,
  "commit",
  "statusCheckRollup",
];

/** The `path` of a refused rollup context node, as GitHub attributes it. */
const REFUSED_CONTEXT_PATH = [
  "repository",
  "pullRequests",
  "nodes",
  1,
  "commits",
  "nodes",
  0,
  "commit",
  "statusCheckRollup",
  "contexts",
  "nodes",
  1,
];

/**
 * What `octokit.graphql` throws on a 200 that carried `errors`: an `Error` whose
 * message concatenates the entries, with the partial `data` and the raw `errors`
 * hung off it. Re-typed here rather than imported, for the same reason as the
 * messages above.
 */
function graphqlResponseError(
  data: unknown,
  errors: readonly Record<string, unknown>[]
): Error {
  const entries = errors
    .map((entry) => ` - ${String(entry.message)}`)
    .join("\n");
  return Object.assign(
    new Error(`Request failed due to following response errors:\n${entries}`),
    { data, errors }
  );
}

function readPullRequests() {
  return readHeads(octokit);
}

function expectOkPullRequests(
  result: Awaited<ReturnType<typeof readPullRequests>>
) {
  return expectOk(result);
}

beforeEach(() => {
  mockGraphql.mockReset();
});

describe("listOpenPullRequestHeads on a partly refused answer", () => {
  it("reports no salvage on an answer GitHub did not refuse any of", async () => {
    // The unchanged path, pinned so the salvage cannot start claiming a
    // shortfall on a clean read — `partial` is what both callers report from.
    mockGraphql.mockResolvedValue(pullRequestsResponse([pullRequestNode()]));

    expect(expectOkPullRequests(await readPullRequests()).partial).toBeNull();
  });

  // ISS-10452, and the same GitHub behaviour ISS-8287 salvaged in
  // `pull-request-point-read.ts`: HTTP 200, a fully populated `data`, AND an
  // `errors[]` naming the selections it refused. `octokit.graphql` throws on the
  // errors, and discarding the throw threw every readable node away with them —
  // ~16 refused out of 1,411 on 2026-09-16 took the whole read down, so the
  // stall gauge published nothing and the readiness sweep failed every run.
  it("salvages the nodes GitHub answered when it refuses part of the page", async () => {
    mockGraphql.mockRejectedValue(
      graphqlResponseError(
        // TWO PR nodes, because the contract is per node: a one-PR fixture
        // cannot tell "kept the readable nodes" from "kept the whole page".
        pullRequestsResponse([
          pullRequestNode(),
          pullRequestNode({
            number: 4712,
            headRefOid: OTHER_HEAD_SHA,
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        totalCount: 2,
                        nodes: [
                          {
                            __typename: "CheckRun",
                            name: "typecheck",
                            conclusion: "SUCCESS",
                            completedAt: "2026-09-16T12:00:00Z",
                            startedAt: null,
                            checkSuite: { app: { databaseId: 15_368 } },
                          },
                          // GitHub nulls the selection it refused.
                          null,
                        ],
                      },
                    },
                  },
                },
              ],
            },
          }),
        ]),
        [
          {
            type: "FORBIDDEN",
            path: REFUSED_CONTEXT_PATH,
            message: PERMISSION_ERROR_MESSAGE,
          },
        ]
      )
    );

    const result = expectOkPullRequests(await readPullRequests());

    expect(result.pullRequests.map((head) => head.number)).toEqual([
      4711, 4712,
    ]);
    // The refused node reaches the consumer as a GAP, not as a healthy rollup:
    // `totalCount` stays above the readable count, which is what makes the
    // readiness verdict "cannot determine" instead of "ready to enqueue".
    expect(result.pullRequests[1]?.rollupContexts).toEqual([
      expect.objectContaining({ name: "typecheck" }),
      null,
    ]);
    expect(result.pullRequests[1]?.rollupTruncated).toBe(true);
    // The other node is untouched — salvaging must not degrade a PR GitHub
    // answered in full.
    expect(result.pullRequests[0]?.rollupTruncated).toBe(false);
    // The shortfall rides beside the reading rather than being inferred, and it
    // carries the path: every entry repeats the identical message, so the path
    // is the only field that names WHICH selection was refused.
    expect(result.partial).toEqual({
      graphqlErrorCount: 1,
      paths: [REFUSED_CONTEXT_PATH.join(".")],
    });
  });

  // whitlockk on #7440: the refusal can land on `statusCheckRollup` ITSELF, which is
  // nullable — so it arrives as the same `null` that means "no check has
  // reported yet", `rollupTruncated` stays false, and the readiness sweep
  // publishes "waiting on every required context" over a PR that may be green.
  // Only the error `path` tells the two apart.
  it("marks a head whose whole rollup GitHub refused, not just a refused context", async () => {
    mockGraphql.mockRejectedValue(
      graphqlResponseError(
        pullRequestsResponse([
          pullRequestNode(),
          pullRequestNode({
            number: 4712,
            headRefOid: OTHER_HEAD_SHA,
            // GitHub nulls the refused nullable field, which is
            // INDISTINGUISHABLE from a commit with no checks yet.
            commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
          }),
        ]),
        [
          {
            type: "FORBIDDEN",
            path: REFUSED_ROLLUP_PATH,
            message: PERMISSION_ERROR_MESSAGE,
          },
        ]
      )
    );

    const result = expectOkPullRequests(await readPullRequests());

    expect(result.pullRequests[1]?.rollupContexts).toEqual([]);
    expect(result.pullRequests[1]?.rollupTruncated).toBe(true);
    // Per head, not per page: one refused rollup must not answer Unknown for
    // every other PR GitHub did resolve.
    expect(result.pullRequests[0]?.rollupTruncated).toBe(false);
  });

  it("marks the whole page when a refusal names no node", async () => {
    // Nothing attributes it to a head, and the query has one root selection, so
    // it IS about these nodes — we just cannot say which. A confident verdict
    // over a rollup nobody saw is the failure that matters.
    mockGraphql.mockRejectedValue(
      graphqlResponseError(
        pullRequestsResponse([
          pullRequestNode(),
          pullRequestNode({ number: 4712, headRefOid: OTHER_HEAD_SHA }),
        ]),
        [{ type: "FORBIDDEN", message: PERMISSION_ERROR_MESSAGE }]
      )
    );

    const result = expectOkPullRequests(await readPullRequests());

    expect(result.pullRequests.map((head) => head.rollupTruncated)).toEqual([
      true,
      true,
    ]);
  });

  // tamsinb on #7440: `partialGraphqlEnvelopeCandidates` accepts three
  // wrappers and this package genuinely sees the nested one, but the
  // attribution read only top-level `error.errors` — so a nested payload
  // salvaged fine and came back `rollupTruncated: false`,
  // `graphqlErrorCount: 0`, no paths. The errors must come out of the SAME
  // envelope as the data.
  it("reads the errors from the wrapper the data came out of", async () => {
    mockGraphql.mockRejectedValue({
      response: {
        data: {
          data: pullRequestsResponse([
            pullRequestNode(),
            pullRequestNode({
              number: 4712,
              headRefOid: OTHER_HEAD_SHA,
              commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
            }),
          ]),
          errors: [
            {
              type: "FORBIDDEN",
              path: REFUSED_ROLLUP_PATH,
              message: PERMISSION_ERROR_MESSAGE,
            },
          ],
        },
      },
    });

    const result = expectOkPullRequests(await readPullRequests());

    expect(result.pullRequests[1]?.rollupTruncated).toBe(true);
    expect(result.pullRequests[0]?.rollupTruncated).toBe(false);
    expect(result.partial).toEqual({
      graphqlErrorCount: 1,
      paths: [REFUSED_ROLLUP_PATH.join(".")],
    });
  });

  // tamsinb on #7440: a refusal on a WHOLE node nulls the list element, and a
  // strict `z.array(OpenPullRequestSchema)` failed the entire page over it —
  // the same outage this change exists to fix, one level up.
  it("drops a PR node GitHub refused outright and reports the page incomplete", async () => {
    mockGraphql.mockRejectedValue(
      graphqlResponseError(pullRequestsResponse([pullRequestNode(), null], 2), [
        {
          type: "FORBIDDEN",
          path: ["repository", "pullRequests", "nodes", 1],
          message: PERMISSION_ERROR_MESSAGE,
        },
      ])
    );

    const result = expectOkPullRequests(await readPullRequests());

    // The readable head survives, and the missing one is NOT invented: a
    // placeholder would be matched by SHA and could demote a stuck run to
    // debris.
    expect(result.pullRequests.map((head) => head.number)).toEqual([4711]);
    // `totalCount` still counts it, so the population is reported incomplete and
    // the cron answers Unknown rather than "nothing is blocked".
    expect(result.truncated).toBe(true);
  });

  it("still fails the page on a node that is present but malformed", async () => {
    // Only a literal `null` is tolerated. A node GitHub DID return, with a field
    // this reader cannot parse, is a different fact and stays fatal.
    mockGraphql.mockResolvedValue(
      pullRequestsResponse([pullRequestNode({ headRefOid: 42 })])
    );

    expect((await readPullRequests()).status).toBe(
      OpenPullRequestsReadStatus.Malformed
    );
  });

  // tamsinb on #7440: every salvage case was single-page, so neither the
  // per-page index reset nor the cross-page count summing was pinned.
  it("resets the refused index per page and sums the counts across them", async () => {
    mockGraphql
      .mockRejectedValueOnce(
        graphqlResponseError(
          pullRequestsResponse(
            [
              pullRequestNode({
                commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
              }),
              pullRequestNode({ number: 4712, headRefOid: OTHER_HEAD_SHA }),
            ],
            4,
            { hasNextPage: true, endCursor: "cursor-1" }
          ),
          [
            {
              type: "FORBIDDEN",
              path: ["repository", "pullRequests", "nodes", 0],
              message: PERMISSION_ERROR_MESSAGE,
            },
          ]
        )
      )
      .mockRejectedValueOnce(
        graphqlResponseError(
          pullRequestsResponse(
            [
              pullRequestNode({
                number: 4713,
                headRefOid: "d".repeat(40),
                commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
              }),
              pullRequestNode({ number: 4714, headRefOid: "e".repeat(40) }),
            ],
            4
          ),
          [
            {
              type: "FORBIDDEN",
              path: ["repository", "pullRequests", "nodes", 0],
              message: PERMISSION_ERROR_MESSAGE,
            },
            {
              type: "FORBIDDEN",
              path: ["repository", "pullRequests", "nodes", 0, "commits"],
              message: PERMISSION_ERROR_MESSAGE,
            },
          ]
        )
      );

    const result = expectOkPullRequests(await readPullRequests());

    // Index 0 on page 2 is PR 4713, not PR 4711 — indexing into the accumulated
    // list instead would mark the wrong heads.
    expect(
      result.pullRequests.map((head) => [head.number, head.rollupTruncated])
    ).toEqual([
      [4711, true],
      [4712, false],
      [4713, true],
      [4714, false],
    ]);
    // 1 from page one plus 2 from page two, and the paths stay capped at three.
    expect(result.partial?.graphqlErrorCount).toBe(3);
    expect(result.partial?.paths).toHaveLength(3);
  });

  // marisolashgrove on #7440: matching a candidate on its DATA alone admitted an
  // envelope whose errors sit on a different wrapper, and the walk then
  // published `partial:true` beside "GitHub refused 0 selection(s) (no path
  // reported)" — a shortfall asserted over an answer nothing was refused in,
  // while `refusedPullRequestNodes` handed that same empty array said nothing
  // was. "Salvaged" and "something was refused" have to be one fact.
  it("refuses to call a page-shaped payload with no errors a partial read", async () => {
    mockGraphql.mockRejectedValue(
      Object.assign(new Error("something else threw"), {
        data: pullRequestsResponse([pullRequestNode()]),
        errors: [],
      })
    );

    const result = await readPullRequests();

    // NOT an Ok carrying `partial: {graphqlErrorCount: 0, paths: []}`, which
    // would put `partial:true` on the metric over an intact answer. The page
    // prefix is ISS-10438's, and no `(at …)` follows it: no entry carried a
    // path, so there is no selection to name.
    expect(result.status).toBe(OpenPullRequestsReadStatus.Failed);
    expect(result).toMatchObject({ detail: "page 0: something else threw" });
  });

  it("still fails when GitHub refuses the connection itself", async () => {
    // The server-side abort answers the same 200-plus-`errors` envelope with
    // `pullRequests` NULL. There is nothing to salvage, so it stays Failed — a
    // real read failure reported as a healthy reading would be strictly worse
    // than the bug this salvage fixes.
    mockGraphql.mockRejectedValue(
      graphqlResponseError({ repository: { pullRequests: null } }, [
        { message: SERVER_ABORT_MESSAGE },
      ])
    );

    const result = await readPullRequests();

    expect(result.status).toBe(OpenPullRequestsReadStatus.Failed);
    expect(result).toMatchObject({
      detail: expect.stringContaining(SERVER_ABORT_MESSAGE),
    });
  });

  it("names the refused selection in the detail of a failure it cannot salvage", async () => {
    // `data: null` is the no-answer case, and the message alone does not say
    // which selection GitHub refused — every entry carries the same one.
    mockGraphql.mockRejectedValue(
      graphqlResponseError(null, [
        {
          type: "FORBIDDEN",
          path: ["repository", "pullRequests"],
          message: PERMISSION_ERROR_MESSAGE,
        },
      ])
    );

    const result = await readPullRequests();

    expect(result.status).toBe(OpenPullRequestsReadStatus.Failed);
    expect(result).toMatchObject({
      detail: expect.stringContaining("(at repository.pullRequests)"),
    });
  });

  it("names the page and every refused selection a multi-entry refusal points at", async () => {
    // ISS-10438, and the case the single-entry sibling above cannot pin (raised
    // by marisolashgrove on #7409): the production refusal carries one entry PER
    // refused selection — up to OPEN_PR_PAGE_SIZE of them in one detail — and
    // every entry repeats the same message, so the format has to survive more
    // than one. Two path-bearing entries plus one without a path, asserted
    // whole: `[0]` in place of the join, a dropped separator, or an empty
    // segment emitted for the pathless entry each fail here.
    //
    // The PAGE is the other half (raised by tamsinb on #7409). GraphQL indexes
    // `nodes` within the ANSWER, so `nodes.1` names a different PR on every
    // page; the first page here succeeds and hands over a cursor so the failure
    // lands on page 1, which a hardcoded `page 0` cannot satisfy.
    const refusal = graphqlResponseError(null, [
      {
        type: "FORBIDDEN",
        path: REFUSED_ROLLUP_PATH,
        message: PERMISSION_ERROR_MESSAGE,
      },
      {
        type: "FORBIDDEN",
        path: REFUSED_CONTEXT_PATH,
        message: PERMISSION_ERROR_MESSAGE,
      },
      // No `path`: GitHub attributes some entries to the request rather than to
      // a selection, and those contribute nothing to name.
      { type: "FORBIDDEN", message: PERMISSION_ERROR_MESSAGE },
    ]);
    mockGraphql
      .mockResolvedValueOnce(
        pullRequestsResponse([pullRequestNode()], 50, {
          hasNextPage: true,
          endCursor: "cursor-1",
        })
      )
      .mockRejectedValueOnce(refusal);

    const result = await readPullRequests();

    expect(result.status).toBe(OpenPullRequestsReadStatus.Failed);
    // `refusal.message` is octokit's own flattening, reused rather than re-typed
    // because the contract here is that we PRESERVE it; everything appended to
    // it is ours and is written out literally.
    expect(result).toMatchObject({
      detail: `page 1: ${refusal.message} (at repository.pullRequests.nodes.1.commits.nodes.0.commit.statusCheckRollup, repository.pullRequests.nodes.1.commits.nodes.0.commit.statusCheckRollup.contexts.nodes.1)`,
    });
  });
});
