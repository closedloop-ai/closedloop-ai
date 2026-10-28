// ISS-11906 — the rollup's integration, resolved through `Commit.checkSuites`
// instead of the `CheckSuite.app` GitHub refuses to `GITHUB_TOKEN` on a private
// app.

import { beforeEach, describe, expect, it } from "vitest";
import { resolveCheckSuiteIntegrations } from "../check-suite-integrations";
import { listOpenPullRequestHeads } from "../never-scheduled-runs";
import {
  ACTIONS_APP_ID,
  createOctokitMock,
  expectOkPullRequests,
  OWNER,
  privateAppGithub,
  REPO,
} from "./never-scheduled-runs-fixtures";

const ACTIONS = 15_368;
const VERCEL = 8329;

/** GitHub's own shapes, written as literals: a third-party payload. */
function checkRun(name: string, suiteId: string) {
  return {
    __typename: "CheckRun",
    name,
    conclusion: "SUCCESS",
    completedAt: "2026-10-02T14:00:00Z",
    startedAt: "2026-10-02T13:50:00Z",
    checkSuite: { createdAt: "2026-10-02T13:49:00Z", id: suiteId },
  };
}

function legacyCheckRun(name: string, app: { databaseId: number } | null) {
  return {
    ...checkRun(name, "unused"),
    checkSuite: { createdAt: "2026-10-02T13:49:00Z", app },
  };
}

const STATUS_CONTEXT = {
  __typename: "StatusContext",
  context: "Vercel – app-stage",
  state: "SUCCESS",
  createdAt: "2026-10-02T13:55:00Z",
  creator: { __typename: "Bot" },
};

function suitePage(ids: string[], hasNextPage = false) {
  return { pageInfo: { hasNextPage }, nodes: ids.map((id) => ({ id })) };
}

function commit(nodes: unknown[], suites: Record<string, unknown>) {
  return {
    statusCheckRollup: { contexts: { totalCount: nodes.length, nodes } },
    ...suites,
  };
}

function resolvedNodes(input: unknown): unknown {
  return (
    resolveCheckSuiteIntegrations(input) as {
      statusCheckRollup: { contexts: { nodes: unknown[] } };
    }
  ).statusCheckRollup.contexts.nodes;
}

describe("resolveCheckSuiteIntegrations", () => {
  it("names each suite's integration in the shape a readable `app` has", () => {
    const nodes = resolvedNodes(
      commit(
        [
          checkRun("test", "suite-actions"),
          checkRun("Vercel Preview Comments", "suite-vercel"),
          // A private app's suite: listed under no required integration.
          checkRun("Datadog PR Gates / No new flaky tests", "suite-datadog"),
          STATUS_CONTEXT,
        ],
        {
          integration15368Suites: suitePage(["suite-other", "suite-actions"]),
          integration8329Suites: suitePage(["suite-vercel"]),
        }
      )
    );

    expect(nodes).toEqual([
      legacyCheckRun("test", { databaseId: ACTIONS }),
      legacyCheckRun("Vercel Preview Comments", { databaseId: VERCEL }),
      legacyCheckRun("Datadog PR Gates / No new flaky tests", null),
      STATUS_CONTEXT,
    ]);
  });

  it.each([
    {
      page: "was cut",
      suites: suitePage(["suite-actions"], true),
      listed: legacyCheckRun("test", { databaseId: ACTIONS }),
    },
    {
      page: "is unreadable",
      suites: { pageInfo: { hasNextPage: false }, nodes: null },
      listed: null,
    },
    { page: "came back empty", suites: suitePage([]), listed: null },
  ])(
    "leaves a hole for an unlisted check run when a suite page $page",
    ({ suites, listed }) => {
      const nodes = resolvedNodes(
        commit(
          [
            checkRun("test", "suite-actions"),
            checkRun("lint", "suite-beyond-the-page"),
          ],
          {
            integration15368Suites: suites,
            integration8329Suites: suitePage(["suite-vercel"]),
          }
        )
      );

      expect(nodes).toEqual([listed, null]);
    }
  );

  it("leaves a rollup with no check run untouched when a suite page came back empty", () => {
    const nodes = resolvedNodes(
      commit([STATUS_CONTEXT], { integration15368Suites: suitePage([]) })
    );

    expect(nodes).toEqual([STATUS_CONTEXT]);
  });
});

describe("listOpenPullRequestHeads given integrationIds", () => {
  const { graphql, octokit } = createOctokitMock();

  beforeEach(() => {
    graphql.mockReset();
    graphql.mockImplementation(privateAppGithub({ refusePrivateApps: true }));
  });

  it("is refused on a private app's suite when it selects `app`", async () => {
    const read = expectOkPullRequests(
      await listOpenPullRequestHeads(octokit, OWNER, REPO)
    );

    expect(read.partial?.graphqlErrorCount).toBe(1);
    expect(read.pullRequests[0]?.rollupTruncated).toBe(true);
  });

  it("reads the same suite without a refusal and keeps every identity", async () => {
    const read = expectOkPullRequests(
      await listOpenPullRequestHeads(octokit, OWNER, REPO, {
        integrationIds: [ACTIONS_APP_ID],
      })
    );

    expect(read.partial).toBeNull();
    expect(read.pullRequests[0]?.rollupTruncated).toBe(false);
    expect(
      read.pullRequests[0]?.rollupContexts.map((node) =>
        node?.__typename === "CheckRun"
          ? [node.name, node.checkSuite?.app?.databaseId ?? null]
          : node
      )
    ).toEqual([
      ["test", ACTIONS_APP_ID],
      ["Datadog PR Gates / No new flaky tests", null],
    ]);
  });
});
