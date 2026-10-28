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
import { log } from "@repo/observability/log";
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

  // ISS-10489: a nested `response.data.data` payload keeps its errors at
  // `response.data.errors`, so counting `error.errors` logged 0 for it.
  it("logs the error count of the envelope it recovered", async () => {
    vi.mocked(log.warn).mockClear();
    mockGraphql.mockRejectedValueOnce(
      Object.assign(new Error("Request failed due to response errors"), {
        response: {
          data: {
            data: {
              repository: {
                object: { __typename: "Commit", statusCheckRollup: null },
              },
            },
            errors: [
              { message: "Could not resolve one GraphQL field" },
              { message: "Could not resolve another GraphQL field" },
            ],
          },
        },
      })
    );

    const result = await queryStatusCheckRollupWithProviderResult(
      octokit,
      OWNER,
      REPO,
      VALID_SHA
    );

    expect(expectSuccessValue(result).ok).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Recovered rollup from partial GraphQL data"),
      expect.objectContaining({ graphqlErrorCount: 2 })
    );
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

describe("queryStatusCheckRollupWithProviderResult rollup mapping", () => {
  beforeEach(() => {
    mockGraphql.mockReset();
  });

  // Pins current behavior; looks odd because the same missing repository
  // resolves to Success with GraphqlError when GitHub returns it without
  // throwing ("wraps graphql_error in a Success result when the repository is
  // missing" above). Octokit rejects with partial data when the repository
  // does not resolve, so this is the production path, and it lands on the
  // retryable ProviderUnavailable status instead.
  it("returns ProviderUnavailable when partial GraphQL data carries a null repository", async () => {
    mockGraphql.mockRejectedValueOnce(
      Object.assign(new Error("Request failed due to response errors"), {
        data: { repository: null },
        errors: [{ message: "Could not resolve to a Repository" }],
      })
    );

    await expect(
      queryStatusCheckRollupWithProviderResult(octokit, OWNER, REPO, VALID_SHA)
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
  });

  it("returns no checks when the rollup has no contexts connection", async () => {
    mockGraphql.mockResolvedValueOnce(rollupResponse(null));

    expect(await querySuccess()).toEqual({
      ok: true,
      state: "PENDING",
      checks: [],
      totalCount: 0,
      truncated: false,
    });
  });

  it("falls back to the mapped check count when a truncated page omits totalCount", async () => {
    mockGraphql.mockResolvedValueOnce(
      rollupResponse({
        pageInfo: { hasNextPage: true },
        nodes: [
          null,
          {
            __typename: "StatusContext",
            context: "ci/one",
            state: "SUCCESS",
            createdAt: OBSERVED_AT,
            targetUrl: null,
          },
        ],
      })
    );

    const value = await querySuccess();

    expect(value).toMatchObject({ ok: true, totalCount: 1, truncated: true });
  });

  it("names unnamed nodes and falls back from detailsUrl to url", async () => {
    mockGraphql.mockResolvedValueOnce(
      rollupResponse({
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            __typename: "CheckRun",
            id: "node-1",
            name: null,
            status: "COMPLETED",
            conclusion: "SUCCESS",
            startedAt: null,
            completedAt: OBSERVED_AT,
            detailsUrl: null,
            url: "https://github.com/acme/widgets/runs/1",
          },
          {
            __typename: "StatusContext",
            context: null,
            state: "SUCCESS",
            createdAt: OBSERVED_AT,
            targetUrl: null,
          },
        ],
      })
    );

    const value = await querySuccess();
    if (!value.ok) {
      throw new Error("Expected ok rollup");
    }

    expect(value.checks.map((check) => [check.kind, check.name])).toEqual([
      [BranchViewCheckKind.CheckRun, "Unnamed check"],
      [BranchViewCheckKind.StatusContext, "Unnamed status context"],
    ]);
    expect(value.checks[0]?.targetUrl).toBe(
      "https://github.com/acme/widgets/runs/1"
    );
  });

  it.each([
    ["check run first", ["CheckRun", "StatusContext"]],
    ["status context first", ["StatusContext", "CheckRun"]],
  ])(
    "keeps the check run over a same-name same-time status context (%s)",
    async (_label, order) => {
      const nodes = order.map((typename) =>
        typename === "CheckRun"
          ? {
              __typename: "CheckRun",
              id: "node-ci",
              name: "ci",
              status: "COMPLETED",
              conclusion: "FAILURE",
              startedAt: null,
              completedAt: OBSERVED_AT,
              detailsUrl: null,
              url: null,
            }
          : {
              __typename: "StatusContext",
              context: "ci",
              state: "SUCCESS",
              createdAt: OBSERVED_AT,
              targetUrl: null,
            }
      );
      mockGraphql.mockResolvedValueOnce(
        rollupResponse({ pageInfo: { hasNextPage: false }, nodes })
      );

      const value = await querySuccess();
      if (!value.ok) {
        throw new Error("Expected ok rollup");
      }

      expect(value.checks).toHaveLength(1);
      expect(value.checks[0]).toMatchObject({
        kind: BranchViewCheckKind.CheckRun,
        providerNodeId: "node-ci",
        position: 0,
      });
    }
  );

  it("keeps the later check run when two same-name runs share a timestamp", async () => {
    const run = (id: string, conclusion: string) => ({
      __typename: "CheckRun",
      id,
      name: "build",
      status: "COMPLETED",
      conclusion,
      startedAt: null,
      completedAt: OBSERVED_AT,
      detailsUrl: null,
      url: null,
    });
    mockGraphql.mockResolvedValueOnce(
      rollupResponse({
        pageInfo: { hasNextPage: false },
        nodes: [run("node-first", "FAILURE"), run("node-second", "SUCCESS")],
      })
    );

    const value = await querySuccess();
    if (!value.ok) {
      throw new Error("Expected ok rollup");
    }

    expect(value.checks).toHaveLength(1);
    expect(value.checks[0]?.providerNodeId).toBe("node-second");
  });
});

const OBSERVED_AT = "2026-09-01T00:00:00Z";

function rollupResponse(contexts: unknown) {
  return {
    repository: {
      object: {
        __typename: "Commit",
        statusCheckRollup: { state: "PENDING", contexts },
      },
    },
  };
}

async function querySuccess(): Promise<StatusCheckRollupResult> {
  return expectSuccessValue(
    await queryStatusCheckRollupWithProviderResult(
      octokit,
      OWNER,
      REPO,
      VALID_SHA
    )
  );
}
