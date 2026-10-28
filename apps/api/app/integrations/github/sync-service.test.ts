import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ArtifactType: {
      BRANCH: "BRANCH",
      SESSION: "SESSION",
    },
    GitHubInstallationStatus: {
      ACTIVE: "ACTIVE",
    },
  });
});

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return {
    ...actual,
    getSinglePullRequestWithProviderResult: vi.fn(),
  };
});

vi.mock("@repo/github/user-token-auth", () => ({
  getUserTokenOctokit: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
  },
}));

const persistPullRequestLifecycleActivityMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/branches/pull-request-lifecycle-activity", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/branches/pull-request-lifecycle-activity")
  >("@/app/branches/pull-request-lifecycle-activity");
  return {
    ...actual,
    persistPullRequestLifecycleActivityInTransaction:
      persistPullRequestLifecycleActivityMock,
  };
});

vi.mock("@/app/branches/pull-request-author-identity", () => ({
  ensurePullRequestAuthorIdentity: vi.fn(),
}));

import { GitHubActorType } from "@repo/api/src/types/github-actor";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { clerkClient } from "@repo/auth/server";
import {
  GitHubProviderResultStatus,
  GitHubUserTokenProviderResultStatus,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { log } from "@repo/observability/log";
import {
  actorUserId,
  branchArtifactId,
  createMockDb,
  makeBranchTarget,
  makeProviderPullRequest,
  makePullRequestDetailRow,
  makeSessionPrLink,
  makeUserConnection,
  now,
  organizationId,
} from "@/__tests__/support/integrations/github/sync-service.test-fixtures";
import { mockWithDbAll } from "@/__tests__/utils/db-helpers";
import { ensurePullRequestAuthorIdentity } from "@/app/branches/pull-request-author-identity";
import {
  GitHubServerSyncReason,
  GitHubServerSyncStatus,
  githubServerSyncService,
} from "./sync-service";

/**
 * The provider repository identity every guarded write on this lane keys on.
 * Written out here rather than imported from the production helper, because an
 * assertion that imports the value under test compares it against itself.
 */
const TOMBSTONED_REPOSITORY_WHERE = {
  removedAt: { not: null },
  githubRepoId: "gh-repo-1",
} as const;

// Marker object the mocked user-token factory returns; the unified single-PR
// read must receive it as its first argument (PLN-1525 step 4).
const userTokenOctokit = { kind: "user-token-octokit" };
const mockGetUserTokenOctokit = getUserTokenOctokit as ReturnType<typeof vi.fn>;
const mockClerkClient = clerkClient as unknown as ReturnType<typeof vi.fn>;

describe("githubServerSyncService", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    wireClerkToken(["repo"]);
    mockDb = createMockDb();
    mockWithDbAll(mockDb);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchTarget());
    mockDb.artifactLink.findFirst.mockResolvedValue(makeSessionPrLink());
    mockDb.gitHubUserConnection.findUnique.mockResolvedValue(
      makeUserConnection()
    );
    mockDb.gitHubUserConnection.updateMany.mockResolvedValue({ count: 1 });
    mockDb.pullRequestDetail.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mockDb.branchDetail.updateMany.mockResolvedValue({ count: 1 });
    persistPullRequestLifecycleActivityMock.mockResolvedValue(undefined);
    mockGetUserTokenOctokit.mockReturnValue(userTokenOctokit);
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: makeProviderPullRequest(),
    });
  });

  it("does not use user OAuth as overflow for App-covered repositories", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchTarget({ removedAt: null })
    );

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.NotApplicable,
      reason: GitHubServerSyncReason.NoTombstonedRepository,
    });
    expect(mockDb.gitHubUserConnection.findUnique).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("does not use user OAuth for inactive repositories that are not tombstoned", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchTarget({
        installationStatus: "SUSPENDED",
        removedAt: null,
      })
    );

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubSyncResultReason.NoActiveRepository,
    });
    expect(mockDb.gitHubUserConnection.findUnique).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("denies cross-user user-token sync without an owned session PR reference", async () => {
    mockDb.artifactLink.findFirst.mockResolvedValue(null);

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubSyncResultReason.NoEligibleSessionReference,
    });
    expect(mockDb.artifactLink.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            {
              OR: expect.arrayContaining([
                {
                  metadata: {
                    path: ["linkKind"],
                    equals: SessionArtifactLinkKind.SessionPr,
                  },
                },
                {
                  metadata: {
                    path: ["linkKinds"],
                    array_contains: [SessionArtifactLinkKind.SessionPrSet],
                  },
                },
              ]),
            },
            {
              OR: expect.arrayContaining([
                {
                  metadata: {
                    path: ["prRefs"],
                    array_contains: [
                      {
                        repositoryFullName: "closedloop-ai/closedloop-ai",
                        prNumber: 2294,
                      },
                    ],
                  },
                },
              ]),
            },
          ],
          source: expect.objectContaining({
            createdById: actorUserId,
          }),
        }),
      })
    );
    expect(mockDb.gitHubUserConnection.findUnique).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fetchCredentialOwnerId: actorUserId,
          fetchCredentialType: GitHubFetchCredentialType.UserOAuth,
          fetchMechanism: GitHubFetchMechanism.Rest,
          fetchResultReason: GitHubSyncResultReason.NoEligibleSessionReference,
          fetchTrigger: GitHubFetchTrigger.UserAction,
        }),
      })
    );
  });

  it("accepts the requested identity from canonical multi-PR metadata", async () => {
    mockDb.artifactLink.findFirst.mockResolvedValue({
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkKinds: [SessionArtifactLinkKind.SessionPrSet],
        prRefs: [2294, 2295].map((prNumber) => ({
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber,
          relationTypes: [SessionPrRelationType.Created],
        })),
      },
    });
    mockDb.gitHubUserConnection.findUnique.mockResolvedValue(null);

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubSyncResultReason.NoCredential,
    });
  });

  // PLN-1742 M5 tail: the credential comes from Clerk alone, so the denials
  // this lane can stop on are Clerk's. The row-shaped cases that used to live
  // here — `revokedAt` set, `tokenExpiresAt` past — described a stored token
  // that no longer exists; a token GitHub rejects at call time is covered by
  // the provider-status cases below.
  it.each([
    {
      name: "no linked account",
      wireClerk: () => wireClerkNoAccount(),
      reason: GitHubSyncResultReason.NoCredential,
    },
    {
      name: "an unreachable credential service",
      wireClerk: () => wireClerkFailure(503),
      reason: GitHubSyncResultReason.NoCredential,
    },
    {
      // Only an OAuth-family token can fail the floor: App-family reach is
      // governed by the installation, not by scopes.
      name: "a grant without repo",
      wireClerk: () => wireClerkToken(["read:user"]),
      reason: GitHubSyncResultReason.CredentialInsufficientScope,
    },
  ])("stops cleanly for $name", async ({ wireClerk, reason }) => {
    wireClerk();

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason,
    });
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          lastRefreshAttemptAt: now,
        }),
      })
    );
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fetchResultReason: reason }),
      })
    );
  });

  it("accepts an App-family token, which reports no scopes at all", async () => {
    // The widening PLN-1742 M2 buys: this lane's own scope check rejected
    // every GitHub App user-to-server token, while the sync pool drew the
    // same credential happily. One predicate now answers both.
    mockDb.gitHubUserConnection.findUnique.mockResolvedValue(
      makeUserConnection({ scopes: [] })
    );

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Refreshed,
      reason: GitHubSyncResultReason.Success,
    });
    expect(getSinglePullRequestWithProviderResult).toHaveBeenCalled();
  });

  it.each([
    {
      providerStatus:
        GitHubUserTokenProviderResultStatus.CredentialUnauthorized,
      reason: GitHubSyncResultReason.CredentialRevoked,
    },
    {
      providerStatus:
        GitHubUserTokenProviderResultStatus.CredentialInsufficientScope,
      reason: GitHubSyncResultReason.CredentialInsufficientScope,
    },
  ])(
    "stamps $reason when GitHub rejects the live user token",
    async ({ providerStatus, reason }) => {
      vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
        status: providerStatus,
      });

      const result =
        await githubServerSyncService.refreshTombstonedBranchPullRequest({
          actorUserId,
          branchArtifactId,
          organizationId,
          now,
        });

      expect(result).toEqual({
        status: GitHubServerSyncStatus.Failed,
        reason,
      });
      expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            repository: TOMBSTONED_REPOSITORY_WHERE,
          }),
        })
      );
      expect(mockDb.pullRequestDetail.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ fetchResultReason: reason }),
        })
      );
    }
  );

  // ISS-8522: the lane's target is the branch-canonical PR, not the promotion
  // pointer. Expected PR numbers are literal, never read back off the fixture.
  it("refuses a same-named canonical row with a conflicting provider id", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchTarget({
        currentPullRequestDetailId: "pr-foreign",
        pullRequestDetails: [
          makePullRequestDetailRow({
            id: "pr-foreign",
            repositoryId: "repo-other",
            repository: {
              fullName: "closedloop-ai/closedloop-ai",
              githubRepoId: "gh-repo-other",
            },
          }),
        ],
      })
    );

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.NotApplicable,
      reason: GitHubServerSyncReason.NoCurrentPullRequest,
    });
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  // A canonical reinstall can leave the new installation row LIVE. Provider-id
  // ownership accepts that PR across the split, but every guarded write still
  // requires the PR's
  // own repository to be tombstoned — correctly, since this lane spends a USER's
  // OAuth token — so without a gate the claim matches nothing and the lane
  // answers `already_refreshing`: a TRANSIENT reason, retried forever, for a
  // condition that can never clear. The assertion that matters is the REASON,
  // not merely that it failed.
  it("answers not_applicable, never already_refreshing, for a PR on a live sibling repository", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchTarget({
        currentPullRequestDetailId: "pr-detail-live-sibling",
        pullRequestDetails: [
          makePullRequestDetailRow({
            id: "pr-detail-live-sibling",
            // A NEW installation row for the SAME repository, still installed.
            repositoryId: "repo-reinstalled",
            repository: {
              fullName: "closedloop-ai/closedloop-ai",
              githubRepoId: "gh-repo-1",
              removedAt: null,
            },
          }),
        ],
      })
    );

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.NotApplicable,
      reason: GitHubServerSyncReason.NoCurrentPullRequest,
    });
    // And it stops at the gate rather than burning the credential or a write.
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
    expect(mockDb.pullRequestDetail.updateMany).not.toHaveBeenCalled();
  });

  it("refreshes the live canonical PR when the pointer names an older merged row", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchTarget({
        currentPullRequestDetailId: "pr-detail-merged",
        pullRequestDetails: [
          makePullRequestDetailRow({
            id: "pr-detail-merged",
            number: 1000,
            prState: "MERGED",
            mergedAt: new Date("2026-07-01T00:00:00.000Z"),
          }),
          makePullRequestDetailRow({ id: "pr-detail-live", number: 2294 }),
        ],
      })
    );

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Refreshed,
      reason: GitHubSyncResultReason.Success,
    });
    expect(getSinglePullRequestWithProviderResult).toHaveBeenCalledWith(
      expect.anything(),
      "closedloop-ai",
      "closedloop-ai",
      2294,
      expect.anything()
    );
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: "pr-detail-live" }),
      })
    );
  });

  it("refreshes the owned PR of a branch whose pointer was never promoted", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchTarget({
        currentPullRequestDetailId: null,
        pullRequestDetails: [
          makePullRequestDetailRow({ id: "pr-detail-unpromoted" }),
        ],
      })
    );

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Refreshed,
      reason: GitHubSyncResultReason.Success,
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: "pr-detail-unpromoted" }),
      })
    );
    // The discriminating assertion for the settle guard (PR #6453 review). The
    // branch write carries the pointer as SNAPSHOTTED — here `null` — while the
    // row being refreshed is `pr-detail-unpromoted`. A guard that instead
    // required `pointer === the refreshed row` would name the row here and
    // match nothing, which is the regression this lane exists to avoid; a guard
    // with no pointer term at all would omit the key entirely, which is the
    // concurrent-promotion window two reviewers flagged.
    const branchUpdate = mockDb.branchDetail.updateMany.mock.calls.at(-1)?.[0];
    expect(branchUpdate?.where).toMatchObject({
      artifactId: branchArtifactId,
      currentPullRequestDetailId: null,
    });
    const settleDetailWrite =
      mockDb.pullRequestDetail.updateMany.mock.calls.at(-1)?.[0];
    expect(settleDetailWrite?.where).toMatchObject({
      id: "pr-detail-unpromoted",
      branchArtifact: {
        organizationId,
        branch: {
          is: {
            repository: TOMBSTONED_REPOSITORY_WHERE,
            currentPullRequestDetailId: null,
          },
        },
      },
    });
  });

  it("refreshes a tombstoned linked PR with user OAuth provenance", async () => {
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
      status: GitHubProviderResultStatus.Success,
      value: makeProviderPullRequest({
        authorProviderUserId: "123",
        authorActorType: GitHubActorType.User,
      }),
    });
    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Refreshed,
      reason: GitHubSyncResultReason.Success,
    });
    expect(mockGetUserTokenOctokit).toHaveBeenCalledWith("clerk-token");
    expect(getSinglePullRequestWithProviderResult).toHaveBeenCalledWith(
      userTokenOctokit,
      "closedloop-ai",
      "closedloop-ai",
      2294,
      {
        credentialType: GitHubFetchCredentialType.UserOAuth,
        credentialOwnerId: actorUserId,
        observationKey: expect.any(String),
        observedAt: now.toISOString(),
        trigger: GitHubFetchTrigger.UserAction,
      }
    );
    expect(mockDb.gitHubUserConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { lastUsedAt: now, scopes: ["repo"] },
        where: expect.objectContaining({
          id: "connection-1",
          organizationId,
          userId: actorUserId,
        }),
      })
    );
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        // ISS-8522: the claim keys on the DERIVED canonical row id plus the
        // branch's own tombstoned repository. The promotion-pointer sub-filter
        // it replaced rejected every branch whose pointer was stale or never
        // promoted — the exact branches this lane exists to refresh.
        // Provider identity replaces the per-installation surrogate, so a
        // reinstall or rename split still claims the same GitHub repository.
        where: expect.objectContaining({
          id: "pr-detail-1",
          branchArtifactId,
          repository: TOMBSTONED_REPOSITORY_WHERE,
          branchArtifact: expect.objectContaining({
            organizationId,
            branch: { is: { repository: TOMBSTONED_REPOSITORY_WHERE } },
          }),
        }),
      })
    );
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lastRefreshAttemptAt: now }),
        data: expect.objectContaining({
          fetchCredentialOwnerId: actorUserId,
          fetchCredentialType: GitHubFetchCredentialType.UserOAuth,
          fetchMechanism: GitHubFetchMechanism.Rest,
          fetchResultReason: GitHubSyncResultReason.Success,
          fetchTrigger: GitHubFetchTrigger.UserAction,
          isDraft: false,
          additions: 33,
          deletions: 7,
          changedFiles: 4,
          lastVerifiedAt: now,
          prState: "MERGED",
          // ISS-8176: the PR columns this lane measured but used to drop. The
          // same transaction stamps the BRANCH's base below, so leaving these
          // off made the read serve "not measured" for a base and an author
          // this call had in hand.
          baseRefName: "main",
          authorLogin: "davetho",
          authorProviderUserId: "123",
          authorActorType: GitHubActorType.User,
          // ISS-8243: `number: 2294` was asserted here and is deliberately gone.
          // The shared builder no longer writes it on the update path; keeping it
          // there held the ISS-6421 atom-barrier cases blocked until their
          // concurrent FK writers timed out. Asserted below, because
          // `objectContaining` cannot see an absent key.
        }),
      })
    );
    expect(ensurePullRequestAuthorIdentity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        authorProviderUserId: "123",
        authorActorType: GitHubActorType.User,
      })
    );
    // `{ setCurrent: false }` is load-bearing: the old literal never touched
    // isCurrent, and this lane's guard already requires the row BE the branch's
    // current PR. A builder change that started writing `isCurrent: false` here
    // would silently demote a still-current row, and objectContaining above
    // cannot see an absent key.
    const currentDetailWrite =
      mockDb.pullRequestDetail.updateMany.mock.calls.at(-1)?.[0];
    expect(currentDetailWrite?.data).not.toHaveProperty("isCurrent");
    // ISS-8243: this expectation CHANGED, and the BEHAVIOR changed with it.
    // #6064 landed this test asserting the opposite — `number: 2294` present in
    // the update payload — and its PR body carried the counterfactual "drop
    // `number` from the builder input → this test goes red". That is now the
    // intended outcome, not a regression: with the column present the ISS-6421
    // atom-barrier cases blocked until their concurrent FK writers timed out,
    // and they pass without it. Why the lock behaves that way is still
    // contested — see ISS-8243. Pinned HERE as well as in the builder's own
    // suite because this lane spreads the builder into a wider literal, so that
    // suite cannot see a `number` re-added at this site. The lane no longer
    // self-heals a wrong stored number; accepted, since GitHub PR numbers are
    // immutable per repo.
    expect(currentDetailWrite?.data).not.toHaveProperty("number");
    const branchUpdate = mockDb.branchDetail.updateMany.mock.calls.at(-1)?.[0];
    // ISS-8522: the settle guard keys on the branch and its repository. It does
    // NOT key on `pointer === the refreshed row` — that term rejected exactly
    // the stale and never-promoted pointers this lane heals. What it does carry
    // (PR #6453 review) is a pointer-MOVEMENT CAS: the column compared against
    // the value snapshotted with the target, so a webhook promoting a sibling
    // during the provider fetch matches zero rows instead of letting this row's
    // base branch and head SHA land on a branch it no longer represents.
    // Here the fixture's pointer and the refreshed row coincide; the
    // never-promoted case below is what distinguishes the two readings.
    expect(branchUpdate?.where).toMatchObject({
      artifactId: branchArtifactId,
      repository: TOMBSTONED_REPOSITORY_WHERE,
      currentPullRequestDetailId: "pr-detail-1",
    });
    expect(branchUpdate?.data).toMatchObject({
      fetchCredentialOwnerId: actorUserId,
      fetchResultReason: GitHubSyncResultReason.Success,
      headSha: "head-sha",
      headShaObservedAt: now,
    });
    expect(branchUpdate?.data).not.toHaveProperty("lastActivityAt");
    expect(persistPullRequestLifecycleActivityMock).toHaveBeenCalledWith(
      mockDb,
      {
        organizationId,
        branchArtifactId,
        pullRequestDetailId: "pr-detail-1",
        openedAt: new Date("2026-07-06T09:00:00.000Z"),
        mergedAt: new Date("2026-07-06T10:00:00.000Z"),
        closedAt: new Date("2026-07-06T10:00:00.000Z"),
      }
    );
  });

  // ISS-8176 AC-4. GitHub reports no `user` for a deleted account, and this
  // lane's payload type always carries the key, so passing it straight through
  // would write NULL and clear a login another producer had measured — the read
  // renders a cleared login as "not measured". Omission is the column's only
  // spelling of "nothing to say".
  //
  // The base ref rides on the same write to prove it is read off the PROVIDER
  // payload rather than agreeing with the fixture's default by luck.
  it("omits an absent author and takes the base from the provider payload", async () => {
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
      status: GitHubProviderResultStatus.Success,
      value: makeProviderPullRequest({
        authorLogin: null,
        baseBranch: "release/24",
      }),
    });

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Refreshed,
      reason: GitHubSyncResultReason.Success,
    });
    const detailWrite =
      mockDb.pullRequestDetail.updateMany.mock.calls.at(-1)?.[0];
    expect(detailWrite?.data).toMatchObject({ baseRefName: "release/24" });
    // Presence, not `expect.anything()`: that matcher does not match null, so
    // an absence written with it stays green on the very payload this case
    // exists to reject.
    expect(detailWrite?.data).not.toHaveProperty("authorLogin");
  });

  it("rejects a refreshed PR when the stable GitHub id changed", async () => {
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
      status: GitHubProviderResultStatus.Success,
      value: makeProviderPullRequest({ githubId: "different-pr-id" }),
    });

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubSyncResultReason.Unsupported,
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fetchResultReason: GitHubSyncResultReason.Unsupported,
        }),
      })
    );
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fetchResultReason: GitHubSyncResultReason.Unsupported,
        }),
      })
    );
  });

  it("does not bump branch activity for unchanged open PR refreshes", async () => {
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
      status: GitHubProviderResultStatus.Success,
      value: makeProviderPullRequest({
        closedAt: null,
        mergedAt: null,
        state: "OPEN",
      }),
    });

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Refreshed,
      reason: GitHubSyncResultReason.Success,
    });
    const branchUpdate = mockDb.branchDetail.updateMany.mock.calls.at(-1)?.[0];
    expect(branchUpdate?.data).toMatchObject({
      fetchCredentialOwnerId: actorUserId,
      fetchResultReason: GitHubSyncResultReason.Success,
      headSha: "head-sha",
      headShaObservedAt: now,
    });
    expect(branchUpdate?.data).not.toHaveProperty("lastActivityAt");
  });

  it("warns and returns retryable when GitHub is unavailable during refresh", async () => {
    mockDb.pullRequestDetail.findFirst.mockResolvedValue(
      storedPullRequestAuthority()
    );
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Retryable,
      reason: GitHubServerSyncReason.ProviderUnavailable,
    });
    expect(log.warn).toHaveBeenCalledWith(
      "[github/sync] Tombstoned PR refresh failed",
      expect.objectContaining({
        reason: GitHubSyncResultReason.ProviderUnavailable,
        providerStatus: GitHubProviderResultStatus.ProviderUnavailable,
        branchArtifactId,
        organizationId,
      })
    );
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          headRepositoryDefaultBranchAvailability:
            RepositoryDefaultAvailability.Stale,
          headRepositoryDefaultBranchName: "trunk",
          headRepositoryDefaultBranchReason:
            RepositoryDefaultReason.ProviderError,
          headRepositoryDefaultBranchSource:
            RepositoryDefaultSource.PullRequestRest,
        }),
      })
    );
  });

  it("fails refresh when branch provenance settlement loses its guarded write", async () => {
    mockDb.branchDetail.updateMany.mockResolvedValueOnce({ count: 0 });

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubServerSyncReason.GuardedWriteFailed,
    });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          repository: TOMBSTONED_REPOSITORY_WHERE,
        }),
      })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "[github/sync] Tombstoned PR refresh failed",
      expect.objectContaining({
        reason: GitHubServerSyncReason.GuardedWriteFailed,
        branchArtifactId,
        organizationId,
      })
    );
  });
});

