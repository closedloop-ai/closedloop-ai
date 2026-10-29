/**
 * Unit tests for `githubService`.
 *
 * Covers:
 *  - `getIntegrationStatus` — connected and disconnected cases
 *  - `upsertInstallation` — create path and update path
 *  - `updateInstallationStatus` — success and database error cases
 *  - `findInstallationById` / `findInstallationByInstallationId` — found and null cases
 *  - `findInstallationForRepoFullName` — found and not-found cases
 *  - `removeRepositories` — tombstones specified repos, skips DB call when empty
 *  - `getRepositories` — active installation found and not found
 *  - `getBranches` — repository not found, org mismatch, and successful branch fetch
 *  - `getPullRequests` — repository not found, org mismatch, successful fetch with
 *    tracked PR URL resolution
 */

import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import type * as GitHubModule from "@repo/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import {
  mockWithDbCall,
  mockWithDbTx,
} from "../../../__tests__/utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  // Minimal `Prisma.sql`/`Prisma.join` so the set-based bulk-upsert path in
  // `addRepositories` builds its statement without pulling in the real client.
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

// The reads are stubbed, but the provider-result status contract and the
// failure classifier are the real ones: `acquireInstallationClient` folds a
// rejected mint into those statuses and the callers branch on them.
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
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/observability/error", () => ({
  parseError: vi.fn((err: unknown) => String(err)),
}));

