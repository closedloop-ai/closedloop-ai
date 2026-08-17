/**
 * `githubService.getContributorsAcrossRepos` — the installation-scoped
 * contributor fan-out across an org's repositories, its provider-failure
 * handling, and the guards that stop it before a provider call. Split out of
 * `service.test.ts`, which owns the rest of the service surface.
 */

import type * as GitHubModule from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../../../__tests__/utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (parts: unknown[]) => ({ strings: [], values: parts }),
  },
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
}));

// The read is stubbed, but the provider-result status contract and the failure
// classifier are the real ones: `acquireInstallationClient` folds a rejected
// mint into those statuses and this caller branches on them.
vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  return {
    deleteInstallation: vi.fn(),
    getRepositoryBranches: vi.fn(),
    getRepositoryContributors: vi.fn(),
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

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/observability/error", () => ({
  parseError: vi.fn((err: unknown) => String(err)),
}));

vi.mock("@/lib/integration-encryption", () => ({
  encryptTokenPair: vi.fn(),
}));

vi.mock("@/app/integrations/github/public-repositories/service", () => ({
  publicRepositoryService: { getBranches: vi.fn() },
}));

// Import after mocks are set up
import { getRepositoryContributors } from "@repo/github";
import { getInstallationOctokit } from "@repo/github/installation-auth";
import { githubService } from "@/app/integrations/github/service";

const mockGetRepositoryContributors = getRepositoryContributors as ReturnType<
  typeof vi.fn
>;
const mockGetInstallationOctokit = getInstallationOctokit as ReturnType<
  typeof vi.fn
>;

const ORG_ID = "org-1";
const INSTALLATION_ID = "install-1";
const GITHUB_INSTALLATION_ID = "gh-install-100";
// Marker object the mocked resolver mints; read functions must receive it as
// their first argument (PLN-1525: resolve once, thread down).
const INSTALLATION_OCTOKIT = { kind: "installation-octokit" };

