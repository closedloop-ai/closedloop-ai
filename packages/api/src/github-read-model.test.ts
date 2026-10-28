import { describe, expect, it } from "vitest";
import {
  buildBundledPullRequestsVariables,
  bundledPullRequestsReachedWatermark,
  GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE,
  GITHUB_BUNDLED_PULL_REQUESTS_MAX_PAGE_SIZE,
  GITHUB_BUNDLED_PULL_REQUESTS_QUERY,
  isPullRequestMerged,
  mapBundledPullRequestsResponse,
  mapRateLimitBudget,
  mergeBundledPullRequestsResults,
  normalizeGitHubFetchCredentialType,
  normalizeGitHubFetchMechanism,
  normalizeGitHubFetchTrigger,
  normalizeGitHubSyncResultReason,
  resolveMergedPullRequestState,
} from "./github-read-model";
import { ChecksStatus, ReviewDecision } from "./types/branch-checks";
import { GitHubPRState } from "./types/github";
import type { GitHubReadModelPullRequest } from "./types/github-read-model";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubProviderBudgetState,
  GitHubReadModelSource,
  GitHubSyncResultReason,
} from "./types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "./types/repository-default-identity";

describe("github read model", () => {
  it("selects rateLimit budget metadata in the bundled query", () => {
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("rateLimit");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("cost");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("remaining");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("resetAt");
  });

  it("selects merged pull requests and REST database IDs in the bundled query", () => {
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain(
      "states: [OPEN, CLOSED, MERGED]"
    );
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("databaseId");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("headRepository");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("nameWithOwner");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("defaultBranchRef");
  });

  it("maps a fork head repository and its custom default independently", () => {
    const result = mapBundledPullRequestsResponse(
      {
        repository: {
          pullRequests: {
            nodes: [
              {
                id: "PR_fork",
                number: 46,
                url: "https://github.com/base/repo/pull/46",
                baseRefName: "main",
                headRefName: "feature",
                headRepository: {
                  databaseId: 987,
                  nameWithOwner: "Contributor/Fork",
                  defaultBranchRef: { name: "develop" },
                },
              },
            ],
          },
        },
      },
      GitHubReadModelSource.Provider,
      observationContext()
    );

    expect(result.pullRequests[0]?.headRepository).toEqual(
      expect.objectContaining({
        repository: {
          provider: "github",
          providerRepositoryId: "987",
          fullName: "contributor/fork",
        },
        evidence: {
          availability: RepositoryDefaultAvailability.Available,
          completeness: "complete",
          defaultBranch: "develop",
        },
        provenance: expect.objectContaining({
          source: RepositoryDefaultSource.PullRequestGraphql,
          observationKey: "graphql-attempt:1",
        }),
      })
    );
    expect(
      result.pullRequests[0]?.headRepository?.repository.fullName
    ).not.toBe("base/repo");
  });

  it("keeps nullable head repositories typed without substituting the base", () => {
    const result = mapBundledPullRequestsResponse(
      {
        repository: {
          pullRequests: {
            nodes: [
              {
                id: "PR_deleted_fork",
                number: 47,
                url: "https://github.com/base/repo/pull/47",
                baseRefName: "main",
                headRefName: "feature",
                headRepository: null,
              },
            ],
          },
        },
      },
      GitHubReadModelSource.Provider,
      observationContext()
    );

    expect(result.pullRequests[0]).not.toHaveProperty("headRepository");
    expect(result.pullRequests[0]?.headRepositoryUnavailable).toEqual(
      expect.objectContaining({
        reason: RepositoryDefaultReason.NotReported,
        provenance: expect.objectContaining({
          observationKey: "graphql-attempt:1",
          source: RepositoryDefaultSource.PullRequestGraphql,
        }),
      })
    );
  });

  it("maps a missing head default to unavailable without inferring main", () => {
    const result = mapBundledPullRequestsResponse(
      {
        repository: {
          pullRequests: {
            nodes: [
              {
                id: "PR_no_default",
                number: 48,
                url: "https://github.com/base/repo/pull/48",
                headRepository: {
                  databaseId: 654,
                  nameWithOwner: "contributor/fork",
                  defaultBranchRef: null,
                },
              },
            ],
          },
        },
      },
      GitHubReadModelSource.Provider,
      observationContext()
    );

    expect(result.pullRequests[0]?.headRepository?.evidence).toEqual({
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: "unavailable",
      reason: RepositoryDefaultReason.NotReported,
    });
    expect(result.pullRequests[0]?.headRepository?.evidence).not.toHaveProperty(
      "defaultBranch"
    );
  });

  it("classifies malformed head identity with its acquisition provenance", () => {
    const result = mapBundledPullRequestsResponse(
      {
        repository: {
          pullRequests: {
            nodes: [
              {
                id: "PR_malformed_head",
                number: 50,
                url: "https://github.com/base/repo/pull/50",
                headRepository: {
                  databaseId: null,
                  nameWithOwner: "contributor/fork",
                  defaultBranchRef: { name: "trunk" },
                },
              },
            ],
          },
        },
      },
      GitHubReadModelSource.Provider,
      observationContext()
    );

    expect(result.pullRequests[0]?.headRepositoryUnavailable).toEqual(
      expect.objectContaining({
        reason: RepositoryDefaultReason.Malformed,
        provenance: expect.objectContaining({
          observationKey: "graphql-attempt:1",
        }),
      })
    );
  });

  it("omits the additive head snapshot for legacy callers without context", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_legacy_context",
              number: 49,
              url: "https://github.com/base/repo/pull/49",
              headRepository: {
                databaseId: 111,
                nameWithOwner: "contributor/fork",
                defaultBranchRef: { name: "trunk" },
              },
            },
          ],
        },
      },
    });

    expect(result.pullRequests[0]).not.toHaveProperty("headRepository");
    expect(result.pullRequests[0]).not.toHaveProperty(
      "headRepositoryUnavailable"
    );
  });

  it("selects cursor pageInfo and builds bounded page variables", () => {
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("$pageSize: Int!");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("after: $after");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("pageInfo");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("hasNextPage");
    expect(buildBundledPullRequestsVariables("acme", "repo", [])).toEqual({
      owner: "acme",
      repo: "repo",
      // ISS-7891: asserted through the constant, because the default moved off
      // GitHub's 100-node ceiling to stay inside its ~10s execution budget.
      pageSize: GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE,
    });
    expect(
      buildBundledPullRequestsVariables("acme", "repo", [], {
        after: "cursor-1",
        pageSize: 500,
      })
    ).toEqual({
      owner: "acme",
      repo: "repo",
      // An over-large explicit request still clamps to GitHub's own ceiling,
      // which the smaller default did not change.
      pageSize: GITHUB_BUNDLED_PULL_REQUESTS_MAX_PAGE_SIZE,
      after: "cursor-1",
    });
    expect(
      buildBundledPullRequestsVariables("acme", "repo", [], {
        after: null,
      })
    ).not.toHaveProperty("after");
  });

  it("maps PR lifecycle, review, check, LOC, and budget fields", () => {
    const result = mapBundledPullRequestsResponse({
      rateLimit: {
        cost: 3,
        remaining: 249,
        resetAt: "2026-07-03T01:00:00Z",
      },
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          nodes: [
            {
              id: "PR_kwDO1",
              databaseId: 424_242,
              number: 42,
              title: "Ship it",
              url: "https://github.com/acme/repo/pull/42",
              state: GitHubPRState.Closed,
              isDraft: false,
              additions: 10,
              deletions: 4,
              changedFiles: 2,
              reviewDecision: ReviewDecision.Approved,
              createdAt: "2026-07-01T12:00:00Z",
              mergedAt: "2026-07-02T01:00:00Z",
              closedAt: "2026-07-02T01:00:00Z",
              baseRefName: "main",
              headRefName: "feature",
              headRefOid: "abc123",
              mergeCommit: { oid: "merge-sha" },
              author: { login: "octo" },
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: { state: "SUCCESS" },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    });

    expect(result.rateLimit.state).toBe(GitHubProviderBudgetState.Low);
    expect(result).toEqual(
      expect.objectContaining({
        hasMore: true,
        nextCursor: "cursor-1",
        stopReason: GitHubBundledPullRequestsStopReason.PageLimit,
        truncated: true,
      })
    );
    expect(result.pullRequests).toEqual([
      expect.objectContaining({
        number: 42,
        githubId: "424242",
        state: GitHubPRState.Merged,
        checksStatus: ChecksStatus.Passing,
        reviewDecision: ReviewDecision.Approved,
        additions: 10,
        deletions: 4,
        changedFiles: 2,
        openedAt: "2026-07-01T12:00:00Z",
      }),
    ]);
  });

  it("normalizes zero-time PR creation timestamps from provider payloads", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_zero",
              number: 44,
              url: "https://github.com/acme/repo/pull/44",
              createdAt: "0001-01-01T00:00:00Z",
            },
          ],
        },
      },
    });

    expect(result.pullRequests[0]?.openedAt).toBeNull();
  });

  it("falls back to the GraphQL node ID when a REST database ID is absent", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_legacy",
              number: 45,
              url: "https://github.com/acme/repo/pull/45",
            },
          ],
        },
      },
    });

    expect(result.pullRequests[0]?.githubId).toBe("PR_legacy");
  });

  it("uses GitHub state first when connected and local state otherwise", () => {
    expect(
      isPullRequestMerged({
        connected: true,
        githubState: GitHubPRState.Merged,
        localState: GitHubPRState.Open,
      })
    ).toBe(true);
    expect(
      isPullRequestMerged({
        connected: false,
        githubState: GitHubPRState.Open,
        localState: GitHubPRState.Merged,
      })
    ).toBe(true);
  });

  it("falls back safely for unknown PR state, review decision, and check rollup", () => {
    const result = mapBundledPullRequestsResponse({
      rateLimit: null,
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_unknown",
              number: 43,
              url: "https://github.com/acme/repo/pull/43",
              state: "SURPRISE",
              reviewDecision: "CONFUSED",
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: { state: "MYSTERY" },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    });

    expect(result.rateLimit.state).toBe(GitHubProviderBudgetState.Unknown);
    expect(result.pullRequests).toEqual([
      expect.objectContaining({
        checksStatus: null,
        reviewDecision: null,
        state: GitHubPRState.Open,
      }),
    ]);
  });

  it("handles missing repository payloads and non-finite budget values", () => {
    const result = mapBundledPullRequestsResponse({
      rateLimit: { cost: Number.NaN, remaining: Number.POSITIVE_INFINITY },
      repository: null,
    });

    expect(result.pullRequests).toEqual([]);
    expect(result.rateLimit).toEqual({
      cost: null,
      remaining: null,
      resetAt: null,
      state: GitHubProviderBudgetState.Unknown,
    });
    expect(mapRateLimitBudget(null).state).toBe(
      GitHubProviderBudgetState.Unknown
    );
  });

  it("merges paged bundled PR results and reports missing target numbers", () => {
    const first = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          nodes: [
            {
              id: "PR_1",
              number: 1,
              url: "https://github.com/acme/repo/pull/1",
            },
          ],
        },
      },
    });
    const second = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "PR_101",
              number: 101,
              url: "https://github.com/acme/repo/pull/101",
            },
          ],
        },
      },
    });

    expect(
      mergeBundledPullRequestsResults([first, second], {
        maxPages: 2,
        targetNumbers: [101, 202],
      })
    ).toEqual(
      expect.objectContaining({
        fetchedPages: 2,
        hasMore: false,
        missingTargetNumbers: [202],
        stopReason: GitHubBundledPullRequestsStopReason.Complete,
        truncated: false,
      })
    );
  });

  it("throws when a paged bundled PR merge has no explicit or derived stop reason", () => {
    const page = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          nodes: [
            {
              id: "PR_1",
              number: 1,
              url: "https://github.com/acme/repo/pull/1",
            },
          ],
        },
      },
    });

    expect(() =>
      mergeBundledPullRequestsResults([page], {
        maxItems: 100,
        maxPages: 2,
        targetNumbers: [202],
      })
    ).toThrow("Unable to resolve bundled pull requests stop reason");
  });

  it("accepts known GitHub provenance values", () => {
    expect(
      normalizeGitHubFetchCredentialType(GitHubFetchCredentialType.GitHubApp)
    ).toBe(GitHubFetchCredentialType.GitHubApp);
    expect(normalizeGitHubFetchMechanism(GitHubFetchMechanism.Graphql)).toBe(
      GitHubFetchMechanism.Graphql
    );
    expect(normalizeGitHubFetchTrigger(GitHubFetchTrigger.Webhook)).toBe(
      GitHubFetchTrigger.Webhook
    );
    expect(
      normalizeGitHubSyncResultReason(GitHubSyncResultReason.Success)
    ).toBe(GitHubSyncResultReason.Success);
  });

  it("normalizes unknown, null, and absent GitHub provenance values", () => {
    expect(normalizeGitHubFetchCredentialType("future_credential")).toBe(
      GitHubFetchCredentialType.Unknown
    );
    expect(normalizeGitHubFetchMechanism(null)).toBe(
      GitHubFetchMechanism.Unknown
    );
    expect(normalizeGitHubFetchTrigger(undefined)).toBe(
      GitHubFetchTrigger.Unknown
    );
    expect(normalizeGitHubSyncResultReason({ reason: "future" })).toBe(
      GitHubSyncResultReason.Unknown
    );
  });
});

