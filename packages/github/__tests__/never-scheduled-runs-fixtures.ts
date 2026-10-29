// Shared fixtures for the two suites over `never-scheduled-runs.ts`.
//
// `never-scheduled-runs.test.ts` owns the readers' ordinary behaviour and
// `open-pull-requests-partial-read.test.ts` owns what happens when GitHub
// refuses part of an answer. Both build the same PR-node and page shapes, and
// the shape is fiddly enough — a nested rollup whose `totalCount` has to be able
// to disagree with its node count — that two hand-rolled copies would drift.

import type { Octokit } from "@octokit/rest";
import { type Mock, vi } from "vitest";
import {
  listOpenPullRequestHeads,
  type OpenPullRequestsReadResult,
  OpenPullRequestsReadStatus,
} from "../never-scheduled-runs";

export const OWNER = "acme";
export const REPO = "my-repo";
export const HEAD_SHA = "a".repeat(40);
export const OTHER_HEAD_SHA = "b".repeat(40);

/** A fresh transport per suite: `vi.fn()` state must not cross test files. */
export function createOctokitMock(): {
  request: Mock;
  graphql: Mock;
  octokit: Octokit;
} {
  const request = vi.fn();
  const graphql = vi.fn();
  return {
    request,
    graphql,
    octokit: { request, graphql } as unknown as Octokit,
  };
}

export function pullRequestNode(overrides: Record<string, unknown> = {}) {
  return {
    number: 4711,
    headRefName: "feat/thing",
    headRefOid: HEAD_SHA,
    // Non-null in GitHub's schema, and read by the readiness sweep (ISS-6018)
    // rather than by the never-scheduled derivation.
    baseRefName: "main",
    isDraft: false,
    mergeable: "MERGEABLE",
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
                ],
              },
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

export function pullRequestsResponse(
  nodes: unknown[],
  totalCount?: number,
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  }
) {
  return {
    repository: {
      pullRequests: { totalCount: totalCount ?? nodes.length, pageInfo, nodes },
    },
  };
}

export function readPullRequests(
  octokit: Octokit
): Promise<OpenPullRequestsReadResult> {
  return listOpenPullRequestHeads(octokit, OWNER, REPO);
}

export function expectOkPullRequests(result: OpenPullRequestsReadResult) {
  if (result.status !== OpenPullRequestsReadStatus.Ok) {
    throw new Error(`expected Ok, got ${result.status}: ${result.detail}`);
  }
  return result;
}

// ISS-11906 — one open PR whose head carries a required Actions check and a
// private app's check.
export const ACTIONS_APP_ID = 15_368;
/** `datadog-closedloop-ai`: private, so GitHub refuses its `CheckSuite.app` to `GITHUB_TOKEN`. */
export const PRIVATE_APP_ID = 1_398_880;
const PRIVATE_APPS = new Set([PRIVATE_APP_ID]);
const SUITE_APPS: Record<string, number> = {
  "suite-actions": ACTIONS_APP_ID,
  "suite-datadog": PRIVATE_APP_ID,
};
const CHECK_RUNS = [
  { name: "test", suite: "suite-actions" },
  { name: "Datadog PR Gates / No new flaky tests", suite: "suite-datadog" },
];
const INTEGRATION_SUITES_ALIAS =
  /(integration\d+Suites): checkSuites\(first: \d+, filterBy: \{appId: (\d+)\}\)(.*)$/gm;
const REFUSED = "Resource not accessible by integration";

/**
 * One open PR whose head carries a required Actions check and a private app's
 * check, answered as GitHub answers the query it is sent: `app` refused on the
 * private suite, and `checkSuites(filterBy: {appId})` listing only that app's.
 * It returns only the fields the query selects, so a selection the reader stops
 * sending is a field the reader stops getting. `listsNoSuites` answers every
 * `checkSuites` page empty, as a listing that under-reads would.
 */
export function privateAppGithub(options: {
  refusePrivateApps: boolean;
  listsNoSuites?: boolean;
}) {
  return (query: string): Promise<unknown> => {
    const selectsApp = query.includes(
      "checkSuite { createdAt app { databaseId } }"
    );
    const selectsSuiteId = query.includes("checkSuite { createdAt id }");
    const errors: Record<string, unknown>[] = [];
    const nodes = CHECK_RUNS.map((run, index) => {
      const appId = SUITE_APPS[run.suite] ?? 0;
      const refused = options.refusePrivateApps && PRIVATE_APPS.has(appId);
      if (selectsApp && refused) {
        errors.push({
          type: "FORBIDDEN",
          path: [
            "repository",
            "pullRequests",
            "nodes",
            0,
            "commits",
            "nodes",
            0,
            "commit",
            "statusCheckRollup",
            "contexts",
            "nodes",
            index,
            "checkSuite",
            "app",
          ],
          message: REFUSED,
        });
      }
      const identity = {
        ...(selectsApp && { app: refused ? null : { databaseId: appId } }),
        ...(selectsSuiteId && { id: run.suite }),
      };
      return {
        __typename: "CheckRun",
        name: run.name,
        conclusion: "SUCCESS",
        completedAt: "2026-10-02T14:00:00Z",
        startedAt: "2026-10-02T13:50:00Z",
        checkSuite: { createdAt: "2026-10-02T13:49:00Z", ...identity },
      };
    });
    const commit: Record<string, unknown> = {
      statusCheckRollup: { contexts: { totalCount: nodes.length, nodes } },
    };
    for (const [, alias, appId, body = ""] of query.matchAll(
      INTEGRATION_SUITES_ALIAS
    )) {
      const suites = Object.keys(SUITE_APPS).filter(
        (suite) => !options.listsNoSuites && SUITE_APPS[suite] === Number(appId)
      );
      commit[String(alias)] = {
        ...(body.includes("pageInfo { hasNextPage }") && {
          pageInfo: { hasNextPage: false },
        }),
        ...(body.includes("nodes { id }") && {
          nodes: suites.map((id) => ({ id })),
        }),
      };
    }
    const data = {
      repository: {
        pullRequests: {
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            pullRequestNode({
              commits: { nodes: [{ commit }] },
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            }),
          ],
        },
      },
    };
    if (errors.length > 0) {
      return Promise.reject(
        Object.assign(
          new Error(
            `Request failed due to following response errors:\n - ${REFUSED}`
          ),
          { data, errors }
        )
      );
    }
    return Promise.resolve(data);
  };
}
