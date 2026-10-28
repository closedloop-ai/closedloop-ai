/**
 * Canonical Branch Owner/Collaborators identity projection. Split out of
 * `branch-read-service.test.ts`, which owns the list/detail/usage read surfaces
 * themselves; the per-actor spend rollup built ON TOP of a resolved owner lives
 * in `branch-read-service.owner-buckets.test.ts`.
 *
 * ISS-12463: the Branch Owner is the branch's own assignee. The push evidence
 * these cases seed beside it names Collaborators and the seed, never the Owner
 * read; its rules are pinned on `projectOwner` in
 * `identity-attribution-owner-push-links.test.ts`.
 */

import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubSyncResultReason } from "@repo/api/src/types/github-read-model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { makeBranchAssignee } from "@/__tests__/support/branches/branch-assignee.test-fixtures";
import { withSeededPushSessionCreators } from "@/__tests__/support/branches/branch-evidence-link.test-fixtures";
import {
  branchId,
  createMockDb,
  makeBranchRow,
  makePushSessionLink,
  makeSessionLink,
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

afterEach(() => {
  vi.useRealTimers();
});

describe("branchReadService owner resolution (FEA-3457)", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(withSeededPushSessionCreators(mockDb));
    mockWithDbTx(withSeededPushSessionCreators(mockDb));
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
  const ownerC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const secondBranchId = "22222222-2222-4222-8222-222222222222";
  const thirdBranchId = "33333333-3333-4333-8333-333333333333";

  it("names the branch assignee as the list Owner", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        firstPushedAt: now,
        assignee: makeBranchAssignee(ownerB),
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s1", "1.00", ownerA),
      makeSessionLink(branchId, "s2", "1.00", ownerA),
      makePushSessionLink(branchId, "s3", ownerB, now),
    ]);
    mockDb.user.findMany.mockResolvedValue([orgUser(ownerB, "bob")]);
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

  it("names the assignee, not the winner of an exact push-time tie", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        firstPushedAt: now,
        assignee: makeBranchAssignee(ownerB),
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s2", ownerB, now),
      makePushSessionLink(branchId, "s1", ownerA, now),
    ]);
    mockDb.user.findMany.mockResolvedValue([orgUser(ownerB, "bob")]);
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

    expect(response.items[0].owner).toBe("bob");
    expect(response.items[0].ownerIdentity?.person?.id).toBe("20");
  });

  it("does not expose an email as a Linked Session owner name", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ firstPushedAt: now }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s1", ownerA, now),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        clerkId: `user_${ownerA}`,
        email: "private-owner@example.com",
        firstName: null,
        lastName: null,
        avatarUrl: null,
      },
    ]);
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    const membership = response.items[0].canonicalProjection?.common.membership;
    expect(membership?.sessions?.[0]).toMatchObject({
      ownerUnavailable: true,
    });
    expect(membership?.sessions?.[0]?.ownerName).toBeUndefined();
    expect(JSON.stringify(membership)).not.toContain(
      "private-owner@example.com"
    );
  });

  it("names no Owner for an unassigned branch, complete, whatever its push evidence", async () => {
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
        clerkId: `user_${ownerA}`,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
      },
      {
        id: ownerB,
        clerkId: `user_${ownerB}`,
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
      availability: BranchIdentityAvailability.Complete,
      person: null,
    });
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
        clerkId: `user_${ownerA}`,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
      },
      {
        id: ownerB,
        clerkId: `user_${ownerB}`,
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
          comment: { deletedAt: null, thread: { organizationId } },
          // ISS-6004: one page-wide read keyed on every branch id, not one read
          // per branch.
          threadProjection: {
            branchArtifactId: { in: [branchId] },
            deletedAt: null,
            pullRequestDetail: { organizationId },
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
        clerkId: `user_${ownerA}`,
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
      makeBranchRow({
        id: branchId,
        firstPushedAt: now,
        assignee: makeBranchAssignee(ownerA),
      }),
      makeBranchRow({
        id: secondBranchId,
        firstPushedAt: now,
        assignee: makeBranchAssignee(ownerB),
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s1", ownerA, now),
      makePushSessionLink(secondBranchId, "s2", ownerB, now),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      orgUser(ownerA, "ada"),
      orgUser(ownerB, "bob"),
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

  it("resolves ClosedLoop-only and GitHub-linked assignees onto the row", async () => {
    mockBranchCandidatePage(mockDb, [branchId, secondBranchId, thirdBranchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        id: branchId,
        branchName: "ada-branch",
        firstPushedAt: now,
        assignee: makeBranchAssignee(ownerA),
      }),
      makeBranchRow({
        id: secondBranchId,
        branchName: "bob-branch",
        firstPushedAt: now,
        assignee: makeBranchAssignee(ownerB),
      }),
      makeBranchRow({
        id: thirdBranchId,
        branchName: "unresolved-branch",
        firstPushedAt: now,
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s1", ownerA, now),
      makePushSessionLink(secondBranchId, "s2", ownerB, now),
      makePushSessionLink(thirdBranchId, "s3", ownerC, now),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        clerkId: `user_${ownerA}`,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
      },
      {
        id: ownerB,
        clerkId: `user_${ownerB}`,
        email: "bob@example.com",
        firstName: "Bob",
        lastName: "Builder",
        avatarUrl: null,
      },
    ]);
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([
      {
        userId: ownerB,
        githubUserId: "20",
        login: "bob",
        avatarUrl: null,
        profileUrl: null,
      },
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      sortKey: BranchListSortKey.Name,
      sortDir: BranchListSortDirection.Asc,
    });

    expect(response.items.map((item) => [item.branchName, item.owner])).toEqual(
      [
        ["ada-branch", "Ada Lovelace"],
        ["bob-branch", "Bob Builder"],
        ["unresolved-branch", null],
      ]
    );
    expect(response.items[0].ownerIdentity?.person).toMatchObject({
      provider: BranchPersonProvider.ClosedLoop,
      id: ownerA,
      userId: ownerA,
      displayName: "Ada Lovelace",
    });
    expect(response.items[1].ownerIdentity?.person).toMatchObject({
      provider: BranchPersonProvider.GitHub,
      id: "20",
      userId: ownerB,
      login: "bob",
      displayName: "Bob Builder",
    });
    expect(response.items[2].ownerIdentity).toEqual({
      availability: BranchIdentityAvailability.Complete,
      person: null,
    });
    // ISS-10298: the Owner FACET is now counted by the server-page SQL, not by
    // the JavaScript fold this mock drives, so asserting it here would assert
    // the fixture. It is deep-equalled against the kernel over a real corpus in
    // `__tests__/integration/branch-list-sql-parity.integration.test.ts`. The
    // per-ROW owner projection below is still this path's own and stays here.
    expect(mockDb.user.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.gitHubUserConnection.findMany).toHaveBeenCalledTimes(1);

    // ISS-10298: narrowing by `owners` is a server-page SQL predicate now, so
    // this mock cannot narrow anything and the assertion would only restate the
    // fixture. The owner filter is exercised against a real corpus in
    // `__tests__/integration/branch-list-sql-parity.integration.test.ts`.
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
        clerkId: `user_${ownerB}`,
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

  it("does not leak a cross-org assignee — an unresolved id stays unattributed", async () => {
    const outsider = makeBranchAssignee(ownerA, {
      firstName: "Ada",
      lastName: "Lovelace",
      organizationId: "other-organization",
    });
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ firstPushedAt: now, assignee: outsider }),
    ]);
    // Answers as Prisma would: only a dropped organization predicate hands the
    // outsider back.
    mockDb.user.findMany.mockImplementation(
      ({ where }: { where?: { organizationId?: string } } = {}) =>
        Promise.resolve(
          [outsider].filter(
            (candidate) =>
              where?.organizationId === undefined ||
              candidate.organizationId === where.organizationId
          )
        )
    );
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s1", ownerA, now),
    ]);
    // A connection row scoped to THIS organization still names the outsider:
    // the row's organization is not its user's.
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([
      {
        userId: ownerA,
        githubUserId: "77",
        login: "ada",
        avatarUrl: null,
        profileUrl: null,
      },
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0].owner).toBeNull();
    expect(response.items[0].ownerIdentity?.person).toBeNull();
    expect(mockDb.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId }),
      })
    );
  });

  it("resolves the branch-detail owner via the same batched path", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        firstPushedAt: now,
        assignee: makeBranchAssignee(ownerA),
      })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s1", ownerA, now),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        clerkId: `user_${ownerA}`,
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
});

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

/** An in-organization user row, as the org-scoped User read returns it. */
function orgUser(id: string, firstName: string) {
  return {
    id,
    clerkId: `user_${id}`,
    email: `${id}@example.com`,
    firstName,
    lastName: null,
    avatarUrl: null,
  };
}
