/**
 * Canonical Branch Owner/Collaborators projection plus the legacy per-session
 * byActor buckets. Split out of `branch-read-service.test.ts`, which owns the
 * list/detail/usage read surfaces themselves.
 */

import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubSyncResultReason } from "@repo/api/src/types/github-read-model";
import { BRANCH_PUSH_METHOD_VALUES } from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
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

const installationAuthMocks = vi.hoisted(() => ({
  getInstallationOctokit: vi.fn(),
}));

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: installationAuthMocks.getInstallationOctokit,
}));

// Marker client returned by the mocked resolver: provider-read mocks must
// receive this exact object as their first argument (PLN-1525).
const INSTALLATION_OCTOKIT = { marker: "installation-octokit" };

const syncServiceMocks = vi.hoisted(() => ({
  refreshTombstonedBranchPullRequest: vi.fn(),
}));

vi.mock("@/app/integrations/github/sync-service", () => ({
  GitHubServerSyncReason: {
    NoEligibleSessionReference: "no_eligible_session_reference",
  },
  GitHubServerSyncStatus: {
    Failed: "failed",
    NotApplicable: "not_applicable",
    Refreshed: "refreshed",
    Retryable: "retryable",
  },
  githubServerSyncService: {
    refreshTombstonedBranchPullRequest:
      syncServiceMocks.refreshTombstonedBranchPullRequest,
  },
}));

const agentSessionsServiceMocks = vi.hoisted(() => ({
  findSessionDetail: vi.fn(),
}));

vi.mock("@/app/agent-sessions/service", () => ({
  agentSessionsService: {
    findSessionDetail: agentSessionsServiceMocks.findSessionDetail,
  },
}));

