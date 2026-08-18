import { BranchViewCheckKind } from "@repo/api/src/types/branch-view";
import { StatusCheckRollupFailureReason } from "@repo/api/src/types/github-status";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import type { Octokit } from "@octokit/rest";
import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
  queryStatusCheckRollupWithProviderResult,
  type StatusCheckRollupResult,
} from "../index";

// The function is credential-agnostic (PLN-1525 step 4): callers inject the
// Octokit, so the tests do too — no App env, no auth mocking.
const mockGraphql = vi.fn();

const octokit = { graphql: mockGraphql } as unknown as Octokit;

const VALID_SHA = "a".repeat(40);
const OWNER = "acme";
const REPO = "my-repo";

function expectSuccessValue(
  result: GitHubProviderResult<StatusCheckRollupResult>
): StatusCheckRollupResult {
  if (result.status !== GitHubProviderResultStatus.Success) {
    throw new Error(`Expected a Success provider result, got ${result.status}`);
  }
  return result.value;
}

describe("queryStatusCheckRollupWithProviderResult", () => {
  beforeEach(() => {
    mockGraphql.mockReset();
  });

  it("wraps invalid_input in a Success result when owner is empty", async () => {
    const result = await queryStatusCheckRollupWithProviderResult(
      octokit,
      "",
      REPO,
      VALID_SHA
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: {
        ok: false,
        reason: StatusCheckRollupFailureReason.InvalidInput,
      },
    });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("wraps invalid_input in a Success result when repo is empty", async () => {
    const result = await queryStatusCheckRollupWithProviderResult(
      octokit,
      OWNER,
      "",
      VALID_SHA
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: {
        ok: false,
        reason: StatusCheckRollupFailureReason.InvalidInput,
      },
    });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("wraps invalid_input in a Success result when commit SHA is not 40 characters", async () => {
    const result = await queryStatusCheckRollupWithProviderResult(
      octokit,
      OWNER,
      REPO,
      "abc123"
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: {
        ok: false,
        reason: StatusCheckRollupFailureReason.InvalidInput,
      },
    });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("returns aggregate state and normalized check contexts on success", async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: {
        object: {
          __typename: "Commit",
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: {
              totalCount: 3,
              pageInfo: { hasNextPage: true },
              nodes: [
                {
                  __typename: "CheckRun",
                  id: "node-1",
                  name: "  test   suite ",
                  status: "completed",
                  conclusion: "success",
                  detailsUrl: "https://github.com/acme/repo/runs/1",
                  url: "https://api.github.com/runs/1",
                },
                {
                  __typename: "StatusContext",
                  context: "deploy",
                  state: "pending",
                  targetUrl: "javascript:alert(1)",
                },
                {
                  __typename: "UnknownContext",
                },
              ],
            },
          },
        },
      },
    });

    const result = await queryStatusCheckRollupWithProviderResult(
      octokit,
      OWNER,
      REPO,
      VALID_SHA
    );

    const value = expectSuccessValue(result);
    expect(value).toMatchObject({
      ok: true,
      state: "SUCCESS",
      totalCount: 3,
      truncated: true,
      checks: [
        {
          kind: BranchViewCheckKind.CheckRun,
          name: "test suite",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          targetUrl: "https://github.com/acme/repo/runs/1",
          providerNodeId: "node-1",
          position: 0,
        },
        {
          kind: BranchViewCheckKind.StatusContext,
          name: "deploy",
          status: "PENDING",
          conclusion: null,
          targetUrl: null,
          providerNodeId: null,
          position: 1,
        },
      ],
    });
    expect(value.ok && value.checks[0]?.id.startsWith("node:")).toBe(true);
    expect(value.ok && value.checks[1]?.id.startsWith("context:")).toBe(true);
    expect(mockGraphql).toHaveBeenCalledOnce();
  });

  it("recovers valid partial rollup data when GitHub returns GraphQL errors", async () => {
    mockGraphql.mockRejectedValueOnce(
      Object.assign(new Error("Request failed due to response errors"), {
        data: {
          repository: {
            object: {
              __typename: "Commit",
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  totalCount: 2,
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    {
                      __typename: "CheckRun",
                      id: "node-failing-e2e",
                      name: "e2e",
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                      detailsUrl: "https://github.com/acme/repo/actions/runs/1",
                      url: "https://github.com/acme/repo/runs/1",
                    },
                    {
                      __typename: "StatusContext",
                      context: "Vercel - app-stage",
                      state: "SUCCESS",
                      targetUrl: "https://vercel.com/acme/app-stage/1",
                    },
                  ],
                },
              },
            },
          },
        },
        errors: [{ message: "Could not resolve one GraphQL field" }],
      })
    );

    const result = await queryStatusCheckRollupWithProviderResult(
      octokit,
      OWNER,
      REPO,
      VALID_SHA
    );

    const value = expectSuccessValue(result);
    expect(value).toMatchObject({
      ok: true,
      state: "FAILURE",
      totalCount: 2,
      truncated: false,
      checks: [
        {
          kind: BranchViewCheckKind.CheckRun,
          name: "e2e",
          conclusion: "FAILURE",
          targetUrl: "https://github.com/acme/repo/actions/runs/1",
        },
        {
          kind: BranchViewCheckKind.StatusContext,
          name: "Vercel - app-stage",
          status: "SUCCESS",
          targetUrl: "https://vercel.com/acme/app-stage/1",
        },
      ],
    });
  });

  it("returns an empty success when statusCheckRollup is null", async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: {
        object: {
          __typename: "Commit",
          statusCheckRollup: null,
        },
      },
    });

    const result = await queryStatusCheckRollupWithProviderResult(
      octokit,
      OWNER,
      REPO,
      VALID_SHA
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: {
        ok: true,
        state: null,
        checks: [],
        totalCount: 0,
        truncated: false,
      },
    });
  });

  it("ignores check runs without stable ids and deduplicates historical check contexts", async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: {
        object: {
          __typename: "Commit",
          statusCheckRollup: {
            state: "PENDING",
            contexts: {
              totalCount: 5,
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  __typename: "CheckRun",
                  id: " ",
                  name: "missing id",
                  status: null,
                  conclusion: null,
                  detailsUrl: null,
                  url: null,
                },
                {
                  __typename: "CheckRun",
                  id: "old-node-test-suite",
                  name: "test suite",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  startedAt: "2026-05-14T21:01:00Z",
                  completedAt: "2026-05-14T21:03:00Z",
                  detailsUrl: "https://example.com/old-check-run",
                  url: null,
                },
                {
                  __typename: "CheckRun",
                  id: "new-node-test-suite",
                  name: "test suite",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  startedAt: "2026-05-28T20:25:00Z",
                  completedAt: "2026-05-28T20:26:00Z",
                  detailsUrl: "https://example.com/new-check-run",
                  url: null,
                },
                {
                  __typename: "StatusContext",
                  context: "ci/build",
                  state: "SUCCESS",
                  targetUrl: "https://example.com/ci",
                  createdAt: "2026-05-14T21:02:00Z",
                },
                {
                  __typename: "StatusContext",
                  context: "ci/build",
                  state: "FAILURE",
                  targetUrl: "https://example.com/ci-2",
                  createdAt: "2026-05-28T20:27:00Z",
                },
              ],
            },
          },
        },
      },
    });

    const result = await queryStatusCheckRollupWithProviderResult(
      octokit,
      OWNER,
      REPO,
      VALID_SHA
    );

    const value = expectSuccessValue(result);
    expect(value.ok && value.checks).toHaveLength(2);
    expect(value).toMatchObject({
      ok: true,
      totalCount: 2,
      truncated: false,
      checks: [
        {
          kind: BranchViewCheckKind.CheckRun,
          name: "test suite",
          conclusion: "FAILURE",
          targetUrl: "https://example.com/new-check-run",
          providerNodeId: "new-node-test-suite",
          position: 0,
        },
        {
          kind: BranchViewCheckKind.StatusContext,
          name: "ci/build",
          status: "FAILURE",
          targetUrl: "https://example.com/ci-2",
          providerNodeId: null,
          position: 1,
        },
      ],
    });
  });

  it("returns provider_rate_limit when a rate limit error is thrown", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("API rate limit exceeded"));

    const result = await queryStatusCheckRollupWithProviderResult(
      octokit,
      OWNER,
      REPO,
      VALID_SHA
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: null,
    });
  });

  it("wraps graphql_error in a Success result when the repository is missing", async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: null,
    });

    const result = await queryStatusCheckRollupWithProviderResult(
      octokit,
      OWNER,
      REPO,
      VALID_SHA
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: {
        ok: false,
        reason: StatusCheckRollupFailureReason.GraphqlError,
      },
    });
  });

  it("wraps graphql_error in a Success result when the commit object is missing or not a Commit", async () => {
    mockGraphql
      .mockResolvedValueOnce({
        repository: {
          object: null,
        },
      })
      .mockResolvedValueOnce({
        repository: {
          object: { __typename: "Blob" },
        },
      });

    await expect(
      queryStatusCheckRollupWithProviderResult(octokit, OWNER, REPO, VALID_SHA)
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.Success,
      value: {
        ok: false,
        reason: StatusCheckRollupFailureReason.GraphqlError,
      },
    });
    await expect(
      queryStatusCheckRollupWithProviderResult(octokit, OWNER, REPO, VALID_SHA)
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.Success,
      value: {
        ok: false,
        reason: StatusCheckRollupFailureReason.GraphqlError,
      },
    });
  });

  it("returns provider_unavailable when a non-rate-limit 403 error is thrown", async () => {
    const error = Object.assign(new Error("Forbidden"), { status: 403 });
    mockGraphql.mockRejectedValueOnce(error);

    const result = await queryStatusCheckRollupWithProviderResult(
      octokit,
      OWNER,
      REPO,
      VALID_SHA
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
  });

  it("returns provider_unavailable when a generic error is thrown", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("Unexpected GraphQL failure"));

    const result = await queryStatusCheckRollupWithProviderResult(
      octokit,
      OWNER,
      REPO,
      VALID_SHA
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
  });
});
