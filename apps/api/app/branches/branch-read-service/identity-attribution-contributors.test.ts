import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { BRANCH_PUSH_METHOD_VALUES } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import {
  BRANCH_IDENTITY_READ_CHUNK_SIZE,
  resolveBranchIdentities,
} from "./identity-attribution";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const BRANCH_ID = "55555555-5555-4555-8555-555555555551";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const PUSHED_AT = new Date("2026-09-01T00:00:00.000Z");
const REPOSITORY = "closedloop-ai/closedloop-ai";
const BRANCH = "feature/collaborators";
const BEFORE_SHA = "a".repeat(40);
const AFTER_SHA = "b".repeat(40);

function mockDb(
  authorProviderUserId: string,
  creatorBySessionId: ReadonlyMap<string, string> = new Map([
    ["session-1", OWNER_ID],
  ])
) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    // ISS-12251: the pushing session's creator is the person its push names.
    artifact: {
      findMany: vi
        .fn()
        .mockImplementation(
          (args: { where: { id: { in: readonly string[] } } }) =>
            Promise.resolve(
              args.where.id.in.map((id) => ({
                id,
                createdById: creatorBySessionId.get(id) ?? null,
              }))
            )
        ),
    },
    comment: { findMany: vi.fn().mockResolvedValue([]) },
    gitHubCommentProjection: { findMany: vi.fn().mockResolvedValue([]) },
    gitHubUserConnection: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: OWNER_ID,
          clerkId: `user_${OWNER_ID}`,
          email: "owner@example.com",
          firstName: "Owner",
          lastName: "Person",
          avatarUrl: null,
        },
      ]),
    },
    branchDetail: {
      findMany: vi.fn().mockResolvedValue([
        {
          artifactId: BRANCH_ID,
          firstPushedAt: PUSHED_AT,
          pushCoverageAvailability: BranchIdentityAvailability.Incomplete,
        },
      ]),
    },
    pullRequestDetail: {
      findMany: vi.fn().mockResolvedValue([
        {
          branchArtifactId: BRANCH_ID,
          authorProviderUserId,
          authorActorType: GitHubActorType.User,
          authorLogin: "bob",
        },
      ]),
    },
    branchPushContribution: {
      findMany: vi.fn().mockResolvedValue([
        {
          branchArtifactId: BRANCH_ID,
          repositoryFullName: REPOSITORY,
          refName: BRANCH,
          providerUserId: "456",
          actorType: GitHubActorType.User,
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          branch: { repositoryFullName: REPOSITORY, branchName: BRANCH },
        },
      ]),
    },
    externalCommentAuthor: {
      findMany: vi.fn().mockResolvedValue([
        {
          providerUserId: "123",
          providerLogin: "bob",
          displayName: "Bob",
          avatarUrl: null,
          profileUrl: null,
          userId: "shadow-bob",
        },
        {
          providerUserId: "456",
          providerLogin: "alice",
          displayName: "Alice",
          avatarUrl: null,
          profileUrl: null,
          userId: "shadow-alice",
        },
      ]),
    },
  };
}

describe("resolveBranchIdentities collaborator union", () => {
  it("includes Owner, an associated PR author, and a later non-owner pusher", async () => {
    const db = mockDb("123");

    const result = await resolveBranchIdentities(
      db as never,
      ORGANIZATION_ID,
      [
        {
          branchId: BRANCH_ID,
          // ISS-12463: the Owner is the assignee the pusher was seeded as.
          assigneeId: OWNER_ID,
          firstPushedAt: PUSHED_AT,
          associatedPullRequestCount: 1,
        },
      ],
      [
        {
          sourceId: "session-1",
          targetId: BRANCH_ID,
          branchParticipationMethod: BRANCH_PUSH_METHOD_VALUES[0],
          branchParticipationObservedAt: PUSHED_AT,
        },
      ]
    );

    const collaborators = result.get(BRANCH_ID)?.collaborators;
    expect(
      collaborators?.people.map((person) => [person.provider, person.id])
    ).toEqual([
      [BranchPersonProvider.ClosedLoop, OWNER_ID],
      [BranchPersonProvider.GitHub, "456"],
      [BranchPersonProvider.GitHub, "123"],
    ]);
    expect(
      collaborators?.sources[BranchCollaboratorSource.PullRequestAuthors]
    ).toBe(BranchIdentityAvailability.Complete);
    expect(collaborators?.sources[BranchCollaboratorSource.Pushes]).toBe(
      BranchIdentityAvailability.Incomplete
    );
    expect(result.get(BRANCH_ID)?.ownerIdentity.person?.userId).toBe(OWNER_ID);
  });

  it("deduplicates one linked GitHub account across authorship and pushing", async () => {
    const db = mockDb("456");

    const result = await resolveBranchIdentities(
      db as never,
      ORGANIZATION_ID,
      [
        {
          branchId: BRANCH_ID,
          assigneeId: null,
          firstPushedAt: null,
          associatedPullRequestCount: 1,
        },
      ],
      []
    );

    expect(result.get(BRANCH_ID)?.collaborators.people).toEqual([
      expect.objectContaining({
        provider: BranchPersonProvider.GitHub,
        id: "456",
        userId: "shadow-alice",
      }),
    ]);
  });

  it("chunks a link-heavy Branch's user and connection lookups by organization", async () => {
    const links = Array.from(
      { length: BRANCH_IDENTITY_READ_CHUNK_SIZE + 1 },
      (_, index) => ({
        sourceId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        targetId: BRANCH_ID,
        branchParticipationMethod: BRANCH_PUSH_METHOD_VALUES[0],
        branchParticipationObservedAt: PUSHED_AT,
      })
    );
    const db = mockDb(
      "123",
      new Map(
        links.map(({ sourceId }, index) => [
          sourceId,
          `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
        ])
      )
    );

    await resolveBranchIdentities(
      db as never,
      ORGANIZATION_ID,
      [
        {
          branchId: BRANCH_ID,
          assigneeId: null,
          firstPushedAt: PUSHED_AT,
          associatedPullRequestCount: 1,
        },
      ],
      links
    );

    expect(db.user.findMany).toHaveBeenCalledTimes(2);
    expect(db.gitHubUserConnection.findMany).toHaveBeenCalledTimes(3);
    const ownerConnectionCalls =
      db.gitHubUserConnection.findMany.mock.calls.filter(
        ([args]) => args.where.revokedAt === undefined
      );
    for (const [calls, key] of [
      [db.artifact.findMany.mock.calls, "id"],
      [db.user.findMany.mock.calls, "id"],
      [ownerConnectionCalls, "userId"],
    ] as const) {
      const first = calls[0]?.[0];
      const second = calls[1]?.[0];
      expect(first.where.organizationId).toBe(ORGANIZATION_ID);
      expect(second.where.organizationId).toBe(ORGANIZATION_ID);
      const firstUserFilter = first.where[key];
      expect(firstUserFilter.in).toHaveLength(BRANCH_IDENTITY_READ_CHUNK_SIZE);
      expect(second.where[key].in).toHaveLength(1);
    }
    expect(db.gitHubUserConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORGANIZATION_ID,
          revokedAt: null,
          user: { organizationId: ORGANIZATION_ID, active: true },
          OR: [
            { userId: { in: [] } },
            { githubUserId: { in: ["123", "456"] } },
          ],
        },
      })
    );
  });
});