import {
  branchId,
  createMockDb,
  makeBranchRow,
  makeSessionLink,
  mockBranchCandidateIds,
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

describe("branchReadService owner resolution (FEA-3457)", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    installationAuthMocks.getInstallationOctokit.mockResolvedValue(
      INSTALLATION_OCTOKIT
    );
    syncServiceMocks.refreshTombstonedBranchPullRequest.mockResolvedValue({
      status: "failed",
      reason: "no_eligible_session_reference",
    });
  });

  const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const secondBranchId = "22222222-2222-4222-8222-222222222222";

  it("resolves the earliest exact qualifying push identity on the list", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ firstPushedAt: now }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s1", "1.00", ownerA),
      makeSessionLink(branchId, "s2", "1.00", ownerA),
      makePushSessionLink(branchId, "s3", ownerB, now),
    ]);
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([
      {
        userId: ownerB,
        githubUserId: "42",
        login: "bob",
        avatarUrl: null,
        profileUrl: null,
      },
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].owner).toBe("bob");
    expect(response.items[0].ownerIdentity?.person?.id).toBe("42");
    expect(mockDb.gitHubUserConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId, userId: { in: [ownerB] } },
      })
    );
  });

  it("uses stable GitHub identity to break exact push-time ties", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ firstPushedAt: now }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s2", ownerB, now),
      makePushSessionLink(branchId, "s1", ownerA, now),
    ]);
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([
      {
        userId: ownerB,
        githubUserId: "20",
        login: "bob",
        avatarUrl: null,
        profileUrl: null,
      },
      {
        userId: ownerA,
        githubUserId: "10",
        login: "ada",
        avatarUrl: null,
        profileUrl: null,
      },
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].owner).toBe("ada");
    expect(response.items[0].ownerIdentity?.person?.id).toBe("10");
  });

  it("does not let later qualifying push evidence replace the lifetime owner", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ firstPushedAt: now }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s2", ownerB, new Date(now.getTime() + 1)),
      makePushSessionLink(branchId, "s1", ownerA, now),
    ]);
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([
      {
        userId: ownerA,
        githubUserId: "10",
        login: "ada",
        avatarUrl: null,
        profileUrl: null,
      },
      {
        userId: ownerB,
        githubUserId: "20",
        login: "bob",
        avatarUrl: null,
        profileUrl: null,
      },
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].owner).toBe("ada");
  });

  it("keeps mutable multi-Session push evidence incomplete when an earlier webhook owns the Branch timestamp", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ firstPushedAt: now }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(
        branchId,
        "s2",
        ownerB,
        new Date(now.getTime() + 10_000)
      ),
      makePushSessionLink(
        branchId,
        "s1",
        ownerA,
        new Date(now.getTime() + 5000)
      ),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
      },
      {
        id: ownerB,
        email: "bob@example.com",
        firstName: "Bob",
        lastName: "Builder",
        avatarUrl: null,
      },
    ]);
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([
      {
        userId: ownerA,
        githubUserId: "10",
        login: "ada",
        avatarUrl: null,
        profileUrl: null,
      },
      {
        userId: ownerB,
        githubUserId: "20",
        login: "bob",
        avatarUrl: null,
        profileUrl: null,
      },
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].owner).toBeNull();
    expect(response.items[0].ownerIdentity).toEqual({
      availability: BranchIdentityAvailability.Incomplete,
      person: null,
    });
  });

  it("resolves a sole persisted Session pusher when an earlier webhook owns the Branch timestamp", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ firstPushedAt: now }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(
        branchId,
        "s1",
        ownerA,
        new Date(now.getTime() + 5000)
      ),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
      },
    ]);
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([
      {
        userId: ownerA,
        githubUserId: "10",
        login: "ada",
        avatarUrl: null,
        profileUrl: null,
      },
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].owner).toBe("Ada Lovelace");
    expect(response.items[0].ownerIdentity?.person?.id).toBe("10");
  });

  it("unions persisted PR, Branch, and linked-Session commenters", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s1", "1.00", ownerA),
    ]);
    // ISS-6004: the page-wide read selects `createdAt`/`id` so the per-Branch cap
    // keeps its ordering across a chunked session read.
    mockDb.comment.findMany.mockResolvedValue([
      {
        authorId: ownerA,
        createdAt: now,
        id: "comment-a",
        thread: { artifactId: branchId },
      },
      {
        authorId: ownerB,
        createdAt: now,
        id: "comment-b",
        thread: { artifactId: "s1" },
      },
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
      },
      {
        id: ownerB,
        email: "bob@example.com",
        firstName: "Bob",
        lastName: "Builder",
        avatarUrl: null,
      },
    ]);
    mockDb.gitHubCommentProjection.findMany.mockResolvedValue([
      makeGitHubComment(ownerA, "github-ada", GitHubActorType.User),
      makeGitHubComment(
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "dependabot",
        GitHubActorType.Bot
      ),
    ]);
    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].collaborators).toMatchObject({
      availability: BranchIdentityAvailability.Incomplete,
      people: [
        {
          provider: BranchPersonProvider.GitHub,
          userId: ownerA,
          login: "github-ada",
        },
        {
          provider: BranchPersonProvider.ClosedLoop,
          userId: ownerB,
        },
      ],
      sources: {
        [BranchCollaboratorSource.PullRequestComments]:
          BranchIdentityAvailability.Incomplete,
        [BranchCollaboratorSource.BranchComments]:
          BranchIdentityAvailability.Complete,
        [BranchCollaboratorSource.SessionComments]:
          BranchIdentityAvailability.Complete,
      },
    });
    expect(mockDb.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null }),
      })
    );
    expect(mockDb.gitHubCommentProjection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          githubDeletedAt: null,
          comment: { deletedAt: null },
          // ISS-6004: one page-wide read keyed on every branch id, not one read
          // per branch.
          threadProjection: {
            branchArtifactId: { in: [branchId] },
            deletedAt: null,
          },
        },
      })
    );
  });

  it("keeps PR collaborator evidence incomplete when child rows cannot prove lane completion", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.gitHubCommentProjection.findMany.mockResolvedValue([
      makeGitHubComment(ownerA, "github-ada", GitHubActorType.User),
    ]);
    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].collaborators?.sources).toMatchObject({
      [BranchCollaboratorSource.PullRequestComments]:
        BranchIdentityAvailability.Incomplete,
    });
  });

  it("does not claim a real zero when persisted rows cannot prove both PR comment channels were fetched", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].collaborators?.sources).toMatchObject({
      [BranchCollaboratorSource.PullRequestComments]:
        BranchIdentityAvailability.Incomplete,
    });
  });

  it("applies comment caps per Branch so list and detail share one evidence budget", async () => {
    mockBranchCandidatePage(mockDb, [branchId, secondBranchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        id: branchId,
        currentPullRequestDetail: null,
        pullRequestDetails: [],
      }),
      makeBranchRow({
        id: secondBranchId,
        currentPullRequestDetail: null,
        pullRequestDetails: [],
      }),
    ]);
    // ISS-6004: the read is now ONE page-wide query, so the fixture returns the
    // page's rows tagged with their owning artifact and the per-Branch cap is
    // applied to each Branch's own group — the behavior this case pins.
    const cappedComments = Array.from({ length: 1001 }, () => ({
      authorId: ownerA,
      thread: { artifactId: branchId },
    }));
    mockDb.comment.findMany.mockImplementation(({ where }) =>
      where.thread.artifactId.in.includes(branchId) ? cappedComments : []
    );
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
      },
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].collaborators?.sources).toMatchObject({
      [BranchCollaboratorSource.BranchComments]:
        BranchIdentityAvailability.Incomplete,
    });
    expect(response.items[1].collaborators?.sources).toMatchObject({
      [BranchCollaboratorSource.BranchComments]:
        BranchIdentityAvailability.Complete,
    });
  });

  it("batches the user lookup across the page — ONE org-scoped query, no N+1", async () => {
    mockBranchCandidatePage(mockDb, [branchId, secondBranchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ id: branchId, firstPushedAt: now }),
      makeBranchRow({ id: secondBranchId, firstPushedAt: now }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s1", ownerA, now),
      makePushSessionLink(secondBranchId, "s2", ownerB, now),
    ]);
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([
      {
        userId: ownerA,
        githubUserId: "1",
        login: "ada",
        avatarUrl: null,
        profileUrl: null,
      },
      {
        userId: ownerB,
        githubUserId: "2",
        login: "bob",
        avatarUrl: null,
        profileUrl: null,
      },
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(mockDb.gitHubUserConnection.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.gitHubUserConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: { in: expect.arrayContaining([ownerA, ownerB]) },
          organizationId,
        },
      })
    );
    expect(response.items.map((item) => item.owner).sort()).toEqual([
      "ada",
      "bob",
    ]);
  });

  it("leaves owner null when no linked session carries an owner", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ firstPushedAt: now }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s1", "1.00", null),
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].owner).toBeNull();
    expect(response.items[0].ownerIdentity?.availability).toBe("incomplete");
  });

  it("marks missing first-push state incomplete when push evidence exists", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s1", ownerA, now),
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].ownerIdentity).toEqual({
      availability: BranchIdentityAvailability.Incomplete,
      person: null,
    });
  });

  it("does not qualify comments through an orphaned Session link", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    const orphanedLink = {
      ...makeSessionLink(branchId, "orphaned-session", "1.00", ownerA),
      source: { session: null },
    };
    mockDb.artifactLink.findMany.mockResolvedValue([orphanedLink]);
    mockDb.comment.findMany.mockResolvedValue([]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerB,
        email: "bob@example.com",
        firstName: "Bob",
        lastName: "Builder",
        avatarUrl: null,
      },
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].collaborators?.people).toEqual([]);
  });

  it("does not leak a cross-org owner — an unresolved id stays unattributed", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ firstPushedAt: now }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s1", ownerA, now),
    ]);
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].owner).toBeNull();
  });

  it("resolves the branch-detail owner via the same batched path", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ firstPushedAt: now })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s1", ownerA, now),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
      },
    ]);
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([
      {
        userId: ownerA,
        githubUserId: "1",
        login: "ada",
        avatarUrl: null,
        profileUrl: null,
      },
    ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.owner).toBe("Ada Lovelace");
  });

  it("groups byActor buckets by resolved owner over distinct sessions", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s1", "2.00", ownerA),
      makeSessionLink(branchId, "s2", "1.00", ownerB),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: null,
      },
      {
        id: ownerB,
        email: "bob@example.com",
        firstName: "Bob",
        lastName: null,
      },
    ]);

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });

    // One bucket per owner, ordered by cost desc (Ada 2.0 before Bob 1.0).
    expect(response.byActor.map((bucket) => bucket.owner)).toEqual([
      "Ada",
      "Bob",
    ]);
    expect(response.byActor[0].estimatedCostUsd).toBeCloseTo(2, 10);
  });

  it("keeps distinct owner ids that resolve to the SAME display name as separate byActor buckets (no name-merge double-count)", async () => {
    // Two different users who happen to share a display name ("Alex Kim").
    // Grouping byActor by name would collapse them into one bucket and
    // double-count cost/tokens under a single owner — an attribution bug. They
    // must stay as two distinct buckets keyed by owner id.
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s1", "2.00", ownerA),
      makeSessionLink(branchId, "s2", "1.00", ownerB),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        email: "alex.kim.a@example.com",
        firstName: "Alex",
        lastName: "Kim",
      },
      {
        id: ownerB,
        email: "alex.kim.b@example.com",
        firstName: "Alex",
        lastName: "Kim",
      },
    ]);

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });

    // Two separate buckets (not one merged "Alex Kim" bucket at 3.00).
    expect(response.byActor).toHaveLength(2);
    expect(response.byActor.map((bucket) => bucket.owner)).toEqual([
      "Alex Kim",
      "Alex Kim",
    ]);
    // Each bucket keeps its own session's cost — no double-count.
    expect(response.byActor[0].estimatedCostUsd).toBeCloseTo(2, 10);
    expect(response.byActor[1].estimatedCostUsd).toBeCloseTo(1, 10);
  });

  it("folds ownerless sessions into a trailing unattributed byActor bucket", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s1", "2.00", ownerA),
      makeSessionLink(branchId, "s2", "1.00", null),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: null,
      },
    ]);

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });

    // Named owner first, the null (unattributed) bucket last.
    expect(response.byActor.map((bucket) => bucket.owner)).toEqual([
      "Ada",
      null,
    ]);
  });
});

function makePushSessionLink(
  targetId: string,
  sessionId: string,
  userId: string,
  observedAt: Date
) {
  return {
    ...makeSessionLink(targetId, sessionId, "1.00", userId),
    branchParticipationMethod: BRANCH_PUSH_METHOD_VALUES[0],
    branchParticipationObservedAt: observedAt,
  };
}

function makeGitHubComment(
  userId: string,
  login: string,
  actorType: GitHubActorType
) {
  return {
    threadProjection: {
      branchArtifactId: branchId,
      pullRequestDetailId: "pr-detail-1",
      fetchResultReason: GitHubSyncResultReason.Success,
    },
    externalAuthor: {
      providerUserId: `github:${login}`,
      providerLogin: login,
      displayName: login,
      avatarUrl: null,
      profileUrl: null,
      userId,
      providerDetail: { actorType },
    },
  };
}
