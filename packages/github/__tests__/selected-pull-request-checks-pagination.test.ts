/**
 * The page loop owns decisions the evidence entry point cannot reach through
 * its own metadata reads and deadline wrapper: a first page that is unusable,
 * a cancellation observed only after a page already resolved, and the partial
 * payload recovery performed on a rejected request. Driving the reader
 * directly pins those without a second provider round trip standing in the way.
 */
import { SelectedPullRequestChecksPartialReason } from "@repo/api/src/types/selected-pull-request-checks-evidence";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSelectedPullRequestCheckContexts } from "../selected-pull-request-checks-pagination";
import type { SelectedPullRequestChecksOctokit } from "../selected-pull-request-client";

const HEAD_SHA = "a".repeat(40);
const OWNER = "acme";
const REPO = "widgets";

const mockGet = vi.fn();
const mockGraphql = vi.fn();
const octokit: SelectedPullRequestChecksOctokit = {
  graphql: (query, parameters) => mockGraphql(query, parameters),
  rest: { pulls: { get: mockGet } },
};

describe("readSelectedPullRequestCheckContexts", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGraphql.mockReset();
  });

  it.each([
    [
      "a missing selected revision",
      { repository: { object: null } },
      SelectedPullRequestEvidenceUnavailableReason.SelectedRevisionMissingOrInaccessible,
    ],
    [
      "a malformed envelope",
      {},
      SelectedPullRequestEvidenceUnavailableReason.MalformedResponse,
    ],
  ])(
    "returns unavailable when the first page carries %s",
    async (_label, page, reason) => {
      mockGraphql.mockResolvedValueOnce(page);

      await expect(read()).resolves.toEqual({
        status: SelectedPullRequestEvidenceAvailability.Unavailable,
        reason,
      });
    }
  );

  it("keeps earlier rows when a later page drops the rollup", async () => {
    mockGraphql
      .mockResolvedValueOnce(
        makePage({
          totalCount: 2,
          hasNextPage: true,
          endCursor: "next",
          nodes: [makeCheckRun()],
        })
      )
      .mockResolvedValueOnce({
        repository: {
          object: { __typename: "Commit", statusCheckRollup: null },
        },
      });

    await expect(read()).resolves.toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        checks: [{ providerId: "check-node-1" }],
        pagesFetched: 1,
        reasons: [SelectedPullRequestChecksPartialReason.ProviderPageFailure],
        interruption: {
          reason:
            SelectedPullRequestEvidenceUnavailableReason.MalformedResponse,
        },
      },
    });
  });

  it("flags a final page shorter than the promised total count", async () => {
    mockGraphql.mockResolvedValueOnce(
      makePage({ totalCount: 3, nodes: [makeCheckRun()] })
    );

    await expect(read()).resolves.toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        providerExpected: 3,
        providerReturned: 1,
        normalizedAttempts: 1,
        reasons: [SelectedPullRequestChecksPartialReason.CountMismatch],
      },
    });
  });

  it("flags a check run with no owning app as an ambiguous source", async () => {
    mockGraphql.mockResolvedValueOnce(
      makePage({
        totalCount: 1,
        nodes: [{ ...makeCheckRun(), checkSuite: null }],
      })
    );

    await expect(read()).resolves.toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        checks: [{ sourceApp: null }],
        reasons: [SelectedPullRequestChecksPartialReason.AmbiguousSource],
      },
    });
  });

  it("returns unavailable when the caller cancels before the first page", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(read(controller.signal)).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
    });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("discards a first page that resolves after the caller cancelled", async () => {
    const controller = new AbortController();
    mockGraphql.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(
        makePage({ totalCount: 1, nodes: [makeCheckRun()] })
      );
    });

    await expect(read(controller.signal)).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
    });
    expect(mockGraphql).toHaveBeenCalledOnce();
  });

  it("recovers a partial page nested under the rejected response", async () => {
    mockGraphql.mockRejectedValueOnce(
      Object.assign(new Error("graphql request failed"), {
        response: {
          data: {
            data: makePage({ totalCount: 1, nodes: [makeCheckRun()] }),
          },
        },
      })
    );

    await expect(read()).resolves.toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        checks: [{ providerId: "check-node-1" }],
        providerReturned: 1,
        reasons: [SelectedPullRequestChecksPartialReason.ProviderPageFailure],
        interruption: {
          reason: SelectedPullRequestEvidenceUnavailableReason.ProviderFailure,
        },
      },
    });
  });

  it("discards recoverable partial data when the error envelope is malformed", async () => {
    // pins current behavior; looks odd because the usable `data` payload is
    // dropped only because the sibling `response` field is not an object.
    mockGraphql.mockRejectedValueOnce(
      Object.assign(new Error("graphql request failed"), {
        data: makePage({ totalCount: 1, nodes: [makeCheckRun()] }),
        response: "gone",
      })
    );

    await expect(read()).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderFailure,
    });
  });
});

function read(signal: AbortSignal = new AbortController().signal) {
  return readSelectedPullRequestCheckContexts(
    octokit,
    OWNER,
    REPO,
    HEAD_SHA,
    signal
  );
}

function makePage({
  totalCount = 0,
  hasNextPage = false,
  endCursor = null,
  nodes = [],
}: {
  totalCount?: number;
  hasNextPage?: boolean;
  endCursor?: string | null;
  nodes?: unknown[];
} = {}) {
  return {
    repository: {
      object: {
        __typename: "Commit",
        statusCheckRollup: {
          contexts: {
            totalCount,
            pageInfo: { hasNextPage, endCursor },
            nodes,
          },
        },
      },
    },
  };
}

function makeCheckRun() {
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
  };
}
