import {
  GitHubAccessDenialReason,
  GitHubPullRequestTrackingScope,
} from "@repo/api/src/types/github";
import { GitHubFetchCredentialType } from "@repo/api/src/types/github-read-model";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../../../../__tests__/utils/db-helpers";

const getGitHubClientMock = vi.fn();
const getRepositoryBranchesMock = vi.fn();
const getRepositoryPullRequestsWithMetadataMock = vi.fn();
const logErrorMock = vi.fn();
const logWarnMock = vi.fn();

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  ArtifactType: { BRANCH: "BRANCH" },
}));

vi.mock("@repo/github", () => ({
  getRepositoryBranches: getRepositoryBranchesMock,
  getRepositoryPullRequestsWithMetadata:
    getRepositoryPullRequestsWithMetadataMock,
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: logErrorMock, warn: logWarnMock, info: vi.fn() },
}));

vi.mock("@/lib/github/github-client-resolver", () => ({
  getGitHubClient: getGitHubClientMock,
}));

vi.mock("@/lib/github/github-read-cost-log", () => ({
  createGitHubReadCostObserver: vi.fn(() => undefined),
  GitHubReadCostRoute: { RepositoryPullRequests: "repository_pull_requests" },
}));

const {
  findVerifiedObservedRepository,
  listVerifiedObservedRepositories,
  readObservedRepositoryBranches,
  readObservedRepositoryPullRequests,
} = await import("./observed-repository-read");

const ORG = "org-1";
const USER = "user-1";
const OCTOKIT = { graphql: vi.fn() };

describe("listVerifiedObservedRepositories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves nothing to an org that already has an active installation", async () => {
    const db = makeDb({ activeInstallation: { id: "installation-1" } });

    await expect(listVerifiedObservedRepositories(ORG)).resolves.toEqual([]);
    expect(db.gitHubObservedRepository.findMany).not.toHaveBeenCalled();
  });

  it("selects only verified rows, ordered the way the installation list is", async () => {
    const db = makeDb({ observed: [row()] });

    await listVerifiedObservedRepositories(ORG);

    expect(db.gitHubObservedRepository.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, verificationState: "verified" },
        orderBy: [
          { lastPushedAt: { sort: "desc", nulls: "last" } },
          { name: "asc" },
        ],
      })
    );
  });

  it("projects provider casing and privacy rather than the normalized identity", async () => {
    makeDb({
      observed: [
        row({
          owner: "Closedloop-AI",
          name: "ClosedLoop-AI",
          repositoryFullName: "closedloop-ai/closedloop-ai",
          isPrivate: true,
        }),
      ],
    });

    const [repository] = await listVerifiedObservedRepositories(ORG);

    expect(repository?.fullName).toBe("Closedloop-AI/ClosedLoop-AI");
    expect(repository?.isPrivate).toBe(true);
  });

  it("drops a verified row missing the identity verification writes, and says so", async () => {
    makeDb({
      observed: [
        row({ id: "corrupt-1", githubRepoId: null }),
        row({ id: "usable-1" }),
      ],
    });

    const repositories = await listVerifiedObservedRepositories(ORG);

    expect(repositories.map((repository) => repository.id)).toEqual([
      "usable-1",
    ]);
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("missing the identity"),
      expect.objectContaining({ observedRepositoryIds: ["corrupt-1"] })
    );
  });
});

describe("findVerifiedObservedRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes the lookup to the org and to verified rows", async () => {
    const db = makeDb({ observedOne: row() });

    await findVerifiedObservedRepository("observed-1", ORG);

    expect(db.gitHubObservedRepository.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "observed-1",
          organizationId: ORG,
          verificationState: "verified",
        },
      })
    );
  });

  it("returns null when the id names no verified row this org owns", async () => {
    makeDb({ observedOne: null });

    await expect(
      findVerifiedObservedRepository("observed-1", ORG)
    ).resolves.toBeNull();
  });
});