function storedPullRequestAuthority() {
  return {
    headRepositoryGithubId: "5826",
    headRepositoryFullName: "fork-owner/repo",
    headRepositoryDefaultBranchName: "trunk",
    headRepositoryDefaultBranchAvailability:
      RepositoryDefaultAvailability.Available,
    headRepositoryDefaultBranchCompleteness:
      RepositoryDefaultCompleteness.Complete,
    headRepositoryDefaultBranchReason: null,
    headRepositoryDefaultBranchSource: RepositoryDefaultSource.PullRequestRest,
    headRepositoryDefaultBranchMechanism: GitHubFetchMechanism.Rest,
    headRepositoryDefaultBranchTrigger: GitHubFetchTrigger.UserAction,
    headRepositoryDefaultBranchCredentialType:
      GitHubFetchCredentialType.UserOAuth,
    headRepositoryDefaultBranchCredentialOwnerId: actorUserId,
    headRepositoryDefaultBranchObservationKey: "previous-attempt",
    headRepositoryDefaultBranchObservedAt: new Date("2026-07-06T08:00:00.000Z"),
    headRepositoryDefaultBranchEventAt: null,
  };
}

function wireClerkToken(scopes: string[]) {
  mockClerkClient.mockResolvedValue({
    users: {
      getUserOauthAccessToken: vi.fn().mockResolvedValue({
        data: [{ token: "clerk-token", scopes, externalAccountId: "ea-1" }],
      }),
    },
  });
}

function wireClerkNoAccount() {
  mockClerkClient.mockResolvedValue({
    users: { getUserOauthAccessToken: vi.fn().mockResolvedValue({ data: [] }) },
  });
}

function wireClerkFailure(status: number) {
  mockClerkClient.mockResolvedValue({
    users: {
      getUserOauthAccessToken: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("clerk"), { status })),
    },
  });
}
