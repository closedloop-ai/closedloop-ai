import type { Octokit } from "@octokit/rest";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  GitHubProviderResultStatus,
  getRepositoryPullRequestsWithMetadata,
  getSinglePullRequestWithProviderResult,
  queryBundledPullRequestsWithProviderResult,
} from "../index";
import { GITHUB_PULL_REQUEST_REST_API_VERSION } from "../pull-request-rest";

const mockPullsGet = vi.fn();
const mockGraphql = vi.fn();
const octokit = {
  graphql: mockGraphql,
  rest: { pulls: { get: mockPullsGet } },
} as unknown as Octokit;

const AUTHORITY_OBSERVATION = {
  credentialOwnerId: "11111111-1111-4111-8111-111111111111",
  observationKey: "rest-attempt-1",
  observedAt: "2026-08-10T20:00:00.000Z",
  credentialType: GitHubFetchCredentialType.UserOAuth,
  trigger: GitHubFetchTrigger.UserAction,
} as const;

describe("Pull Request REST repository-default authority", () => {
  beforeEach(() => {
    mockPullsGet.mockReset();
    mockGraphql.mockReset();
  });

  it("maps the fork head repository and its custom default independently from base", async () => {
    mockPullsGet.mockResolvedValueOnce({ data: makePullRequest() });

    const result = await getSinglePullRequestWithProviderResult(
      octokit,
      "base-owner",
      "widget",
      42,
      AUTHORITY_OBSERVATION
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: expect.objectContaining({
        baseBranch: "release",
        headRepository: {
          repository: {
            provider: VcsProviderKind.GitHub,
            providerRepositoryId: "222",
            fullName: "fork-owner/widget",
          },
          evidence: {
            availability: RepositoryDefaultAvailability.Available,
            completeness: RepositoryDefaultCompleteness.Complete,
            defaultBranch: "trunk",
          },
          provenance: {
            source: RepositoryDefaultSource.PullRequestRest,
            mechanism: "rest",
            trigger: GitHubFetchTrigger.UserAction,
            credentialType: GitHubFetchCredentialType.UserOAuth,
            credentialOwnerId: "11111111-1111-4111-8111-111111111111",
            observationKey: "rest-attempt-1",
            observedAt: "2026-08-10T20:00:00.000Z",
          },
        },
      }),
    });
    expect(mockPullsGet).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          "X-GitHub-Api-Version": GITHUB_PULL_REQUEST_REST_API_VERSION,
        },
      })
    );
  });

  it("reports a deleted or inaccessible head repository without substituting base", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: makePullRequest({ headRepository: null }),
    });

    const result = await getSinglePullRequestWithProviderResult(
      octokit,
      "base-owner",
      "widget",
      42,
      AUTHORITY_OBSERVATION
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: expect.objectContaining({
        headRepositoryUnavailable: {
          reason: RepositoryDefaultReason.NotReported,
          provenance: expect.objectContaining({
            observationKey: "rest-attempt-1",
          }),
        },
      }),
    });
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value).not.toHaveProperty("headRepository");
    }
  });

  it("classifies malformed head identity without persisting a plausible authority", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: makePullRequest({ headFullName: "widget" }),
    });

    const result = await getSinglePullRequestWithProviderResult(
      octokit,
      "base-owner",
      "widget",
      42,
      AUTHORITY_OBSERVATION
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: expect.objectContaining({
        headRepositoryUnavailable: expect.objectContaining({
          reason: RepositoryDefaultReason.Malformed,
        }),
      }),
    });
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value).not.toHaveProperty("headRepository");
    }
  });

  it("keeps a missing default typed unavailable and never infers main or the base branch", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: makePullRequest({ headDefaultBranch: null }),
    });

    const result = await getSinglePullRequestWithProviderResult(
      octokit,
      "base-owner",
      "widget",
      42,
      AUTHORITY_OBSERVATION
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: expect.objectContaining({
        headRepository: expect.objectContaining({
          evidence: {
            availability: RepositoryDefaultAvailability.Unavailable,
            completeness: RepositoryDefaultCompleteness.Unavailable,
            reason: RepositoryDefaultReason.NotReported,
          },
        }),
      }),
    });
  });

  it("classifies a malformed reported default without retaining its value", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: makePullRequest({ headDefaultBranch: "   " }),
    });

    const result = await getSinglePullRequestWithProviderResult(
      octokit,
      "base-owner",
      "widget",
      42,
      AUTHORITY_OBSERVATION
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: expect.objectContaining({
        headRepository: expect.objectContaining({
          evidence: {
            availability: RepositoryDefaultAvailability.Unavailable,
            completeness: RepositoryDefaultCompleteness.Unavailable,
            reason: RepositoryDefaultReason.Malformed,
          },
        }),
      }),
    });
  });

  it("preserves omission for legacy callers without acquisition metadata", async () => {
    mockPullsGet.mockResolvedValueOnce({ data: makePullRequest() });

    const result = await getSinglePullRequestWithProviderResult(
      octokit,
      "base-owner",
      "widget",
      42
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value).not.toHaveProperty("headRepository");
      expect(result.value).not.toHaveProperty("headRepositoryUnavailable");
    }
  });
});