describe("mapPullRequestNode filtering", () => {
  it("drops provider nodes missing an id, a numeric number, or a URL", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: null,
              number: 60,
              url: "https://github.com/acme/repo/pull/60",
            },
            {
              id: "PR_no_number",
              number: null,
              url: "https://github.com/acme/repo/pull/61",
            },
            { id: "PR_no_url", number: 62, url: null },
            {
              id: "PR_valid",
              number: 63,
              url: "https://github.com/acme/repo/pull/63",
            },
          ],
        },
      },
    });

    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0]?.number).toBe(63);
  });
});

describe("resolveMergedPullRequestState", () => {
  it("falls back to localState when connected but githubState is absent", () => {
    expect(
      resolveMergedPullRequestState({
        connected: true,
        githubState: undefined,
        localState: GitHubPRState.Merged,
      })
    ).toBe(GitHubPRState.Merged);
  });

  it("falls back to githubState when disconnected and localState is absent", () => {
    expect(
      resolveMergedPullRequestState({
        connected: false,
        githubState: GitHubPRState.Closed,
        localState: undefined,
      })
    ).toBe(GitHubPRState.Closed);
  });

  it("returns null when neither localState nor githubState is available", () => {
    expect(
      resolveMergedPullRequestState({
        connected: false,
        githubState: null,
        localState: null,
      })
    ).toBeNull();
  });
});

