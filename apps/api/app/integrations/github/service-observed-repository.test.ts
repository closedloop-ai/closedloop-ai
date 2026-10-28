/**
 * PLN-1775 M7 wiring: `githubService.getBranches` / `getPullRequests` reaching
 * the installation-free path for a verified observation-row id, and refusing to
 * reach it without a reader to attribute the read to. The behavior those calls
 * delegate to is covered by `service/observed-repository-read.test.ts`; this
 * file exists so deleting the call site cannot leave the suite green.
 */

import type * as GitHubModule from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../../../__tests__/utils/db-helpers";

const findVerifiedObservedRepositoryMock = vi.fn();
const listVerifiedObservedRepositoriesMock = vi.fn();
const readObservedRepositoryBranchesMock = vi.fn();
const readObservedRepositoryPullRequestsMock = vi.fn();
const publicGetBranchesMock = vi.fn();

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (parts: unknown[]) => ({ strings: [], values: parts }),
  },
  ArtifactType: { DOCUMENT: "DOCUMENT", BRANCH: "BRANCH" },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE", UNINSTALLED: "UNINSTALLED" },
}));

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  return {
    deleteInstallation: vi.fn(),
    getRepositoryBranches: vi.fn(),
    getRepositoryPullRequestsWithMetadata: vi.fn(),
    GitHubProviderResultStatus: actual.GitHubProviderResultStatus,
  };
});

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: vi.fn(),
}));

vi.mock("@repo/github/keys", () => ({
  keys: vi.fn(() => ({
    GITHUB_APP_CLIENT_ID: "test-client-id",
    GITHUB_APP_CLIENT_SECRET: "test-client-secret",
  })),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/observability/error", () => ({
  parseError: vi.fn((error: unknown) => String(error)),
}));

vi.mock("@/app/integrations/github/public-repositories/service", () => ({
  publicRepositoryService: { getBranches: publicGetBranchesMock },
}));

vi.mock("./service/observed-repository-read", () => ({
  findVerifiedObservedRepository: findVerifiedObservedRepositoryMock,
  listVerifiedObservedRepositories: listVerifiedObservedRepositoriesMock,
  readObservedRepositoryBranches: readObservedRepositoryBranchesMock,
  readObservedRepositoryPullRequests: readObservedRepositoryPullRequestsMock,
}));

const { githubService } = await import("./service");

const ORG = "org-1";
const USER = "user-1";
const OBSERVED_ID = "observed-1";
const OBSERVED = {
  id: OBSERVED_ID,
  fullName: "closedloop-ai/closedloop-ai",
  owner: "closedloop-ai",
  name: "closedloop-ai",
  githubRepoId: "999",
  isPrivate: true,
};

describe("githubService installation-free repository reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No installation repository owns the id — the miss is what routes the read
    // to the observation lane.
    mockWithDbCall({
      gitHubInstallationRepository: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    });
    findVerifiedObservedRepositoryMock.mockResolvedValue(OBSERVED);
    readObservedRepositoryBranchesMock.mockResolvedValue({ branches: [] });
    readObservedRepositoryPullRequestsMock.mockResolvedValue({
      pullRequests: [],
      trackedPrUrls: [],
    });
  });

  it("getObservedRepositories serves the org's verified observation rows", async () => {
    listVerifiedObservedRepositoriesMock.mockResolvedValue([OBSERVED]);

    await expect(githubService.getObservedRepositories(ORG)).resolves.toEqual([
      OBSERVED,
    ]);
    expect(listVerifiedObservedRepositoriesMock).toHaveBeenCalledWith(ORG);
  });

  it("getBranches resolves an observation-row id as the requesting user", async () => {
    await githubService.getBranches(OBSERVED_ID, ORG, 20, true, USER);

    expect(findVerifiedObservedRepositoryMock).toHaveBeenCalledWith(
      OBSERVED_ID,
      ORG
    );
    expect(readObservedRepositoryBranchesMock).toHaveBeenCalledWith({
      repository: OBSERVED,
      organizationId: ORG,
      userId: USER,
      limit: 20,
    });
    expect(publicGetBranchesMock).not.toHaveBeenCalled();
  });

  it("getBranches serves an observation row even with the public fallback closed", async () => {
    // The observation path is a SIBLING of the `public-github-repos` flag, not
    // a widening of it: its rows are org-owned and verified, so the flag that
    // gates the dark-launched public store must not gate them.
    await expect(
      githubService.getBranches(OBSERVED_ID, ORG, 20, false, USER)
    ).resolves.toEqual({ branches: [] });
    expect(readObservedRepositoryBranchesMock).toHaveBeenCalledTimes(1);
  });

  it("getBranches never borrows a grant when the caller named no reader", async () => {
    await expect(
      githubService.getBranches(OBSERVED_ID, ORG, 20, false)
    ).rejects.toThrow("Repository not found");
    expect(findVerifiedObservedRepositoryMock).not.toHaveBeenCalled();
    expect(readObservedRepositoryBranchesMock).not.toHaveBeenCalled();
  });

  it("getBranches still falls back to the public store for an unknown id", async () => {
    findVerifiedObservedRepositoryMock.mockResolvedValue(null);
    publicGetBranchesMock.mockResolvedValue({ branches: [] });

    await githubService.getBranches("public-1", ORG, 20, true, USER);

    expect(publicGetBranchesMock).toHaveBeenCalledWith("public-1", ORG, 20);
  });

  it("getPullRequests resolves an observation-row id as the requesting user", async () => {
    await githubService.getPullRequests(
      OBSERVED_ID,
      ORG,
      "project-1",
      { limit: 30 },
      undefined,
      USER
    );

    expect(readObservedRepositoryPullRequestsMock).toHaveBeenCalledWith({
      repository: OBSERVED,
      organizationId: ORG,
      userId: USER,
      projectId: "project-1",
      options: { limit: 30 },
    });
  });

  it("getPullRequests never borrows a grant when the caller named no reader", async () => {
    await expect(
      githubService.getPullRequests(OBSERVED_ID, ORG, null)
    ).rejects.toThrow("Repository not found");
    expect(readObservedRepositoryPullRequestsMock).not.toHaveBeenCalled();
  });
});
