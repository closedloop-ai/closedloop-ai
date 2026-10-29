import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSelectedPullRequestChecksEvidence } from "../selected-pull-request-checks-evidence";
import type { SelectedPullRequestChecksOctokit } from "../selected-pull-request-client";

const HEAD_SHA = "a".repeat(40);
const OWNER = "acme";
const REPO = "widgets";
const PULL_NUMBER = 42;

const mockGet = vi.fn();
const mockGraphql = vi.fn();
const octokit: SelectedPullRequestChecksOctokit = {
  graphql: (query, parameters) => mockGraphql(query, parameters),
  rest: { pulls: { get: mockGet } },
};

describe("getSelectedPullRequestChecksEvidence branch coverage", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGraphql.mockReset();
  });

  it("counts successful, failing, and neutral outcomes separately", async () => {
    mockGet.mockResolvedValue({ data: makeMetadata() });
    mockGraphql.mockResolvedValueOnce(
      makePage([
        makeCheckRun({ id: "test-node", name: "test", conclusion: "SUCCESS" }),
        makeCheckRun({ id: "lint-node", name: "lint", conclusion: "FAILURE" }),
        makeCheckRun({ id: "docs-node", name: "docs", conclusion: "NEUTRAL" }),
      ])
    );

    const result = await acquire();

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: {
          total: 3,
          successful: 1,
          failing: 1,
          pending: 0,
          neutral: 1,
        },
      },
    });
  });

  it("returns missing immutable revision when the initial head SHA is absent, before any checks read", async () => {
    mockGet.mockResolvedValueOnce({
      data: makeMetadata({ head: { sha: null } }),
    });

    await expect(acquire()).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason:
        SelectedPullRequestEvidenceUnavailableReason.MissingImmutableRevision,
    });
    expect(mockGraphql).not.toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalledOnce();
  });

  it("returns the provider failure when the final metadata read fails after paging", async () => {
    mockGet
      .mockResolvedValueOnce({ data: makeMetadata() })
      .mockRejectedValueOnce({ status: 500, message: "boom" });
    mockGraphql.mockResolvedValueOnce(makePage([makeCheckRun()]));

    await expect(acquire()).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderUnavailable,
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("carries retryAfterSeconds from a rate-limited initial metadata read", async () => {
    mockGet.mockRejectedValueOnce({
      status: 403,
      headers: { "retry-after": "9" },
      message: "secondary rate limit",
    });

    await expect(acquire()).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderRateLimited,
      retryAfterSeconds: 9,
    });
    expect(mockGraphql).not.toHaveBeenCalled();
  });
});

function acquire() {
  return getSelectedPullRequestChecksEvidence(
    octokit,
    OWNER,
    REPO,
    PULL_NUMBER
  );
}

function makeMetadata(
  overrides: Partial<{ head: { sha: string | null } }> = {}
) {
  return {
    id: 123,
    number: PULL_NUMBER,
    html_url: "https://github.com/acme/widgets/pull/42",
    head: { sha: HEAD_SHA },
    ...overrides,
  };
}

function makePage(nodes: unknown[]) {
  return {
    repository: {
      object: {
        __typename: "Commit",
        statusCheckRollup: {
          contexts: {
            totalCount: nodes.length,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes,
          },
        },
      },
    },
  };
}

function makeCheckRun(
  overrides: Partial<{ id: string; name: string; conclusion: string }> = {}
) {
  return {
    __typename: "CheckRun",
    id: "check-node-1",
    name: "test",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    createdAt: "2026-08-04T19:58:00Z",
    startedAt: "2026-08-04T19:59:00Z",
    completedAt: "2026-08-04T20:00:00Z",
    detailsUrl: "https://github.com/acme/widgets/actions/runs/1",
    url: "https://api.github.com/repos/acme/widgets/check-runs/1",
    checkSuite: {
      app: {
        id: "app-node",
        databaseId: 7,
        slug: "ci",
        name: "CI",
        url: "https://github.com/apps/ci",
      },
    },
    ...overrides,
  };
}