describe("mapProviderPullRequestState via the raw GraphQL state field", () => {
  it("maps an OPEN state without a mergedAt timestamp to Open", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_state_open",
              number: 200,
              url: "https://github.com/acme/repo/pull/200",
              state: GitHubPRState.Open,
            },
          ],
        },
      },
    });

    expect(result.pullRequests[0]?.state).toBe(GitHubPRState.Open);
  });

  it("maps a MERGED state without a mergedAt timestamp to Merged", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_state_merged",
              number: 201,
              url: "https://github.com/acme/repo/pull/201",
              state: GitHubPRState.Merged,
            },
          ],
        },
      },
    });

    expect(result.pullRequests[0]?.state).toBe(GitHubPRState.Merged);
  });

  it("maps a CLOSED state without a mergedAt timestamp to Closed", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_state_closed",
              number: 202,
              url: "https://github.com/acme/repo/pull/202",
              state: GitHubPRState.Closed,
            },
          ],
        },
      },
    });

    expect(result.pullRequests[0]?.state).toBe(GitHubPRState.Closed);
  });
});

describe("mapProviderReviewDecision via the raw GraphQL reviewDecision field", () => {
  it("maps CHANGES_REQUESTED to ChangesRequested", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_review_changes",
              number: 210,
              url: "https://github.com/acme/repo/pull/210",
              reviewDecision: ReviewDecision.ChangesRequested,
            },
          ],
        },
      },
    });

    expect(result.pullRequests[0]?.reviewDecision).toBe(
      ReviewDecision.ChangesRequested
    );
  });

  it("maps COMMENTED to Commented", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_review_commented",
              number: 211,
              url: "https://github.com/acme/repo/pull/211",
              reviewDecision: ReviewDecision.Commented,
            },
          ],
        },
      },
    });

    expect(result.pullRequests[0]?.reviewDecision).toBe(
      ReviewDecision.Commented
    );
  });

  it("maps DISMISSED to Dismissed", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_review_dismissed",
              number: 212,
              url: "https://github.com/acme/repo/pull/212",
              reviewDecision: ReviewDecision.Dismissed,
            },
          ],
        },
      },
    });

    expect(result.pullRequests[0]?.reviewDecision).toBe(
      ReviewDecision.Dismissed
    );
  });
});