describe("bundled GraphQL repository-default authority", () => {
  it("threads one caller-stable acquisition context through provider mapping", async () => {
    mockGraphql.mockResolvedValueOnce({
      rateLimit: { cost: 1, remaining: 5000, resetAt: null },
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "PR_42",
              databaseId: 42,
              number: 42,
              title: "Fork change",
              url: "https://github.com/base-owner/widget/pull/42",
              state: "OPEN",
              headRefName: "feature",
              baseRefName: "release",
              headRepository: {
                databaseId: 222,
                nameWithOwner: "fork-owner/widget",
                defaultBranchRef: { name: "trunk" },
              },
            },
          ],
        },
      },
    });

    const result = await queryBundledPullRequestsWithProviderResult(
      octokit,
      "base-owner",
      "widget",
      [42],
      {},
      undefined,
      {
        mechanism: GitHubFetchMechanism.Graphql,
        trigger: GitHubFetchTrigger.Backfill,
        credentialType: GitHubFetchCredentialType.GitHubApp,
        credentialOwnerId: "11111111-1111-4111-8111-111111111111",
        observationKey: "graphql-attempt-1",
        observedAt: "2026-08-10T20:00:00.000Z",
      }
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: expect.objectContaining({
        pullRequests: [
          expect.objectContaining({
            headRepository: expect.objectContaining({
              repository: {
                provider: VcsProviderKind.GitHub,
                providerRepositoryId: "222",
                fullName: "fork-owner/widget",
              },
              evidence: expect.objectContaining({ defaultBranch: "trunk" }),
              provenance: expect.objectContaining({
                observationKey: "graphql-attempt-1",
              }),
            }),
          }),
        ],
      }),
    });
  });

  it("carries fork-head authority through the production repository list mapper", async () => {
    mockGraphql.mockResolvedValueOnce({
      rateLimit: { cost: 1, remaining: 5000, resetAt: null },
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "PR_42",
              databaseId: 42,
              number: 42,
              title: "Fork change",
              url: "https://github.com/base-owner/widget/pull/42",
              state: "OPEN",
              headRefName: "feature",
              baseRefName: "release",
              headRepository: {
                databaseId: 222,
                nameWithOwner: "fork-owner/widget",
                defaultBranchRef: { name: "trunk" },
              },
            },
            {
              id: "PR_43",
              databaseId: 43,
              number: 43,
              title: "Deleted fork change",
              url: "https://github.com/base-owner/widget/pull/43",
              state: "OPEN",
              headRefName: "deleted-feature",
              baseRefName: "release",
              headRepository: null,
            },
          ],
        },
      },
    });
    const context = {
      mechanism: GitHubFetchMechanism.Graphql,
      trigger: GitHubFetchTrigger.SurfaceOpen,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: "graphql-live-list-1",
      observedAt: "2026-08-10T20:00:00.000Z",
    } as const;

    const result = await getRepositoryPullRequestsWithMetadata(
      octokit,
      "base-owner",
      "widget",
      { state: "all", limit: 30 },
      undefined,
      context
    );

    expect(result.pullRequests[0]).toEqual(
      expect.objectContaining({
        baseBranch: "release",
        headRepository: expect.objectContaining({
          repository: {
            provider: VcsProviderKind.GitHub,
            providerRepositoryId: "222",
            fullName: "fork-owner/widget",
          },
          evidence: expect.objectContaining({ defaultBranch: "trunk" }),
          provenance: expect.objectContaining(context),
        }),
      })
    );
    expect(result.pullRequests[1]).toEqual(
      expect.objectContaining({
        baseBranch: "release",
        headRepositoryUnavailable: {
          reason: RepositoryDefaultReason.NotReported,
          provenance: expect.objectContaining(context),
        },
      })
    );
    expect(result.pullRequests[1]).not.toHaveProperty("headRepository");
  });
});

type PullRequestFixtureOptions = {
  headRepository?: object | null;
  headFullName?: string;
  headDefaultBranch?: string | null;
};

function makePullRequest(options: PullRequestFixtureOptions = {}) {
  const headRepository =
    options.headRepository === undefined
      ? {
          id: 222,
          full_name: options.headFullName ?? "fork-owner/widget",
          default_branch:
            options.headDefaultBranch === undefined
              ? "trunk"
              : options.headDefaultBranch,
        }
      : options.headRepository;

  return {
    id: 111,
    number: 42,
    title: "Fork change",
    html_url: "https://github.com/base-owner/widget/pull/42",
    state: "open",
    draft: false,
    created_at: "2026-08-10T19:00:00Z",
    merged_at: null,
    closed_at: null,
    merge_commit_sha: null,
    additions: 2,
    deletions: 1,
    changed_files: 1,
    user: { login: "fork-author" },
    head: {
      ref: "feature",
      sha: "head-sha",
      repo: headRepository,
    },
    base: {
      ref: "release",
      sha: "base-sha",
      repo: {
        id: 111,
        full_name: "base-owner/widget",
        default_branch: "release",
      },
    },
  };
}
