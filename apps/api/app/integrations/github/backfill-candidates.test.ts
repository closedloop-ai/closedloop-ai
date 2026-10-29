import { GitHubInstallationStatus } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const installationRepositoryFindManyMock = vi.fn();

vi.mock("@repo/database", () => ({
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  withDb: (callback: (db: unknown) => unknown) =>
    callback({
      gitHubInstallationRepository: {
        findMany: installationRepositoryFindManyMock,
      },
    }),
}));

vi.mock("./service", () => ({
  githubService: { getBranches: vi.fn(), getPullRequests: vi.fn() },
}));

const { getBackfillCandidates, GitHubBackfillLane } = await import(
  "./backfill-candidates"
);

describe("getBackfillCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installationRepositoryFindManyMock.mockResolvedValue([]);
  });

  it("returns the installation lane for an installed org", async () => {
    installationRepositoryFindManyMock.mockResolvedValue([
      {
        id: "repo-1",
        fullName: "closedloop-ai/closedloop-ai",
        owner: "closedloop-ai",
        name: "closedloop-ai",
      },
    ]);

    const candidates = await getBackfillCandidates("org-1");

    expect(candidates).toEqual([
      {
        lane: GitHubBackfillLane.Installation,
        repositoryId: "repo-1",
        fullName: "closedloop-ai/closedloop-ai",
        owner: "closedloop-ai",
        name: "closedloop-ai",
      },
    ]);
  });

  it("selects only live repositories on an ACTIVE installation for that org", async () => {
    await getBackfillCandidates("org-1");

    expect(installationRepositoryFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          removedAt: null,
          installation: {
            organizationId: "org-1",
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
      })
    );
  });

  it("does not fall back to verified observations when the org has no installation repository", async () => {
    await expect(getBackfillCandidates("org-1")).resolves.toEqual([]);
  });
});