describe("mapProviderChecksStatus via the raw statusCheckRollup state", () => {
  function checksStatusForRollupState(state: string) {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: `PR_checks_${state}`,
              number: 220,
              url: "https://github.com/acme/repo/pull/220",
              commits: {
                nodes: [{ commit: { statusCheckRollup: { state } } }],
              },
            },
          ],
        },
      },
    });
    return result.pullRequests[0]?.checksStatus;
  }

  it("maps FAILURE to Failing", () => {
    expect(checksStatusForRollupState("FAILURE")).toBe(ChecksStatus.Failing);
  });

  it("maps ERROR to Failing", () => {
    expect(checksStatusForRollupState("ERROR")).toBe(ChecksStatus.Failing);
  });

  it("maps PENDING to Pending", () => {
    expect(checksStatusForRollupState("PENDING")).toBe(ChecksStatus.Pending);
  });

  it("maps EXPECTED to Pending", () => {
    expect(checksStatusForRollupState("EXPECTED")).toBe(ChecksStatus.Pending);
  });
});

describe("resolveBudgetState boundary", () => {
  it("classifies remaining budget just above the low-budget ceiling as available", () => {
    expect(
      mapRateLimitBudget({ remaining: 251, cost: 1, resetAt: null }).state
    ).toBe(GitHubProviderBudgetState.Available);
  });

  it("classifies remaining budget at exactly the low-budget ceiling as low", () => {
    expect(
      mapRateLimitBudget({ remaining: 250, cost: 1, resetAt: null }).state
    ).toBe(GitHubProviderBudgetState.Low);
  });
});

