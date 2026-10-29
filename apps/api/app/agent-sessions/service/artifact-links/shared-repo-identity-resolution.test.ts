import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  SessionPrRelationType,
  type SyncedArtifactRef,
  type SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import { GitHubInstallationStatus } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import {
  resolveRepoIdsByFullName,
  resolveSessionRepositoryIdentity,
  ServerRepositoryIdentity,
  serverRepositoryIdentity,
  storeUnresolvedRefs,
} from "./shared";

const ORGANIZATION_ID = "019ff900-0000-7000-8000-000000000001";

function prRef(repositoryFullName: string): SyncedSessionPrRef {
  return {
    repositoryFullName,
    prNumber: 1,
    relationType: SessionPrRelationType.Referenced,
  };
}

describe("storeUnresolvedRefs", () => {
  type Item = { id: string };
  const isValidItem = (value: unknown): value is Item =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === "string";

  it("returns without writing when every new ref is already stored", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValue({ metadata: { myKey: [{ id: "a" }] } });
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      sessionDetail: {
        findUnique,
        update,
      },
    };

    await storeUnresolvedRefs(
      tx as never,
      "session-1",
      "myKey",
      isValidItem,
      (item: Item) => item.id,
      [{ id: "a" }]
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: { artifactId: "session-1" },
      select: { metadata: true },
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("resolveRepoIdsByFullName", () => {
  it("returns an empty map without querying when there are no PR refs", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const tx = { gitHubInstallationRepository: { findMany } };

    const result = await resolveRepoIdsByFullName(
      tx as never,
      ORGANIZATION_ID,
      []
    );

    expect(result.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("drops a full name two distinct repository rows both claim, and keeps it dropped on a later row", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "repo-1", fullName: "acme/web" },
      { id: "repo-2", fullName: "acme/web" },
      { id: "repo-3", fullName: "acme/web" },
    ]);
    const tx = { gitHubInstallationRepository: { findMany } };

    const result = await resolveRepoIdsByFullName(
      tx as never,
      ORGANIZATION_ID,
      [prRef("acme/web")]
    );

    expect(result.has("acme/web")).toBe(false);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        removedAt: null,
        fullName: { in: ["acme/web"] },
        installation: {
          organizationId: ORGANIZATION_ID,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: { id: true, fullName: true },
    });
  });
});

describe("resolveSessionRepositoryIdentity foundRowIdentity", () => {
  function sessionWithIdentityOnlyPrRef(
    repositoryFullName: string
  ): Parameters<typeof resolveSessionRepositoryIdentity>[2] {
    return [
      {
        externalSessionId: "ext-1",
        artifactRefs: [
          {
            kind: ArtifactRefTargetKind.PullRequest,
            repositoryFullName,
            prNumber: 6060,
            method: ArtifactRefMethod.McpToolCall,
            relation: ArtifactRefRelation.Reviewed,
            monitoredActivityOnly: true,
          },
        ] satisfies SyncedArtifactRef[],
      },
    ] as unknown as Parameters<typeof resolveSessionRepositoryIdentity>[2];
  }

  const REPOSITORY = "closedloop-ai/closedloop-ai";

  it("holds identity for an installation row carrying a repositoryId but no provider id", async () => {
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([
          { repositoryId: "repo-1", githubRepoId: null, fullName: REPOSITORY },
        ]),
    };

    const probe = await resolveSessionRepositoryIdentity(
      tx as never,
      ORGANIZATION_ID,
      sessionWithIdentityOnlyPrRef(REPOSITORY)
    );

    const authority = probe.authorities.get(REPOSITORY);
    expect(authority?.repositoryId).toBe("repo-1");
    expect(authority?.providerRepositoryId).toBeUndefined();
    expect(serverRepositoryIdentity(probe, REPOSITORY)).toBe(
      ServerRepositoryIdentity.Held
    );
    const [query] = tx.$queryRaw.mock.calls[0];
    expect(query.strings.join(" ")).toContain(
      "github_installation_repositories"
    );
    expect(query.values).toContain(ORGANIZATION_ID);
  });
});