vi.mock("@/app/integrations/github/public-repositories/service", () => ({
  publicRepositoryService: {
    getBranches: vi.fn(),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  GitHubDataConnectionSource,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";
import { GitHubInstallationStatus } from "@repo/database";
// Import after mocks are set up
import {
  getRepositoryBranches,
  getRepositoryPullRequestsWithMetadata,
} from "@repo/github";
import { getInstallationOctokit } from "@repo/github/installation-auth";

import { createInstallationDelegate } from "@/__tests__/support/integrations/github/installation-store.test-fixtures";
import {
  GITHUB_INSTALLATION_ID,
  makeRepoWithInstallation,
  mockRepoLookup,
  ORG_ID,
} from "@/__tests__/support/integrations/github/repository-lookup.test-fixtures";
import {
  bareBranchArtifactRow,
  trackedPrArtifactRow,
} from "@/__tests__/support/integrations/github/tracked-artifact-rows.test-fixtures";
import { publicRepositoryService } from "@/app/integrations/github/public-repositories/service";
import { githubService } from "@/app/integrations/github/service";

const mockGetRepositoryBranches = getRepositoryBranches as ReturnType<
  typeof vi.fn
>;
const mockGetRepositoryPullRequestsWithMetadata =
  getRepositoryPullRequestsWithMetadata as ReturnType<typeof vi.fn>;
const mockGetInstallationOctokit = getInstallationOctokit as ReturnType<
  typeof vi.fn
>;
const mockGetPublicRepositoryBranches =
  publicRepositoryService.getBranches as ReturnType<typeof vi.fn>;
const STATUS_USER_ID = "status-user-1";
const INSTALLATION_ID = "install-1";
// Marker object the mocked resolver mints; read functions must receive it
// as their first argument (PLN-1525: resolve once, thread down). It carries
// the one octokit method the OAuth-callback repo seeding calls directly.
const mockListReposAccessible = vi.fn();
const INSTALLATION_OCTOKIT = {
  kind: "installation-octokit",
  rest: {
    apps: { listReposAccessibleToInstallation: mockListReposAccessible },
  },
};

function makeIntegrationStatusDb({
  activeInstallation = null,
  installation = null,
  userGrant = null,
}: {
  activeInstallation?: { id: string } | null;
  installation?: Record<string, unknown> | null;
  userGrant?: ReturnType<typeof makeIntegrationStatusUserGrant> | null;
} = {}) {
  return {
    gitHubInstallation: {
      findFirst: vi.fn((args: { include?: unknown; select?: unknown }) =>
        Promise.resolve(args.include ? installation : activeInstallation)
      ),
    },
    gitHubUserConnection: {
      findUnique: vi.fn().mockResolvedValue(userGrant),
    },
  };
}

function makeIntegrationStatusUserGrant(
  overrides: Partial<{
    revokedAt: Date | null;
    scopes: string[];
  }> = {}
) {
  return {
    revokedAt: overrides.revokedAt ?? null,
    scopes: overrides.scopes ?? [GITHUB_REPO_SCOPE],
  };
}

describe("githubService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstallationOctokit.mockResolvedValue(INSTALLATION_OCTOKIT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getIntegrationStatus", () => {
    it("returns { connected: false } when no active installation exists", async () => {
      const mockDb = makeIntegrationStatusDb();
      mockWithDbCall(mockDb);

      const result = await githubService.getIntegrationStatus(
        ORG_ID,
        STATUS_USER_ID
      );

      expect(result).toEqual({
        connected: false,
        githubDataConnection: {
          connected: false,
          sources: [],
          oauthRequiredReasons: [
            GitHubOAuthRequiredReason.NoAppInstallation,
            GitHubOAuthRequiredReason.NoUserGrant,
          ],
        },
      });
    });

    it("returns { connected: true, installation: {...} } when active installation exists", async () => {
      const now = new Date();
      const mockDb = makeIntegrationStatusDb({
        activeInstallation: { id: INSTALLATION_ID },
        installation: {
          id: INSTALLATION_ID,
          installationId: GITHUB_INSTALLATION_ID,
          accountLogin: "my-org",
          accountType: "Organization",
          status: GitHubInstallationStatus.ACTIVE,
          repositorySelection: "all",
          claimedAt: now,
          createdAt: now,
          repositories: [{ id: "repo-1" }, { id: "repo-2" }],
        },
      });
      mockWithDbCall(mockDb);

      const result = await githubService.getIntegrationStatus(
        ORG_ID,
        STATUS_USER_ID
      );

      expect(result).toEqual({
        connected: true,
        githubDataConnection: {
          connected: true,
          sources: [GitHubDataConnectionSource.GitHubApp],
          oauthRequiredReasons: [],
        },
        installation: {
          id: INSTALLATION_ID,
          installationId: GITHUB_INSTALLATION_ID,
          accountLogin: "my-org",
          accountType: "Organization",
          status: GitHubInstallationStatus.ACTIVE,
          repositorySelection: "all",
          repositoryCount: 2,
          claimedAt: now.toISOString(),
          createdAt: now.toISOString(),
        },
      });
      expect(mockDb.gitHubInstallation.findFirst).toHaveBeenCalledTimes(1);
    });

    it("keeps legacy installation disconnected while user-token data is connected", async () => {
      const mockDb = makeIntegrationStatusDb({
        userGrant: makeIntegrationStatusUserGrant(),
      });
      mockWithDbCall(mockDb);

      const result = await githubService.getIntegrationStatus(
        ORG_ID,
        STATUS_USER_ID
      );

      expect(result).toEqual({
        connected: false,
        githubDataConnection: {
          connected: true,
          sources: [GitHubDataConnectionSource.UserOAuth],
          oauthRequiredReasons: [],
        },
      });
    });
  });

  // ISS-6666: these assert the installation record the service PRODUCES, not
  // the `where`/`create`/`update` payload it built. `toHaveBeenCalledWith` on a
  // Prisma call passes even when correct arguments are handed to the wrong
  // model or the result is discarded, so the delegates below resolve `where`
  // against a seeded corpus and a wrong filter yields a different record.
  describe("upsertInstallation", () => {
    it("creates a pending-claim installation and leaves other installations alone", async () => {
      const installations = createInstallationDelegate([
        {
          id: "other-install",
          installationId: "gh-install-999",
          accountLogin: "other-org",
          status: GitHubInstallationStatus.ACTIVE,
        },
      ]);
      mockWithDbCall({ gitHubInstallation: installations });

      const result = await githubService.upsertInstallation(
        GITHUB_INSTALLATION_ID,
        {
          accountId: "acc-1",
          accountLogin: "my-org",
          accountType: "Organization",
          senderLogin: "user",
          senderId: "u-1",
          permissions: { contents: "read" },
          events: ["push"],
          repositorySelection: "all",
          organizationId: ORG_ID,
        }
      );

      expect(result).toEqual(
        expect.objectContaining({
          installationId: GITHUB_INSTALLATION_ID,
          accountId: "acc-1",
          accountLogin: "my-org",
          accountType: "Organization",
          senderLogin: "user",
          senderId: "u-1",
          permissions: { contents: "read" },
          events: ["push"],
          repositorySelection: "all",
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.PENDING_CLAIM,
        })
      );
      expect(installations.rowById("other-install")).toEqual({
        id: "other-install",
        installationId: "gh-install-999",
        accountLogin: "other-org",
        status: GitHubInstallationStatus.ACTIVE,
      });
    });

    it("updates the existing installation in place without resetting its claimed status", async () => {
      // Every seeded value differs from the incoming one, so a field the update
      // payload fails to carry stays visible as the stale value.
      const installations = createInstallationDelegate([
        {
          id: INSTALLATION_ID,
          installationId: GITHUB_INSTALLATION_ID,
          accountId: "stale-acc",
          accountLogin: "stale-login",
          accountType: "User",
          senderLogin: "stale-sender",
          senderId: "stale-u",
          repositorySelection: "selected",
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.ACTIVE,
        },
      ]);
      mockWithDbCall({ gitHubInstallation: installations });

      const result = await githubService.upsertInstallation(
        GITHUB_INSTALLATION_ID,
        {
          accountId: "acc-1",
          accountLogin: "renamed-org",
          accountType: "Organization",
          senderLogin: "user",
          senderId: "u-1",
          permissions: { contents: "read" },
          events: ["push"],
          repositorySelection: "all",
        }
      );

      // No second row: the upsert has to resolve the installation by its GitHub
      // installation id, not mint a duplicate under a different key.
      expect(installations.rows).toHaveLength(1);
      expect(result).toEqual({
        id: INSTALLATION_ID,
        installationId: GITHUB_INSTALLATION_ID,
        accountId: "acc-1",
        accountLogin: "renamed-org",
        accountType: "Organization",
        senderLogin: "user",
        senderId: "u-1",
        permissions: { contents: "read" },
        events: ["push"],
        repositorySelection: "all",
        organizationId: ORG_ID,
        // An omitted status must leave the claim intact — writing the create
        // default here would silently un-claim a live installation.
        status: GitHubInstallationStatus.ACTIVE,
      });
    });

    it("writes the caller's status on both the create and the update path", async () => {
      const created = createInstallationDelegate();
      mockWithDbCall({ gitHubInstallation: created });
      const activeInput = {
        accountId: "acc-1",
        accountLogin: "my-org",
        accountType: "Organization",
        senderLogin: "user",
        senderId: "u-1",
        status: GitHubInstallationStatus.ACTIVE,
      };

      const createdInstallation = await githubService.upsertInstallation(
        GITHUB_INSTALLATION_ID,
        activeInput
      );

      const existing = createInstallationDelegate([
        {
          id: INSTALLATION_ID,
          installationId: GITHUB_INSTALLATION_ID,
          status: GitHubInstallationStatus.PENDING_CLAIM,
        },
      ]);
      mockWithDbCall({ gitHubInstallation: existing });

      const updatedInstallation = await githubService.upsertInstallation(
        GITHUB_INSTALLATION_ID,
        activeInput
      );

      expect(createdInstallation.status).toBe(GitHubInstallationStatus.ACTIVE);
      expect(updatedInstallation.status).toBe(GitHubInstallationStatus.ACTIVE);
    });
  });

  describe("updateInstallationStatus", () => {
    it("suspends the addressed installation and only that one", async () => {
      const installations = createInstallationDelegate([
        {
          id: INSTALLATION_ID,
          installationId: GITHUB_INSTALLATION_ID,
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.ACTIVE,
        },
        {
          id: "other-install",
          installationId: "gh-install-999",
          organizationId: "org-2",
          status: GitHubInstallationStatus.ACTIVE,
        },
      ]);
      mockWithDbCall({ gitHubInstallation: installations });
      const suspendedAt = new Date("2026-08-16T00:00:00.000Z");

      const result = await githubService.updateInstallationStatus(
        INSTALLATION_ID,
        GitHubInstallationStatus.SUSPENDED,
        { suspendedAt, suspendedBy: "u-9" }
      );

      expect(result).toEqual({
        id: INSTALLATION_ID,
        installationId: GITHUB_INSTALLATION_ID,
        organizationId: ORG_ID,
        status: GitHubInstallationStatus.SUSPENDED,
        suspendedAt,
        suspendedBy: "u-9",
      });
      expect(installations.rowById(INSTALLATION_ID)).toEqual(result);
      expect(installations.rowById("other-install")?.status).toBe(
        GitHubInstallationStatus.ACTIVE
      );

      const claimedAt = new Date("2026-08-16T01:00:00.000Z");
      const reclaimed = await githubService.updateInstallationStatus(
        INSTALLATION_ID,
        GitHubInstallationStatus.ACTIVE,
        { claimedAt, claimedByUserId: "u-7", suspendedAt: null }
      );

      expect(reclaimed).toEqual(
        expect.objectContaining({
          status: GitHubInstallationStatus.ACTIVE,
          claimedAt,
          claimedByUserId: "u-7",
          // An explicit null clears the column; only `undefined` means "leave it".
          suspendedAt: null,
          suspendedBy: "u-9",
        })
      );
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
    it("tombstones active repositories with the specified githubRepoIds", async () => {
      const mockDb = {
        gitHubInstallationRepository: {
          updateMany: vi.fn().mockResolvedValue({ count: 2 }),
        },
      };
      mockWithDbCall(mockDb);

      await githubService.removeRepositories(INSTALLATION_ID, ["r-1", "r-2"]);

      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).toHaveBeenCalledWith({
        where: {
          installationId: INSTALLATION_ID,
          githubRepoId: { in: ["r-1", "r-2"] },
          removedAt: null,
        },
        data: {
          removedAt: expect.any(Date),
        },
      });
    });

    it("skips DB call when githubRepoIds is empty", async () => {
      const mockDb = {
        gitHubInstallationRepository: {
          updateMany: vi.fn(),
        },
      };
      mockWithDbCall(mockDb);

      await githubService.removeRepositories(INSTALLATION_ID, []);

      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).not.toHaveBeenCalled();
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
      mockGetPublicRepositoryBranches.mockRejectedValueOnce(
        new Error("Repository not found")
      );

      await expect(githubService.getBranches("repo-1", ORG_ID)).rejects.toThrow(
        "Repository not found"
      );
    });

    it("never loads a repository belonging to another organization", async () => {
      // The org predicate lives in the query now, so another org's row is
      // INVISIBLE rather than loaded-then-rejected. That also removes the
      // cross-tenant oracle the old error text carried: "another org owns this
      // id" and "no such id" are no longer distinguishable.
      mockRepoLookup(makeRepoWithInstallation({ orgId: "other-org" }));

      await expect(
        githubService.getBranches("repo-1", ORG_ID, 20, false)
      ).rejects.toThrow("Repository not found");
      expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
      expect(mockGetRepositoryBranches).not.toHaveBeenCalled();
    });

    it("does not fetch provider branches for a suspended installation", async () => {
      mockRepoLookup(
        makeRepoWithInstallation({
          status: GitHubInstallationStatus.SUSPENDED,
        })
      );

      await expect(
        githubService.getBranches("repo-1", ORG_ID, 20, false)
      ).rejects.toThrow("Repository not found");
      expect(mockGetRepositoryBranches).not.toHaveBeenCalled();
    });

    it("returns branch list on successful fetch", async () => {
      const branches = [{ name: "main" }, { name: "feature" }];
      mockRepoLookup(makeRepoWithInstallation());
      mockGetRepositoryBranches.mockResolvedValue(branches);

      const result = await githubService.getBranches("repo-1", ORG_ID);

      expect(mockGetInstallationOctokit).toHaveBeenCalledWith(
        GITHUB_INSTALLATION_ID
      );
      expect(mockGetRepositoryBranches).toHaveBeenCalledWith(
        INSTALLATION_OCTOKIT,
        "org",
        "repo",
        20
      );
      expect(mockGetPublicRepositoryBranches).not.toHaveBeenCalled();
      expect(result).toEqual({ branches });
    });

    it("does not fetch provider branches for tombstoned repositories", async () => {
      // `removedAt` is a query predicate now, so a tombstoned row is invisible
      // to the installation lane. With the public fallback closed that surfaces
      // as not-found, exactly as before; what must never happen either way is a
      // provider read against a repository the org tombstoned.
      mockRepoLookup(makeRepoWithInstallation({ removedAt: new Date() }));

      await expect(
        githubService.getBranches("repo-1", ORG_ID, 20, false)
      ).rejects.toThrow("Repository not found");

      expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
      expect(mockGetRepositoryBranches).not.toHaveBeenCalled();
      expect(mockGetPublicRepositoryBranches).not.toHaveBeenCalled();
    });

    it("falls back to public repositories when the repo is not installation-backed", async () => {
      const branches = [{ name: "main", isDefault: true }];
      mockRepoLookup(null);
      mockGetPublicRepositoryBranches.mockResolvedValueOnce({ branches });

      const result = await githubService.getBranches("repo-1", ORG_ID);

      expect(mockGetPublicRepositoryBranches).toHaveBeenCalledWith(
        "repo-1",
        ORG_ID,
        20
      );
      expect(mockGetRepositoryBranches).not.toHaveBeenCalled();
      expect(result).toEqual({ branches });
    });

    it("fails closed for non-installation repos when public fallback is disabled", async () => {
      mockRepoLookup(null);

      await expect(
        githubService.getBranches("repo-1", ORG_ID, 20, false)
      ).rejects.toThrow("Repository not found");

      expect(mockGetPublicRepositoryBranches).not.toHaveBeenCalled();
      expect(mockGetRepositoryBranches).not.toHaveBeenCalled();
    });

    it("still serves installation-backed repos when public fallback is disabled", async () => {
      const branches = [{ name: "main" }];
      mockRepoLookup(makeRepoWithInstallation());
      mockGetRepositoryBranches.mockResolvedValue(branches);

      const result = await githubService.getBranches(
        "repo-1",
        ORG_ID,
        20,
        false
      );

      expect(mockGetPublicRepositoryBranches).not.toHaveBeenCalled();
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

    it("never loads a repository belonging to another organization", async () => {
      mockRepoLookup(makeRepoWithInstallation({ orgId: "other-org" }));

      await expect(
        githubService.getPullRequests("repo-1", ORG_ID, null)
      ).rejects.toThrow("Repository not found");
      expect(mockGetRepositoryPullRequestsWithMetadata).not.toHaveBeenCalled();
    });

    it("returns pull requests without tracked PR URLs when projectId is null", async () => {
      const prs = [
        {
          githubId: "pr-1",
          number: 1,
          title: "Ship cloud PR data",
          htmlUrl: "https://github.com/org/repo/pull/1",
          headBranch: "feature/cloud-pr-data",
          baseBranch: "main",
          headSha: "head-sha",
          state: GitHubPRState.Open,
          isDraft: false,
          additions: 33,
          deletions: 7,
          changedFiles: 4,
          closedAt: null,
          mergedAt: null,
          mergeCommitSha: null,
          updatedAt: "2026-07-06T07:00:00Z",
          author: "octocat",
          checksStatus: ChecksStatus.Passing,
          reviewDecision: ReviewDecision.Approved,
        },
      ];
      mockRepoLookup(makeRepoWithInstallation());
      mockGetRepositoryPullRequestsWithMetadata.mockResolvedValue({
        pullRequests: prs,
        hasMore: true,
        truncated: true,
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        stopReason: "page_limit",
        missingTargetNumbers: [],
      });

      const result = await githubService.getPullRequests(
        "repo-1",
        ORG_ID,
        null
      );

      expect(result).toEqual({
        pullRequests: prs,
        hasMore: true,
        truncated: true,
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        stopReason: "page_limit",
        missingTargetNumbers: [],
        trackedPrUrls: [],
        trackedBranches: [],
        trackedBranchKeys: [],
      });
    });

    it("does not fetch provider pull requests for tombstoned repositories", async () => {
      mockRepoLookup(makeRepoWithInstallation({ removedAt: new Date() }));

      await expect(
        githubService.getPullRequests("repo-1", ORG_ID, null)
      ).rejects.toThrow("Repository not found");

      expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
      expect(mockGetRepositoryPullRequestsWithMetadata).not.toHaveBeenCalled();
    });

    it("returns tracked branch state and PR URL compatibility from project artifacts when projectId is provided", async () => {
      const prs = [{ id: "pr-1" }];
      const prUrl = "https://github.com/org/repo/pull/42";

      const mockDb = {
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(makeRepoWithInstallation()),
        },
        artifact: {
          findMany: vi.fn().mockResolvedValue([
            trackedPrArtifactRow({
              branchName: "feature-42",
              number: 42,
              repositoryFullName: "org/repo",
            }),
            bareBranchArtifactRow({
              branchName: "branch-only",
              repositoryFullName: "org/repo",
            }),
          ]),
        },
      };
      mockWithDbCall(mockDb);
      mockGetRepositoryPullRequestsWithMetadata.mockResolvedValue({
        pullRequests: prs,
        hasMore: false,
        truncated: false,
        pageInfo: { hasNextPage: false, endCursor: null },
        stopReason: "complete",
        missingTargetNumbers: [],
      });

      const result = await githubService.getPullRequests(
        "repo-1",
        ORG_ID,
        "proj-1"
      );

      expect(result.pullRequests).toBe(prs);
      expect(mockGetInstallationOctokit).toHaveBeenCalledWith(
        GITHUB_INSTALLATION_ID
      );
      expect(mockGetRepositoryPullRequestsWithMetadata).toHaveBeenCalledWith(
        INSTALLATION_OCTOKIT,
        "org",
        "repo",
        expect.objectContaining({
          maxItems: 500,
          maxPages: 20,
          targetNumbers: [42],
        }),
        undefined,
        expect.anything()
      );
      expect(result.trackedPrUrls).toContain(prUrl);
      expect(result.trackedBranches).toContainEqual({
        branchName: "branch-only",
        branchKey: "org/repo:branch-only",
        htmlUrl: "https://github.com/org/repo/tree/branch-only",
        pullRequestUrl: null,
      });
    });

    it("throws when getRepositoryPullRequestsWithMetadata rejects", async () => {
      mockRepoLookup(makeRepoWithInstallation());
      mockGetRepositoryPullRequestsWithMetadata.mockRejectedValue(
        new Error("GitHub API error")
      );

      await expect(
        githubService.getPullRequests("repo-1", ORG_ID, null)
      ).rejects.toThrow("Failed to fetch pull requests from GitHub");
    });
  });

  describe("confirmDifferentAccountReset (PLN-634)", () => {
    const USER_ID = "user-1";
    const PRIOR_INSTALLATION_ID = "prior-uuid";
    const NEW_INSTALLATION_UUID = "new-uuid";
    const NEW_GH_INSTALLATION_ID = "200";

    function makeResetMockDb(overrides?: {
      prior?: Record<string, unknown> | null;
      newInstall?: Record<string, unknown> | null;
    }) {
      const prior =
        overrides?.prior === null
          ? null
          : (overrides?.prior ?? {
              id: PRIOR_INSTALLATION_ID,
              accountId: "old-1",
              accountLogin: "old-org",
              organizationId: ORG_ID,
              status: GitHubInstallationStatus.UNINSTALLED,
              pendingNewInstallationId: NEW_GH_INSTALLATION_ID,
            });
      const newInstall =
        overrides?.newInstall === null
          ? null
          : (overrides?.newInstall ?? {
              id: NEW_INSTALLATION_UUID,
              installationId: NEW_GH_INSTALLATION_ID,
              accountId: "new-1",
              accountLogin: "new-org",
              organizationId: null,
              status: GitHubInstallationStatus.PENDING_CLAIM,
            });
      return {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(prior),
          findUnique: vi.fn().mockResolvedValue(newInstall),
          update: vi.fn().mockResolvedValue({}),
        },
        gitHubInstallationRepository: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        teamRepository: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        project: {
          findMany: vi.fn().mockResolvedValue([]),
          update: vi.fn(),
        },
      };
    }

    it("wipes team repos and clears project repo settings on confirm", async () => {
      const mockDb = makeResetMockDb();
      mockDb.teamRepository.deleteMany.mockResolvedValue({ count: 3 });
      // The project settings wipe lives in projectsService and uses
      // `withDb.tx()` — mock both surfaces with the same mockDb so the
      // inner call resolves correctly whether or not an outer tx is active.
      mockWithDbCall(mockDb);
      mockDb.project.findMany.mockResolvedValue([
        {
          id: "p1",
          settings: {
            repositoryOverrides: {
              selectedRepoIds: ["old"],
              primaryRepoId: "old",
            },
          },
        },
        { id: "p2", settings: { unrelated: "keep me" } },
        {
          id: "p3",
          settings: {
            repositoryOverrides: { foo: "bar" },
            other: "preserve",
          },
        },
      ]);
      mockWithDbTx(mockDb);

      const result = await githubService.confirmDifferentAccountReset({
        organizationId: ORG_ID,
        userId: USER_ID,
      });

      expect(result).toEqual({ ok: true, value: { confirmed: true } });
      expect(mockDb.teamRepository.deleteMany).toHaveBeenCalledWith({
        where: { team: { organizationId: ORG_ID } },
      });
      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).toHaveBeenCalledWith({
        where: { installationId: PRIOR_INSTALLATION_ID, removedAt: null },
        data: { removedAt: expect.any(Date) },
      });
      // Prior row's orgId cleared and pendingNewInstallationId zeroed
      expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith({
        where: { id: PRIOR_INSTALLATION_ID },
        data: { organizationId: null, pendingNewInstallationId: null },
        select: { id: true },
      });
      // New row claimed for the org
      expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith({
        where: { id: NEW_INSTALLATION_UUID },
        data: expect.objectContaining({
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.ACTIVE,
          claimedByUserId: USER_ID,
        }),
        select: { id: true },
      });
      // p1 + p3 had repository fields, p2 did not
      expect(mockDb.project.update).toHaveBeenCalledTimes(2);
    });

    it("rejects when there's no prior UNINSTALLED row", async () => {
      const mockDb = makeResetMockDb({ prior: null });
      mockWithDbTx(mockDb);

      const result = await githubService.confirmDifferentAccountReset({
        organizationId: ORG_ID,
        userId: USER_ID,
      });

      expect(result).toEqual({ ok: false, error: 400 });
      expect(mockDb.teamRepository.deleteMany).not.toHaveBeenCalled();
    });

    it("rejects when the prior row has no pinned pendingNewInstallationId", async () => {
      const mockDb = makeResetMockDb({
        prior: {
          id: PRIOR_INSTALLATION_ID,
          accountId: "old-1",
          accountLogin: "old-org",
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.UNINSTALLED,
          pendingNewInstallationId: null,
        },
      });
      mockWithDbTx(mockDb);

      const result = await githubService.confirmDifferentAccountReset({
        organizationId: ORG_ID,
        userId: USER_ID,
      });

      expect(result).toEqual({ ok: false, error: 400 });
      expect(mockDb.teamRepository.deleteMany).not.toHaveBeenCalled();
    });

    it("rejects when the new installation is the same account", async () => {
      const mockDb = makeResetMockDb({
        prior: {
          id: PRIOR_INSTALLATION_ID,
          accountId: "same-1",
          accountLogin: "same",
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.UNINSTALLED,
          pendingNewInstallationId: NEW_GH_INSTALLATION_ID,
        },
        newInstall: {
          id: NEW_INSTALLATION_UUID,
          installationId: NEW_GH_INSTALLATION_ID,
          accountId: "same-1",
          accountLogin: "same",
          organizationId: null,
          status: GitHubInstallationStatus.PENDING_CLAIM,
        },
      });
      mockWithDbTx(mockDb);

      const result = await githubService.confirmDifferentAccountReset({
        organizationId: ORG_ID,
        userId: USER_ID,
      });

      expect(result).toEqual({ ok: false, error: 400 });
      expect(mockDb.teamRepository.deleteMany).not.toHaveBeenCalled();
    });

    it("rejects when new install is already claimed by another org", async () => {
      const mockDb = makeResetMockDb({
        newInstall: {
          id: NEW_INSTALLATION_UUID,
          installationId: NEW_GH_INSTALLATION_ID,
          accountId: "new-1",
          accountLogin: "new-org",
          organizationId: "another-org",
          status: GitHubInstallationStatus.ACTIVE,
        },
      });
      mockWithDbTx(mockDb);

      const result = await githubService.confirmDifferentAccountReset({
        organizationId: ORG_ID,
        userId: USER_ID,
      });

      expect(result).toEqual({ ok: false, error: 403 });
      expect(mockDb.teamRepository.deleteMany).not.toHaveBeenCalled();
    });
  });
});