describe("mapGraphqlHeadRepository zod validation edge cases", () => {
  it("classifies a slash-less head repository full name as malformed", () => {
    const result = mapBundledPullRequestsResponse(
      {
        repository: {
          pullRequests: {
            nodes: [
              {
                id: "PR_bad_fullname",
                number: 80,
                url: "https://github.com/base/repo/pull/80",
                headRepository: {
                  databaseId: 222,
                  nameWithOwner: "noslash",
                  defaultBranchRef: { name: "main" },
                },
              },
            ],
          },
        },
      },
      GitHubReadModelSource.Provider,
      observationContext()
    );

    expect(result.pullRequests[0]?.headRepositoryUnavailable).toEqual(
      expect.objectContaining({ reason: RepositoryDefaultReason.Malformed })
    );
    expect(result.pullRequests[0]).not.toHaveProperty("headRepository");
  });

  it("omits both head snapshot fields when the caller-supplied context itself fails validation", () => {
    const result = mapBundledPullRequestsResponse(
      {
        repository: {
          pullRequests: {
            nodes: [
              {
                id: "PR_invalid_context",
                number: 81,
                url: "https://github.com/base/repo/pull/81",
                headRepository: null,
              },
            ],
          },
        },
      },
      GitHubReadModelSource.Provider,
      {
        mechanism: GitHubFetchMechanism.Unknown,
        trigger: GitHubFetchTrigger.Backfill,
        credentialType: GitHubFetchCredentialType.GitHubApp,
        observationKey: "graphql-attempt:2",
        observedAt: "2026-08-10T20:00:00.000Z",
      }
    );

    // pins current behavior; looks odd because an unknown fetch mechanism in
    // the caller-supplied context makes the unavailable observation fail its
    // own zod validation, so the PR silently loses both headRepository and
    // headRepositoryUnavailable instead of surfacing the acquisition error.
    expect(result.pullRequests[0]).not.toHaveProperty("headRepository");
    expect(result.pullRequests[0]).not.toHaveProperty(
      "headRepositoryUnavailable"
    );
  });
});

function observationContext() {
  return {
    mechanism: GitHubFetchMechanism.Graphql,
    trigger: GitHubFetchTrigger.Backfill,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observationKey: "graphql-attempt:1",
    observedAt: "2026-08-10T20:00:00.000Z",
  };
}

describe("bundledPullRequestsReachedWatermark", () => {
  const pr = (updatedAt: string | null): GitHubReadModelPullRequest => ({
    githubId: "1",
    number: 1,
    title: "PR",
    htmlUrl: "https://github.com/acme/widgets/pull/1",
    headBranch: "feature",
    baseBranch: "main",
    headSha: null,
    state: GitHubPRState.Merged,
    isDraft: false,
    additions: null,
    deletions: null,
    changedFiles: null,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: null,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt,
    author: null,
    source: GitHubReadModelSource.Provider,
  });

  it("is false while every row is newer than the watermark", () => {
    expect(
      bundledPullRequestsReachedWatermark(
        [pr("2026-08-25T00:00:00Z"), pr("2026-08-24T00:00:00Z")],
        "2026-08-20T00:00:00Z"
      )
    ).toBe(false);
  });

  it("is true as soon as one row is at or older than the watermark", () => {
    expect(
      bundledPullRequestsReachedWatermark(
        [pr("2026-08-25T00:00:00Z"), pr("2026-08-20T00:00:00Z")],
        "2026-08-20T00:00:00Z"
      )
    ).toBe(true);
  });

  it("never stops on a row whose position it cannot establish", () => {
    // Truncating a gap-repair read on an unplaceable row would silently drop
    // every PR behind it.
    expect(
      bundledPullRequestsReachedWatermark(
        [pr(null), pr("not-a-date")],
        "2026-08-20T00:00:00Z"
      )
    ).toBe(false);
  });

  it("never stops when there is no watermark to compare against", () => {
    expect(
      bundledPullRequestsReachedWatermark([pr("2019-01-01T00:00:00Z")], null)
    ).toBe(false);
    expect(
      bundledPullRequestsReachedWatermark(
        [pr("2019-01-01T00:00:00Z")],
        "not-a-date"
      )
    ).toBe(false);
  });
});