describe("readObservedRepositoryBranches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    makeDb({});
  });

  it("reads as the requesting user through the interactive resolver", async () => {
    getGitHubClientMock.mockResolvedValue({
      ok: true,
      value: { octokit: OCTOKIT },
    });
    getRepositoryBranchesMock.mockResolvedValue([
      {
        name: "main",
        committedDate: "2026-08-01T00:00:00.000Z",
        isDefault: true,
      },
    ]);

    const response = await readObservedRepositoryBranches({
      repository: verified(),
      organizationId: ORG,
      userId: USER,
      limit: 20,
    });

    expect(getGitHubClientMock).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: USER,
      target: { owner: "closedloop-ai", repo: "closedloop-ai" },
      intent: "read-as-user",
    });
    expect(getRepositoryBranchesMock).toHaveBeenCalledWith(
      OCTOKIT,
      "closedloop-ai",
      "closedloop-ai",
      20
    );
    expect(response.branches).toHaveLength(1);
  });

  it("degrades a credential denial into the route's existing failure, spending no provider call", async () => {
    getGitHubClientMock.mockResolvedValue({
      ok: false,
      error: { reason: GitHubAccessDenialReason.InsufficientScope },
    });

    await expect(
      readObservedRepositoryBranches({
        repository: verified(),
        organizationId: ORG,
        userId: USER,
        limit: 20,
      })
    ).rejects.toThrow("Failed to fetch branches from GitHub");
    expect(getRepositoryBranchesMock).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Denied"),
      expect.objectContaining({
        denialReason: GitHubAccessDenialReason.InsufficientScope,
      })
    );
  });
});

describe("readObservedRepositoryPullRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGitHubClientMock.mockResolvedValue({
      ok: true,
      value: { octokit: OCTOKIT },
    });
    getRepositoryPullRequestsWithMetadataMock.mockResolvedValue({
      pullRequests: [],
      hasMore: false,
      truncated: false,
    });
  });

  it("tracks against the repo-less selector, keyed on the normalized identity", async () => {
    const db = makeDb({});

    await readObservedRepositoryPullRequests({
      repository: verified({ owner: "Closedloop-AI", name: "ClosedLoop-AI" }),
      organizationId: ORG,
      userId: USER,
      projectId: null,
      options: { trackingScope: GitHubPullRequestTrackingScope.Organization },
    });

    expect(db.pullRequestDetail.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          repositoryId: null,
          repositoryFullName: "closedloop-ai/closedloop-ai",
        },
      })
    );
  });

  it("records the read as a user-OAuth observation, and whose token made it", async () => {
    // `credentialType` says which LANE read the authority; `credentialOwnerId`
    // says which user's grant did. A `user_oauth` row with a null owner cannot
    // be told apart from any other member's, which is the whole provenance
    // difference between this row and a desktop-reported claim.
    makeDb({});

    await readObservedRepositoryPullRequests({
      repository: verified(),
      organizationId: ORG,
      userId: USER,
      projectId: null,
      options: { trackingScope: GitHubPullRequestTrackingScope.Organization },
    });

    const observationContext =
      getRepositoryPullRequestsWithMetadataMock.mock.calls[0]?.[5];
    expect(observationContext?.credentialType).toBe(
      GitHubFetchCredentialType.UserOAuth
    );
    expect(observationContext?.credentialOwnerId).toBe(USER);
  });
});

function makeDb({
  activeInstallation = null,
  observed = [],
  observedOne = null,
}: {
  activeInstallation?: { id: string } | null;
  observed?: ReturnType<typeof row>[];
  observedOne?: ReturnType<typeof row> | null;
} = {}) {
  const db = {
    gitHubInstallation: {
      findFirst: vi.fn().mockResolvedValue(activeInstallation),
    },
    gitHubObservedRepository: {
      findMany: vi.fn().mockResolvedValue(observed),
      findFirst: vi.fn().mockResolvedValue(observedOne),
    },
    pullRequestDetail: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    artifact: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  mockWithDbCall(db);
  return db;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "observed-1",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    owner: "closedloop-ai",
    name: "closedloop-ai",
    githubRepoId: "999",
    isPrivate: false,
    lastPushedAt: null,
    defaultBranchName: null,
    defaultBranchAvailability: null,
    defaultBranchCompleteness: null,
    defaultBranchReason: null,
    defaultBranchSource: null,
    defaultBranchMechanism: null,
    defaultBranchTrigger: null,
    defaultBranchCredentialType: null,
    defaultBranchCredentialOwnerId: null,
    defaultBranchObservationKey: null,
    defaultBranchObservedAt: null,
    defaultBranchEventAt: null,
    ...overrides,
  };
}

function verified(overrides: Record<string, unknown> = {}) {
  const base = row(overrides);
  return {
    ...base,
    owner: base.owner as string,
    name: base.name as string,
    githubRepoId: base.githubRepoId as string,
    isPrivate: base.isPrivate as boolean,
    fullName: `${base.owner}/${base.name}`,
  };
}
