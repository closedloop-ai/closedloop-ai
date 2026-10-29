import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { ExternalCommentProvider } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT,
  PROVIDER_ID_READ_CHUNK_SIZE,
  readBranchContributorEvidence,
} from "./collaborator-source-evidence";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const BRANCH_ID = "55555555-5555-4555-8555-555555555551";
const FOREIGN_BRANCH_ID = "55555555-5555-4555-8555-555555555552";
const LATER_BRANCH_ID = "55555555-5555-4555-8555-555555555553";
const REPOSITORY = "closedloop-ai/closedloop-ai";
const BRANCH = "feature/collaborators";
const BEFORE_SHA = "a".repeat(40);
const AFTER_SHA = "b".repeat(40);

const branchFindMany = vi.fn();
const pullRequestFindMany = vi.fn();
const contributionFindMany = vi.fn();
const authorFindMany = vi.fn();
const queryRaw = vi.fn();
const db = {
  $queryRaw: queryRaw,
  branchDetail: { findMany: branchFindMany },
  pullRequestDetail: { findMany: pullRequestFindMany },
  branchPushContribution: { findMany: contributionFindMany },
  externalCommentAuthor: { findMany: authorFindMany },
} as never;

describe("readBranchContributorEvidence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    branchFindMany.mockResolvedValue([
      {
        artifactId: BRANCH_ID,
        firstPushedAt: new Date("2026-09-01T00:00:00Z"),
        pushCoverageAvailability: BranchIdentityAvailability.Incomplete,
      },
    ]);
    pullRequestFindMany.mockResolvedValue([]);
    contributionFindMany.mockResolvedValue([]);
    authorFindMany.mockResolvedValue([]);
    queryRaw.mockResolvedValue([]);
  });

  it("returns separate author and later pusher sources through stable org-scoped identities", async () => {
    pullRequestFindMany.mockResolvedValue([
      {
        branchArtifactId: BRANCH_ID,
        authorProviderUserId: "123",
        authorActorType: GitHubActorType.User,
        authorLogin: "bob",
      },
    ]);
    contributionFindMany.mockResolvedValue([
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
    ]);
    authorFindMany.mockResolvedValue([
      {
        providerUserId: "123",
        providerLogin: "bob",
        displayName: "Bob",
        avatarUrl: null,
        profileUrl: null,
        userId: "bob-user",
      },
      {
        providerUserId: "456",
        providerLogin: "alice",
        displayName: "Alice",
        avatarUrl: null,
        profileUrl: null,
        userId: "alice-user",
      },
    ]);

    const result = await readBranchContributorEvidence(db, ORGANIZATION_ID, [
      BRANCH_ID,
      FOREIGN_BRANCH_ID,
    ]);

    expect([...result.keys()]).toEqual([BRANCH_ID]);
    expect(result.get(BRANCH_ID)).toEqual({
      authors: [
        {
          actorType: GitHubActorType.User,
          person: {
            provider: BranchPersonProvider.GitHub,
            id: "123",
            userId: "bob-user",
            login: "bob",
            displayName: "Bob",
            actorType: GitHubActorType.User,
          },
        },
      ],
      pushes: [
        {
          actorType: GitHubActorType.User,
          person: {
            provider: BranchPersonProvider.GitHub,
            id: "456",
            userId: "alice-user",
            login: "alice",
            displayName: "Alice",
            actorType: GitHubActorType.User,
          },
        },
      ],
      authorAvailability: BranchIdentityAvailability.Complete,
      pushAvailability: BranchIdentityAvailability.Incomplete,
    });
    expect(branchFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        artifactId: { in: [BRANCH_ID, FOREIGN_BRANCH_ID] },
        artifact: { type: ArtifactType.Branch },
        deletedAt: null,
      },
      select: expect.any(Object),
    });
    expect(authorFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        provider: ExternalCommentProvider.GITHUB,
        providerUserId: { in: ["123", "456"] },
      },
      select: expect.any(Object),
    });
  });

  it("keeps unknown author provenance incomplete and skips bot accounts", async () => {
    pullRequestFindMany.mockResolvedValue([
      {
        branchArtifactId: BRANCH_ID,
        authorProviderUserId: null,
        authorActorType: null,
        authorLogin: "legacy",
      },
      {
        branchArtifactId: BRANCH_ID,
        authorProviderUserId: "999",
        authorActorType: GitHubActorType.Bot,
        authorLogin: "bot",
      },
    ]);
    contributionFindMany.mockResolvedValue([
      {
        branchArtifactId: BRANCH_ID,
        repositoryFullName: REPOSITORY,
        refName: "other-branch",
        providerUserId: "456",
        actorType: GitHubActorType.User,
        beforeSha: BEFORE_SHA,
        afterSha: AFTER_SHA,
        branch: { repositoryFullName: REPOSITORY, branchName: BRANCH },
      },
      {
        branchArtifactId: BRANCH_ID,
        repositoryFullName: REPOSITORY,
        refName: BRANCH,
        providerUserId: "789",
        actorType: GitHubActorType.User,
        beforeSha: BEFORE_SHA,
        afterSha: BEFORE_SHA,
        branch: { repositoryFullName: REPOSITORY, branchName: BRANCH },
      },
    ]);

    const result = await readBranchContributorEvidence(db, ORGANIZATION_ID, [
      BRANCH_ID,
    ]);

    expect(result.get(BRANCH_ID)).toEqual({
      authors: [],
      pushes: [],
      authorAvailability: BranchIdentityAvailability.Incomplete,
      pushAvailability: BranchIdentityAvailability.Incomplete,
    });
  });

  it("keeps a missing pusher coverage receipt incomplete without a first push", async () => {
    branchFindMany.mockResolvedValue([
      {
        artifactId: BRANCH_ID,
        pushCoverageAvailability: null,
      },
    ]);

    const result = await readBranchContributorEvidence(db, ORGANIZATION_ID, [
      BRANCH_ID,
    ]);

    expect(result.get(BRANCH_ID)?.pushAvailability).toBe(
      BranchIdentityAvailability.Incomplete
    );
  });

  it("windows saturated contributor sources and caps only the Branch that exceeds its source limit", async () => {
    branchFindMany.mockResolvedValue([
      {
        artifactId: BRANCH_ID,
        pushCoverageAvailability: BranchIdentityAvailability.Complete,
      },
      {
        artifactId: LATER_BRANCH_ID,
        pushCoverageAvailability: BranchIdentityAvailability.Complete,
      },
    ]);
    const firstAuthors = Array.from(
      { length: BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT },
      (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        branchArtifactId: BRANCH_ID,
        authorProviderUserId: "123",
        authorActorType: GitHubActorType.User,
        authorLogin: "first",
      })
    );
    const laterAuthor = {
      ...firstAuthors[0],
      id: "11111111-1111-4111-8111-111111111111",
      branchArtifactId: LATER_BRANCH_ID,
      authorProviderUserId: "456",
      authorLogin: "later",
    };
    pullRequestFindMany.mockResolvedValueOnce(firstAuthors);
    const authorWindow = [
      { ...firstAuthors[0], id: "22222222-2222-4222-8222-222222222222" },
      laterAuthor,
    ];
    const firstPushes = Array.from(
      { length: BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT },
      (_, index) => ({
        id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
        branchArtifactId: BRANCH_ID,
        repositoryFullName: REPOSITORY,
        refName: BRANCH,
        providerUserId: "123",
        actorType: GitHubActorType.User,
        beforeSha: BEFORE_SHA,
        afterSha: AFTER_SHA,
        branch: { repositoryFullName: REPOSITORY, branchName: BRANCH },
      })
    );
    contributionFindMany.mockResolvedValueOnce(firstPushes);
    const pushWindow = [
      {
        ...firstPushes[0],
        id: "44444444-4444-4444-8444-444444444444",
        branchArtifactId: LATER_BRANCH_ID,
        refName: "feature/later",
        providerUserId: "789",
        branch: {
          repositoryFullName: REPOSITORY,
          branchName: "feature/later",
        },
      },
    ];
    queryRaw.mockImplementation((sql: { sql: string; values: unknown[] }) => {
      if (sql.sql.includes("FROM pull_request_detail pr")) {
        return Promise.resolve([...firstAuthors, ...authorWindow]);
      }
      if (sql.sql.includes("JOIN LATERAL")) {
        return Promise.resolve([...firstPushes, ...pushWindow]);
      }
      return Promise.resolve([]);
    });

    const result = await readBranchContributorEvidence(db, ORGANIZATION_ID, [
      BRANCH_ID,
      LATER_BRANCH_ID,
    ]);

    expect(pullRequestFindMany).toHaveBeenCalledTimes(1);
    expect(contributionFindMany).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(3);
    for (const [statement] of queryRaw.mock.calls.slice(0, 2)) {
      expect(statement.values).toContain(
        BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT + 1
      );
      expect(statement.values).toContainEqual([BRANCH_ID, LATER_BRANCH_ID]);
    }
    expect(result.get(BRANCH_ID)?.authors).toHaveLength(
      BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT
    );
    expect(result.get(BRANCH_ID)?.authorAvailability).toBe(
      BranchIdentityAvailability.Incomplete
    );
    expect(result.get(BRANCH_ID)?.pushAvailability).toBe(
      BranchIdentityAvailability.Complete
    );
    expect(result.get(LATER_BRANCH_ID)?.authors[0]?.person?.id).toBe("456");
    expect(result.get(LATER_BRANCH_ID)?.pushes[0]?.person?.id).toBe("789");
    expect(result.get(LATER_BRANCH_ID)?.authorAvailability).toBe(
      BranchIdentityAvailability.Complete
    );
    expect(result.get(LATER_BRANCH_ID)?.pushAvailability).toBe(
      BranchIdentityAvailability.Complete
    );
  });

  it("chunks provider identity lookups after source admission", async () => {
    const providerIds = Array.from(
      { length: PROVIDER_ID_READ_CHUNK_SIZE + 1 },
      (_, index) => String(index + 1000)
    );
    pullRequestFindMany.mockResolvedValue(
      providerIds.map((providerUserId, index) => ({
        id: `99999999-9999-4999-8999-${String(index).padStart(12, "0")}`,
        branchArtifactId: BRANCH_ID,
        authorProviderUserId: providerUserId,
        authorActorType: GitHubActorType.User,
        authorLogin: providerUserId,
      }))
    );

    const result = await readBranchContributorEvidence(db, ORGANIZATION_ID, [
      BRANCH_ID,
    ]);

    expect(authorFindMany).toHaveBeenCalledTimes(2);
    expect(authorFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORGANIZATION_ID,
          providerUserId: {
            in: providerIds.slice(0, PROVIDER_ID_READ_CHUNK_SIZE),
          },
        }),
      })
    );
    expect(authorFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORGANIZATION_ID,
          providerUserId: {
            in: providerIds.slice(PROVIDER_ID_READ_CHUNK_SIZE),
          },
        }),
      })
    );
    expect(result.get(BRANCH_ID)?.authors).toHaveLength(providerIds.length);
  });

  it("rejects a failed author continuation before projecting a partial source", async () => {
    pullRequestFindMany.mockResolvedValueOnce(
      Array.from(
        { length: BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT },
        (_, index) => ({
          id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
          branchArtifactId: BRANCH_ID,
          authorProviderUserId: "123",
          authorActorType: GitHubActorType.User,
          authorLogin: "first",
        })
      )
    );
    queryRaw.mockRejectedValueOnce(new Error("author page unavailable"));

    await expect(
      readBranchContributorEvidence(db, ORGANIZATION_ID, [BRANCH_ID])
    ).rejects.toThrow("author page unavailable");
    expect(authorFindMany).not.toHaveBeenCalled();
  });
});