describe("githubService.getContributorsAcrossRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstallationOctokit.mockResolvedValue(INSTALLATION_OCTOKIT);
  });

  function mockInstallationWithRepos(repos: { owner: string; name: string }[]) {
    const mockDb = {
      gitHubInstallation: {
        findFirst: vi.fn().mockResolvedValue({
          id: INSTALLATION_ID,
          installationId: GITHUB_INSTALLATION_ID,
          repositories: repos,
        }),
      },
    };
    mockWithDbCall(mockDb);
    return mockDb;
  }

  it("returns empty contributors when no active installation exists", async () => {
    const mockDb = {
      gitHubInstallation: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    mockWithDbCall(mockDb);

    const result = await githubService.getContributorsAcrossRepos(ORG_ID);

    expect(result).toEqual({ contributors: [] });
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
    expect(mockGetRepositoryContributors).not.toHaveBeenCalled();
  });

  it("returns empty contributors when installation has no repositories", async () => {
    mockInstallationWithRepos([]);

    const result = await githubService.getContributorsAcrossRepos(ORG_ID);

    expect(result).toEqual({ contributors: [] });
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
    expect(mockGetRepositoryContributors).not.toHaveBeenCalled();
  });

  it("aggregates contributors across repos, summing contributions and deduplicating by login", async () => {
    mockInstallationWithRepos([
      { owner: "org", name: "repo1" },
      { owner: "org", name: "repo2" },
    ]);
    mockGetRepositoryContributors
      .mockResolvedValueOnce([
        {
          login: "alice",
          avatarUrl: "https://example.com/alice.png",
          contributions: 10,
          htmlUrl: "https://github.com/alice",
        },
        {
          login: "bob",
          avatarUrl: "https://example.com/bob.png",
          contributions: 5,
          htmlUrl: "https://github.com/bob",
        },
      ])
      .mockResolvedValueOnce([
        {
          login: "alice",
          avatarUrl: "https://example.com/alice.png",
          contributions: 3,
          htmlUrl: "https://github.com/alice",
        },
        {
          login: "carol",
          avatarUrl: "https://example.com/carol.png",
          contributions: 8,
          htmlUrl: "https://github.com/carol",
        },
      ]);

    const result = await githubService.getContributorsAcrossRepos(ORG_ID);

    // One client minted for the whole multi-repo sweep, threaded into each
    // per-repo read (PLN-1525: resolve once per operation).
    expect(mockGetInstallationOctokit).toHaveBeenCalledTimes(1);
    expect(mockGetInstallationOctokit).toHaveBeenCalledWith(
      GITHUB_INSTALLATION_ID
    );
    expect(result.contributors).toEqual([
      {
        login: "alice",
        avatarUrl: "https://example.com/alice.png",
        contributions: 13,
        htmlUrl: "https://github.com/alice",
      },
      {
        login: "carol",
        avatarUrl: "https://example.com/carol.png",
        contributions: 8,
        htmlUrl: "https://github.com/carol",
      },
      {
        login: "bob",
        avatarUrl: "https://example.com/bob.png",
        contributions: 5,
        htmlUrl: "https://github.com/bob",
      },
    ]);
  });

  it("sorts contributors by contribution count in descending order", async () => {
    mockInstallationWithRepos([{ owner: "org", name: "repo1" }]);
    mockGetRepositoryContributors.mockResolvedValueOnce([
      {
        login: "low",
        avatarUrl: "",
        contributions: 1,
        htmlUrl: "",
      },
      {
        login: "high",
        avatarUrl: "",
        contributions: 100,
        htmlUrl: "",
      },
      {
        login: "mid",
        avatarUrl: "",
        contributions: 50,
        htmlUrl: "",
      },
    ]);

    const result = await githubService.getContributorsAcrossRepos(ORG_ID);

    expect(result.contributors.map((c) => c.login)).toEqual([
      "high",
      "mid",
      "low",
    ]);
  });

  it("passes perRepoLimit option to getRepositoryContributors and respects maxRepos", async () => {
    const mockDb = mockInstallationWithRepos([{ owner: "org", name: "repo1" }]);
    mockGetRepositoryContributors.mockResolvedValue([]);

    await githubService.getContributorsAcrossRepos(ORG_ID, {
      maxRepos: 5,
      perRepoLimit: 50,
    });

    expect(mockDb.gitHubInstallation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          repositories: expect.objectContaining({ take: 5 }),
        }),
      })
    );
    expect(mockGetRepositoryContributors).toHaveBeenCalledWith(
      INSTALLATION_OCTOKIT,
      "org",
      "repo1",
      { perPage: 50 }
    );
  });

  it("uses default maxRepos=10 and perRepoLimit=30 when no options provided", async () => {
    const mockDb = mockInstallationWithRepos([{ owner: "org", name: "repo1" }]);
    mockGetRepositoryContributors.mockResolvedValue([]);

    await githubService.getContributorsAcrossRepos(ORG_ID);

    expect(mockDb.gitHubInstallation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          repositories: expect.objectContaining({ take: 10 }),
        }),
      })
    );
    expect(mockGetRepositoryContributors).toHaveBeenCalledWith(
      INSTALLATION_OCTOKIT,
      "org",
      "repo1",
      { perPage: 30 }
    );
  });

  it("falls back to a non-empty avatarUrl or htmlUrl from a later repo when the existing value is empty", async () => {
    mockInstallationWithRepos([
      { owner: "org", name: "repo1" },
      { owner: "org", name: "repo2" },
    ]);
    mockGetRepositoryContributors
      .mockResolvedValueOnce([
        {
          login: "alice",
          avatarUrl: "",
          contributions: 1,
          htmlUrl: "",
        },
      ])
      .mockResolvedValueOnce([
        {
          login: "alice",
          avatarUrl: "https://example.com/alice.png",
          contributions: 2,
          htmlUrl: "https://github.com/alice",
        },
      ]);

    const result = await githubService.getContributorsAcrossRepos(ORG_ID);

    expect(result.contributors).toEqual([
      {
        login: "alice",
        avatarUrl: "https://example.com/alice.png",
        contributions: 3,
        htmlUrl: "https://github.com/alice",
      },
    ]);
  });

  it("resolves to empty contributors when the installation client mint fails", async () => {
    mockInstallationWithRepos([
      { owner: "org", name: "repo1" },
      { owner: "org", name: "repo2" },
    ]);
    mockGetInstallationOctokit.mockRejectedValueOnce(
      new Error("token exchange failed")
    );

    const result = await githubService.getContributorsAcrossRepos(ORG_ID);

    // A mint rejection degrades to the empty list (the per-repo reads'
    // return-empty-on-error contract) instead of escaping as a throw.
    expect(result).toEqual({ contributors: [] });
    expect(mockGetInstallationOctokit).toHaveBeenCalledWith(
      GITHUB_INSTALLATION_ID
    );
    expect(mockGetRepositoryContributors).not.toHaveBeenCalled();
  });
});
