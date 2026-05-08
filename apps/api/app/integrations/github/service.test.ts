/**
 * Unit tests for `githubService`.
 *
 * Covers:
 *  - `getIntegrationStatus` — connected and disconnected cases
 *  - `completeOAuthCallback` — token exchange failure, user fetch failure, installation
 *    not found creation, cross-org claim block, and successful connection
 *  - `upsertInstallation` — create path and update path
 *  - `updateInstallationStatus` — success and database error cases
 *  - `syncRepositories` — adds repos, removes stale repos, handles empty list
 *  - `addRepositories` — upserts repos, handles empty input
 *  - `findInstallationById` / `findInstallationByInstallationId` — found and null cases
 *  - `findInstallationForRepoFullName` — found and not-found cases
 *  - `removeRepositories` — removes specified repos, skips DB call when empty
 *  - `disconnectInstallation` — GitHub uninstall success and failure, database update
 *  - `getRepositories` — active installation found and not found
 *  - `getBranches` — repository not found, org mismatch, and successful branch fetch
 *  - `getPullRequests` — repository not found, org mismatch, successful fetch with
 *    tracked PR URL resolution
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockWithDbCall,
  mockWithDbTx,
} from "../../../__tests__/utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PULL_REQUEST: "PULL_REQUEST",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

vi.mock("@repo/github", () => ({
  deleteInstallation: vi.fn(),
  getRepositoryBranches: vi.fn(),
  getRepositoryPullRequests: vi.fn(),
}));

vi.mock("@repo/github/keys", () => ({
  keys: vi.fn(() => ({
    GITHUB_APP_CLIENT_ID: "test-client-id",
    GITHUB_APP_CLIENT_SECRET: "test-client-secret",
  })),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/observability/error", () => ({
  parseError: vi.fn((err: unknown) => String(err)),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after mocks are set up
import {
  deleteInstallation,
  getRepositoryBranches,
  getRepositoryPullRequests,
} from "@repo/github";
import { githubService } from "@/app/integrations/github/service";

const mockDeleteInstallation = deleteInstallation as ReturnType<typeof vi.fn>;
const mockGetRepositoryBranches = getRepositoryBranches as ReturnType<
  typeof vi.fn
>;
const mockGetRepositoryPullRequests = getRepositoryPullRequests as ReturnType<
  typeof vi.fn
>;

const ORG_ID = "org-1";
const INSTALLATION_ID = "install-1";
const GITHUB_INSTALLATION_ID = "gh-install-100";

function makeRepoWithInstallation(overrides?: {
  orgId?: string;
  fullName?: string;
}) {
  return {
    id: "repo-1",
    fullName: overrides?.fullName ?? "org/repo",
    installation: {
      organizationId: overrides?.orgId ?? ORG_ID,
      installationId: GITHUB_INSTALLATION_ID,
    },
  };
}

function mockRepoLookup(
  repo: ReturnType<typeof makeRepoWithInstallation> | null
) {
  const mockDb = {
    gitHubInstallationRepository: {
      findFirst: vi.fn().mockResolvedValue(repo),
    },
  };
  mockWithDbCall(mockDb);
  return mockDb;
}

describe("githubService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getIntegrationStatus", () => {
    it("returns { connected: false } when no active installation exists", async () => {
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      const result = await githubService.getIntegrationStatus(ORG_ID);

      expect(result).toEqual({ connected: false });
    });

    it("returns { connected: true, installation: {...} } when active installation exists", async () => {
      const now = new Date();
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue({
            id: INSTALLATION_ID,
            installationId: GITHUB_INSTALLATION_ID,
            accountLogin: "my-org",
            accountType: "Organization",
            status: "ACTIVE",
            repositorySelection: "all",
            claimedAt: now,
            createdAt: now,
            repositories: [{ id: "repo-1" }, { id: "repo-2" }],
          }),
        },
      };
      mockWithDbCall(mockDb);

      const result = await githubService.getIntegrationStatus(ORG_ID);

      expect(result).toEqual({
        connected: true,
        installation: {
          id: INSTALLATION_ID,
          installationId: GITHUB_INSTALLATION_ID,
          accountLogin: "my-org",
          accountType: "Organization",
          status: "ACTIVE",
          repositorySelection: "all",
          repositoryCount: 2,
          claimedAt: now.toISOString(),
          createdAt: now.toISOString(),
        },
      });
    });
  });

  describe("upsertInstallation", () => {
    it("calls gitHubInstallation.upsert with correct create and update data", async () => {
      const created = {
        id: INSTALLATION_ID,
        installationId: GITHUB_INSTALLATION_ID,
      };
      const mockDb = {
        gitHubInstallation: {
          upsert: vi.fn().mockResolvedValue(created),
        },
      };
      mockWithDbCall(mockDb);

      const result = await githubService.upsertInstallation(
        GITHUB_INSTALLATION_ID,
        {
          accountId: "acc-1",
          accountLogin: "my-org",
          accountType: "Organization",
          senderLogin: "user",
          senderId: "u-1",
        }
      );

      expect(mockDb.gitHubInstallation.upsert).toHaveBeenCalledWith({
        where: { installationId: GITHUB_INSTALLATION_ID },
        create: expect.objectContaining({
          installationId: GITHUB_INSTALLATION_ID,
          accountId: "acc-1",
          accountLogin: "my-org",
          accountType: "Organization",
          senderLogin: "user",
          senderId: "u-1",
          status: "PENDING_CLAIM",
        }),
        update: expect.objectContaining({
          accountId: "acc-1",
          accountLogin: "my-org",
          accountType: "Organization",
          senderLogin: "user",
          senderId: "u-1",
        }),
      });
      expect(result).toBe(created);
    });

    it("uses provided status when specified", async () => {
      const mockDb = {
        gitHubInstallation: {
          upsert: vi.fn().mockResolvedValue({ id: INSTALLATION_ID }),
        },
      };
      mockWithDbCall(mockDb);

      await githubService.upsertInstallation(GITHUB_INSTALLATION_ID, {
        accountId: "acc-1",
        accountLogin: "my-org",
        accountType: "Organization",
        senderLogin: "user",
        senderId: "u-1",
        status: "ACTIVE",
      });

      const call = mockDb.gitHubInstallation.upsert.mock.calls[0][0];
      expect(call.create.status).toBe("ACTIVE");
    });
  });

  describe("updateInstallationStatus", () => {
    it("updates status and logs success", async () => {
      const updated = {
        id: INSTALLATION_ID,
        status: "SUSPENDED",
        organizationId: ORG_ID,
      };
      const mockDb = {
        gitHubInstallation: {
          update: vi.fn().mockResolvedValue(updated),
        },
      };
      mockWithDbCall(mockDb);

      const result = await githubService.updateInstallationStatus(
        INSTALLATION_ID,
        "SUSPENDED"
      );

      expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith({
        where: { id: INSTALLATION_ID },
        data: { status: "SUSPENDED" },
      });
      expect(result).toBe(updated);
    });

    it("throws when database update fails", async () => {
      const dbError = new Error("DB connection failed");
      const mockDb = {
        gitHubInstallation: {
          update: vi.fn().mockRejectedValue(dbError),
        },
      };
      mockWithDbCall(mockDb);

      await expect(
        githubService.updateInstallationStatus(INSTALLATION_ID, "ACTIVE")
      ).rejects.toThrow("DB connection failed");
    });
  });

  describe("syncRepositories", () => {
    it("deletes stale repos and upserts incoming repos", async () => {
      const repos = [
        {
          githubRepoId: "r-1",
          fullName: "org/repo1",
          name: "repo1",
          owner: "org",
          private: false,
        },
      ];
      const mockTx = {
        gitHubInstallationRepository: {
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          upsert: vi.fn().mockResolvedValue({ id: "repo-rec-1" }),
          findMany: vi.fn().mockResolvedValue([{ id: "repo-rec-1" }]),
        },
      };
      mockWithDbTx(mockTx);

      const result = await githubService.syncRepositories(
        INSTALLATION_ID,
        repos
      );

      expect(
        mockTx.gitHubInstallationRepository.deleteMany
      ).toHaveBeenCalledWith({
        where: {
          installationId: INSTALLATION_ID,
          githubRepoId: { notIn: ["r-1"] },
        },
      });
      expect(mockTx.gitHubInstallationRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            installationId_githubRepoId: {
              installationId: INSTALLATION_ID,
              githubRepoId: "r-1",
            },
          },
          create: expect.objectContaining({
            installationId: INSTALLATION_ID,
            githubRepoId: "r-1",
            fullName: "org/repo1",
            name: "repo1",
            owner: "org",
            private: false,
          }),
        })
      );
      expect(result).toEqual([{ id: "repo-rec-1" }]);
    });

    it("returns empty array and skips upsert when repository list is empty", async () => {
      const mockTx = {
        gitHubInstallationRepository: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          upsert: vi.fn(),
          findMany: vi.fn(),
        },
      };
      mockWithDbTx(mockTx);

      const result = await githubService.syncRepositories(INSTALLATION_ID, []);

      expect(mockTx.gitHubInstallationRepository.deleteMany).toHaveBeenCalled();
      expect(mockTx.gitHubInstallationRepository.upsert).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });
  });

  describe("addRepositories", () => {
    it("upserts provided repos and returns them", async () => {
      const repos = [
        {
          githubRepoId: "r-2",
          fullName: "org/repo2",
          name: "repo2",
          owner: "org",
          private: true,
        },
      ];
      const mockTx = {
        gitHubInstallationRepository: {
          upsert: vi.fn().mockResolvedValue({ id: "repo-rec-2" }),
          findMany: vi.fn().mockResolvedValue([{ id: "repo-rec-2" }]),
        },
      };
      mockWithDbTx(mockTx);

      const result = await githubService.addRepositories(
        INSTALLATION_ID,
        repos
      );

      expect(mockTx.gitHubInstallationRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            installationId_githubRepoId: {
              installationId: INSTALLATION_ID,
              githubRepoId: "r-2",
            },
          },
          create: expect.objectContaining({
            installationId: INSTALLATION_ID,
            githubRepoId: "r-2",
            fullName: "org/repo2",
            name: "repo2",
            owner: "org",
            private: true,
          }),
        })
      );
      expect(result).toEqual([{ id: "repo-rec-2" }]);
    });

    it("returns empty array without hitting DB when input is empty", async () => {
      const mockTx = {
        gitHubInstallationRepository: {
          upsert: vi.fn(),
          findMany: vi.fn(),
        },
      };
      mockWithDbTx(mockTx);

      const result = await githubService.addRepositories(INSTALLATION_ID, []);

      expect(mockTx.gitHubInstallationRepository.upsert).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });
  });

  describe("findInstallationById", () => {
    it("returns installation when found", async () => {
      const installation = { id: INSTALLATION_ID, repositories: [] };
      const mockDb = {
        gitHubInstallation: {
          findUnique: vi.fn().mockResolvedValue(installation),
        },
      };
      mockWithDbCall(mockDb);

      const result = await githubService.findInstallationById(INSTALLATION_ID);

      expect(mockDb.gitHubInstallation.findUnique).toHaveBeenCalledWith({
        where: { id: INSTALLATION_ID },
        include: { repositories: true },
      });
      expect(result).toBe(installation);
    });

    it("returns null when not found", async () => {
      const mockDb = {
        gitHubInstallation: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      const result = await githubService.findInstallationById("missing");

      expect(result).toBeNull();
    });
  });

  describe("findInstallationByInstallationId", () => {
    it("returns installation when found by GitHub installationId", async () => {
      const installation = {
        id: INSTALLATION_ID,
        installationId: GITHUB_INSTALLATION_ID,
        repositories: [],
      };
      const mockDb = {
        gitHubInstallation: {
          findUnique: vi.fn().mockResolvedValue(installation),
        },
      };
      mockWithDbCall(mockDb);

      const result = await githubService.findInstallationByInstallationId(
        GITHUB_INSTALLATION_ID
      );

      expect(mockDb.gitHubInstallation.findUnique).toHaveBeenCalledWith({
        where: { installationId: GITHUB_INSTALLATION_ID },
        include: { repositories: true },
      });
      expect(result).toBe(installation);
    });

    it("returns null when not found", async () => {
      const mockDb = {
        gitHubInstallation: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      const result =
        await githubService.findInstallationByInstallationId("missing-id");

      expect(result).toBeNull();
    });
  });

  describe("findInstallationForRepoFullName", () => {
    it("returns installationId when a matching repository is found", async () => {
      const mockDb = {
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({
            installation: { installationId: GITHUB_INSTALLATION_ID },
          }),
        },
      };
      mockWithDbCall(mockDb);

      const result = await githubService.findInstallationForRepoFullName(
        ORG_ID,
        "org/repo"
      );

      expect(result).toBe(GITHUB_INSTALLATION_ID);
    });

    it("returns null when no matching repository is found", async () => {
      const mockDb = {
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      const result = await githubService.findInstallationForRepoFullName(
        ORG_ID,
        "org/missing-repo"
      );

      expect(result).toBeNull();
    });
  });

  describe("removeRepositories", () => {
    it("calls deleteMany with the specified githubRepoIds", async () => {
      const mockDb = {
        gitHubInstallationRepository: {
          deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
        },
      };
      mockWithDbCall(mockDb);

      await githubService.removeRepositories(INSTALLATION_ID, ["r-1", "r-2"]);

      expect(
        mockDb.gitHubInstallationRepository.deleteMany
      ).toHaveBeenCalledWith({
        where: {
          installationId: INSTALLATION_ID,
          githubRepoId: { in: ["r-1", "r-2"] },
        },
      });
    });

    it("skips DB call when githubRepoIds is empty", async () => {
      const mockDb = {
        gitHubInstallationRepository: {
          deleteMany: vi.fn(),
        },
      };
      mockWithDbCall(mockDb);

      await githubService.removeRepositories(INSTALLATION_ID, []);

      expect(
        mockDb.gitHubInstallationRepository.deleteMany
      ).not.toHaveBeenCalled();
    });
  });

  describe("disconnectInstallation", () => {
    it("throws when no installation is found for the organization", async () => {
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      };
      mockWithDbCall(mockDb);

      await expect(
        githubService.disconnectInstallation(ORG_ID)
      ).rejects.toThrow("No installation found for organization");
    });

    it("still updates local DB to UNINSTALLED even when GitHub API uninstall fails", async () => {
      const installation = {
        id: INSTALLATION_ID,
        installationId: GITHUB_INSTALLATION_ID,
        organizationId: ORG_ID,
      };
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(installation),
          update: vi.fn().mockResolvedValue(installation),
        },
      };
      mockWithDbCall(mockDb);
      mockDeleteInstallation.mockResolvedValue({
        success: false,
        error: "GitHub API error",
      });

      await githubService.disconnectInstallation(ORG_ID);

      expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith({
        where: { id: INSTALLATION_ID },
        data: { status: "UNINSTALLED", organizationId: null },
      });
    });

    it("marks installation as UNINSTALLED and clears orgId on successful disconnect", async () => {
      const installation = {
        id: INSTALLATION_ID,
        installationId: GITHUB_INSTALLATION_ID,
        organizationId: ORG_ID,
      };
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(installation),
          update: vi.fn().mockResolvedValue({
            ...installation,
            status: "UNINSTALLED",
            organizationId: null,
          }),
        },
      };
      mockWithDbCall(mockDb);
      mockDeleteInstallation.mockResolvedValue({ success: true });

      await githubService.disconnectInstallation(ORG_ID);

      expect(mockDeleteInstallation).toHaveBeenCalledWith(
        GITHUB_INSTALLATION_ID
      );
      expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith({
        where: { id: INSTALLATION_ID },
        data: { status: "UNINSTALLED", organizationId: null },
      });
    });
  });

  describe("getRepositories", () => {
    it("returns empty array when no active installation exists", async () => {
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      const result = await githubService.getRepositories(ORG_ID);

      expect(result).toEqual([]);
    });

    it("returns repositories from active installation", async () => {
      const repos = [{ id: "repo-1", name: "repo1" }];
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue({
            id: INSTALLATION_ID,
            repositories: repos,
          }),
        },
      };
      mockWithDbCall(mockDb);

      const result = await githubService.getRepositories(ORG_ID);

      expect(result).toBe(repos);
    });
  });

  describe("getBranches", () => {
    it("throws when repository is not found", async () => {
      mockRepoLookup(null);

      await expect(githubService.getBranches("repo-1", ORG_ID)).rejects.toThrow(
        "Repository not found"
      );
    });

    it("throws when repository belongs to a different organization", async () => {
      mockRepoLookup(makeRepoWithInstallation({ orgId: "other-org" }));

      await expect(githubService.getBranches("repo-1", ORG_ID)).rejects.toThrow(
        "Repository does not belong to organization"
      );
    });

    it("returns branch list on successful fetch", async () => {
      const branches = [{ name: "main" }, { name: "feature" }];
      mockRepoLookup(makeRepoWithInstallation());
      mockGetRepositoryBranches.mockResolvedValue(branches);

      const result = await githubService.getBranches("repo-1", ORG_ID);

      expect(mockGetRepositoryBranches).toHaveBeenCalledWith(
        GITHUB_INSTALLATION_ID,
        "org",
        "repo",
        20
      );
      expect(result).toEqual({ branches });
    });

    it("throws when repository fullName is malformed", async () => {
      mockRepoLookup(makeRepoWithInstallation({ fullName: "badformat" }));

      await expect(githubService.getBranches("repo-1", ORG_ID)).rejects.toThrow(
        "Invalid repository fullName format"
      );
    });

    it("throws when getRepositoryBranches rejects", async () => {
      mockRepoLookup(makeRepoWithInstallation());
      mockGetRepositoryBranches.mockRejectedValue(
        new Error("GitHub API error")
      );

      await expect(githubService.getBranches("repo-1", ORG_ID)).rejects.toThrow(
        "Failed to fetch branches from GitHub"
      );
    });
  });

  describe("getPullRequests", () => {
    it("throws when repository is not found", async () => {
      mockRepoLookup(null);

      await expect(
        githubService.getPullRequests("repo-1", ORG_ID, null)
      ).rejects.toThrow("Repository not found");
    });

    it("throws when repository belongs to a different organization", async () => {
      mockRepoLookup(makeRepoWithInstallation({ orgId: "other-org" }));

      await expect(
        githubService.getPullRequests("repo-1", ORG_ID, null)
      ).rejects.toThrow("Repository does not belong to organization");
    });

    it("returns pull requests without tracked PR URLs when projectId is null", async () => {
      const prs = [{ id: "pr-1", url: "https://github.com/org/repo/pull/1" }];
      mockRepoLookup(makeRepoWithInstallation());
      mockGetRepositoryPullRequests.mockResolvedValue(prs);

      const result = await githubService.getPullRequests(
        "repo-1",
        ORG_ID,
        null
      );

      expect(result).toEqual({ pullRequests: prs, trackedPrUrls: [] });
    });

    it("returns tracked PR URLs from project artifacts when projectId is provided", async () => {
      const prs = [{ id: "pr-1" }];
      const prUrl = "https://github.com/org/repo/pull/42";

      const mockDb = {
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(makeRepoWithInstallation()),
        },
        artifact: {
          findMany: vi.fn().mockResolvedValue([{ externalUrl: prUrl }]),
        },
      };
      mockWithDbCall(mockDb);
      mockGetRepositoryPullRequests.mockResolvedValue(prs);

      const result = await githubService.getPullRequests(
        "repo-1",
        ORG_ID,
        "proj-1"
      );

      expect(result.pullRequests).toBe(prs);
      expect(result.trackedPrUrls).toContain(prUrl);
    });

    it("throws when getRepositoryPullRequests rejects", async () => {
      mockRepoLookup(makeRepoWithInstallation());
      mockGetRepositoryPullRequests.mockRejectedValue(
        new Error("GitHub API error")
      );

      await expect(
        githubService.getPullRequests("repo-1", ORG_ID, null)
      ).rejects.toThrow("Failed to fetch pull requests from GitHub");
    });
  });

  describe("completeOAuthCallback", () => {
    const CODE = "oauth-code";
    const REDIRECT_URI = "https://app.example.com/callback";
    const USER_ID = "user-1";

    const DEFAULT_GH_INSTALLATION = {
      id: 100,
      account: { id: 1, login: "org", type: "Organization" },
      permissions: {},
      events: [],
      repository_selection: "all",
    };

    const UNCLAIMED_INSTALLATION = {
      id: INSTALLATION_ID,
      installationId: "100",
      organizationId: null,
      status: "ACTIVE",
    };

    function callOAuth() {
      return githubService.completeOAuthCallback(
        CODE,
        undefined,
        REDIRECT_URI,
        ORG_ID,
        USER_ID
      );
    }

    function mockTokenExchangeSuccess() {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: "user-access-token" }),
      });
    }

    function mockTokenExchangeFailure() {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
      });
    }

    function mockUserFetch(user: { id: number; login: string } | null) {
      if (user) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(user),
        });
      } else {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      }
    }

    function mockInstallationsResponse(
      installations: (typeof DEFAULT_GH_INSTALLATION)[]
    ) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ installations }),
      });
    }

    function mockReposResponse(
      repos: {
        id: number;
        full_name: string;
        name: string;
        owner: { login: string };
        private: boolean;
      }[]
    ) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ repositories: repos }),
      });
    }

    function mockOAuthThroughInstallationResolve() {
      mockTokenExchangeSuccess();
      mockUserFetch({ id: 1, login: "user" });
      mockInstallationsResponse([DEFAULT_GH_INSTALLATION]);
    }

    function makeClaimMockDb(
      installation: Record<string, unknown>,
      includeRepoSync = true
    ) {
      const base = {
        gitHubInstallation: {
          findUnique: vi.fn().mockResolvedValue(installation),
          update: vi.fn().mockResolvedValue({
            ...installation,
            status: "ACTIVE",
            organizationId: ORG_ID,
          }),
        },
      };
      if (!includeRepoSync) {
        return base;
      }
      return {
        ...base,
        gitHubInstallationRepository: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          upsert: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
    }

    it("returns error when token exchange fails", async () => {
      mockTokenExchangeFailure();

      const result = await callOAuth();

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("Failed to exchange authorization code"),
      });
    });

    it("returns error when token exchange returns error field", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            error: "bad_verification_code",
            error_description: "Code expired",
          }),
      });

      const result = await callOAuth();

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("Code expired"),
      });
    });

    it("continues flow when fetchGitHubUser returns null (non-OK response)", async () => {
      mockTokenExchangeSuccess();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ installations: [] }),
      });

      const result = await callOAuth();

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("No GitHub App installation found"),
      });
    });

    it("returns error when resolveInstallation fails", async () => {
      mockTokenExchangeSuccess();
      mockUserFetch({ id: 1, login: "user" });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      const result = await callOAuth();

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("Failed to verify installation access"),
      });
    });

    it("blocks claim when installation already belongs to another org", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = {
        gitHubInstallation: {
          findUnique: vi.fn().mockResolvedValue({
            id: INSTALLATION_ID,
            installationId: GITHUB_INSTALLATION_ID,
            organizationId: "other-org",
            status: "ACTIVE",
          }),
          update: vi.fn(),
          upsert: vi.fn(),
        },
      };
      mockWithDbCall(mockDb);

      const result = await callOAuth();

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining(
          "already connected to another organization"
        ),
      });
      expect(mockDb.gitHubInstallation.update).not.toHaveBeenCalled();
    });

    it("creates installation record when not found in DB, then claims it", async () => {
      const newInstallation = {
        id: INSTALLATION_ID,
        installationId: "100",
        organizationId: null,
        status: "PENDING_CLAIM",
      };

      mockOAuthThroughInstallationResolve();

      const baseMockDb = makeClaimMockDb(newInstallation);
      const mockDb = {
        ...baseMockDb,
        gitHubInstallation: {
          ...baseMockDb.gitHubInstallation,
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue(newInstallation),
        },
      };
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);
      mockReposResponse([]);

      const result = await callOAuth();

      expect(mockDb.gitHubInstallation.upsert).toHaveBeenCalled();
      expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: INSTALLATION_ID },
          data: expect.objectContaining({
            status: "ACTIVE",
            organizationId: ORG_ID,
          }),
        })
      );
      expect(result.success).toBe(true);
    });

    it("returns { success: true } on successful connection and syncs repos", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION);
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);
      mockReposResponse([
        {
          id: 1,
          full_name: "org/repo1",
          name: "repo1",
          owner: { login: "org" },
          private: false,
        },
      ]);

      const result = await callOAuth();

      expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: INSTALLATION_ID },
          data: expect.objectContaining({
            status: "ACTIVE",
            organizationId: ORG_ID,
          }),
        })
      );
      expect(result).toEqual({ success: true });
    });

    it("logs warning and returns success when repo fetch fails after claiming", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION, false);
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await callOAuth();

      expect(result).toEqual({ success: true });
    });
  });
});
