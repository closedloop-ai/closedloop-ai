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
 *  - `removeRepositories` — tombstones specified repos, skips DB call when empty
 *  - `disconnectInstallation` — idempotent no-op, org-scoped GitHub uninstall
 *    success and failure, database update
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
import {
  getMockWithDb,
  mockWithDbAll,
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

vi.mock("@/lib/integration-encryption", () => ({
  encryptTokenPair: vi.fn().mockResolvedValue({
    encryptedAccessToken: "encrypted-access-token",
    encryptedRefreshToken: "encrypted-refresh-token",
  }),
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
  deleteInstallation,
  getRepositoryBranches,
  getRepositoryPullRequestsWithMetadata,
} from "@repo/github";
import { getInstallationOctokit } from "@repo/github/installation-auth";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { publicRepositoryService } from "@/app/integrations/github/public-repositories/service";
import { githubService } from "@/app/integrations/github/service";
import {
  RepositoryArtifactRelinkFailureReason,
  RepositoryArtifactRelinkFailureStage,
  RepositoryArtifactRelinkMetricName,
  RepositoryArtifactRelinkStatus,
} from "@/app/integrations/github/service/repository-relink-telemetry";
import { REPO_UPSERT_CHUNK_SIZE } from "@/app/integrations/github/service/repository-sync";
import { encryptTokenPair } from "@/lib/integration-encryption";

const mockDeleteInstallation = deleteInstallation as ReturnType<typeof vi.fn>;
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
const mockEncryptTokenPair = encryptTokenPair as ReturnType<typeof vi.fn>;
const mockEmitTelemetryMetric = emitTelemetryMetric as ReturnType<typeof vi.fn>;

const ORG_ID = "org-1";
const STATUS_USER_ID = "status-user-1";
const INSTALLATION_ID = "install-1";
const GITHUB_INSTALLATION_ID = "gh-install-100";
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

function makeRepoWithInstallation(overrides?: {
  orgId?: string;
  fullName?: string;
  removedAt?: Date | null;
  status?: string;
}) {
  return {
    id: "repo-1",
    fullName: overrides?.fullName ?? "org/repo",
    removedAt: overrides?.removedAt ?? null,
    installation: {
      organizationId: overrides?.orgId ?? ORG_ID,
      installationId: GITHUB_INSTALLATION_ID,
      status: overrides?.status ?? GitHubInstallationStatus.ACTIVE,
    },
  };
}

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
    tokenExpiresAt: Date | null;
  }> = {}
) {
  return {
    revokedAt: overrides.revokedAt ?? null,
    tokenExpiresAt: overrides.tokenExpiresAt ?? null,
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
          status: GitHubInstallationStatus.PENDING_CLAIM,
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
        status: GitHubInstallationStatus.ACTIVE,
      });

      const call = mockDb.gitHubInstallation.upsert.mock.calls[0][0];
      expect(call.create.status).toBe(GitHubInstallationStatus.ACTIVE);
    });
  });

  describe("updateInstallationStatus", () => {
    it("updates status and logs success", async () => {
      const updated = {
        id: INSTALLATION_ID,
        status: GitHubInstallationStatus.SUSPENDED,
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
        GitHubInstallationStatus.SUSPENDED
      );

      expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith({
        where: { id: INSTALLATION_ID },
        data: { status: GitHubInstallationStatus.SUSPENDED },
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
    it("tombstones stale repos and upserts incoming repos", async () => {
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
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue({
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.ACTIVE,
          }),
        },
        gitHubInstallationRepository: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          upsert: vi.fn().mockResolvedValue({ id: "repo-rec-1" }),
          findMany: vi
            .fn()
            // 1. tombstone diff read: r-1 stays, stale-1 disappears.
            .mockResolvedValueOnce([
              { githubRepoId: "r-1" },
              { githubRepoId: "stale-1" },
            ])
            // 2. post-upsert syncedRepositories read.
            .mockResolvedValueOnce([
              {
                id: "repo-rec-1",
                githubRepoId: "r-1",
                fullName: "org/repo1",
              },
            ])
            // 3. relink candidate read.
            .mockResolvedValueOnce([]),
        },
        $executeRaw: vi.fn().mockResolvedValue(1),
      };
      mockWithDbTx(mockTx);

      const result = await githubService.syncRepositories(
        INSTALLATION_ID,
        repos
      );

      // ISS-4618: the tombstone no longer binds a per-repo `notIn` list (which
      // overflows Postgres's 65,535 bind-parameter ceiling on a large grant).
      // It diffs the installation's non-removed ids in memory and tombstones
      // only the ones absent from the incoming set, via a chunked `in` update.
      expect(
        mockTx.gitHubInstallationRepository.updateMany
      ).toHaveBeenCalledWith({
        where: {
          installationId: INSTALLATION_ID,
          githubRepoId: { in: ["stale-1"] },
          removedAt: null,
        },
        data: {
          removedAt: expect.any(Date),
        },
      });
      // ISS-4618: syncRepositories now upserts via one set-based $executeRaw
      // (chunked), not a per-row upsert. The stored-value assertions live in the
      // real-Postgres integration test (template-seed-race sibling).
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockTx.gitHubInstallationRepository.upsert).not.toHaveBeenCalled();
      expect(result).toEqual([
        { id: "repo-rec-1", githubRepoId: "r-1", fullName: "org/repo1" },
      ]);
      expect(mockTx.gitHubInstallationRepository.findMany).toHaveBeenCalledWith(
        {
          where: { installationId: INSTALLATION_ID, removedAt: null },
        }
      );
      expect(mockTx.gitHubInstallation.findFirst).toHaveBeenCalledWith({
        where: {
          id: INSTALLATION_ID,
          status: GitHubInstallationStatus.ACTIVE,
          organizationId: { not: null },
        },
        select: { organizationId: true, status: true },
      });
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: RepositoryArtifactRelinkMetricName.Completed,
          status: RepositoryArtifactRelinkStatus.Skipped,
          reasonCount: 0,
        })
      );
      const completedMetric = mockEmitTelemetryMetric.mock.calls.find(
        ([payload]) =>
          payload.metric === RepositoryArtifactRelinkMetricName.Completed
      )?.[0] as Record<string, unknown> | undefined;
      expect(completedMetric).toBeDefined();
      expect(completedMetric).not.toHaveProperty("organizationId");
      expect(completedMetric).not.toHaveProperty("installationId");
      expect(completedMetric).not.toHaveProperty("repoFullName");
      expect(completedMetric).not.toHaveProperty("branchName");
      expect(completedMetric).not.toHaveProperty("token");
      expect(completedMetric).not.toHaveProperty("userId");
    });

    it("returns empty array and skips upsert when repository list is empty", async () => {
      const mockTx = {
        gitHubInstallationRepository: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          upsert: vi.fn(),
          // Tombstone diff read: one active repo, absent from the empty
          // incoming set, so it is tombstoned.
          findMany: vi.fn().mockResolvedValue([{ githubRepoId: "old-1" }]),
        },
      };
      mockWithDbTx(mockTx);

      const result = await githubService.syncRepositories(INSTALLATION_ID, []);

      // ISS-4618: empty incoming set tombstones every active repo (the old
      // `notIn: []` matched all rows too) — via a chunked `in` update over the
      // diffed ids, never a per-repo `notIn` list.
      expect(
        mockTx.gitHubInstallationRepository.updateMany
      ).toHaveBeenCalledWith({
        where: {
          installationId: INSTALLATION_ID,
          githubRepoId: { in: ["old-1"] },
          removedAt: null,
        },
        data: {
          removedAt: expect.any(Date),
        },
      });
      expect(mockTx.gitHubInstallationRepository.upsert).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it("returns synced repositories when the separate relink transaction fails", async () => {
      const syncedRepositories = [
        {
          id: "repo-rec-1",
          githubRepoId: "r-1",
          fullName: "org/repo1",
        },
      ];
      const syncTx = {
        gitHubInstallationRepository: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          upsert: vi.fn().mockResolvedValue({ id: "repo-rec-1" }),
          findMany: vi.fn().mockResolvedValue(syncedRepositories),
        },
        $executeRaw: vi.fn().mockResolvedValue(1),
      };
      getMockWithDb().tx = vi
        .fn()
        .mockImplementationOnce((callback) => callback(syncTx))
        .mockRejectedValueOnce(new Error("relink failed"));

      const result = await githubService.syncRepositories(INSTALLATION_ID, [
        {
          githubRepoId: "r-1",
          fullName: "org/repo1",
          name: "repo1",
          owner: "org",
          private: false,
        },
      ]);

      expect(result).toBe(syncedRepositories);
      expect(syncTx.$executeRaw).toHaveBeenCalled();
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith({
        metric: RepositoryArtifactRelinkMetricName.Failed,
        count: 1,
        stage: RepositoryArtifactRelinkFailureStage.SyncRepositories,
        reason: RepositoryArtifactRelinkFailureReason.TransactionFailed,
      });
    });

    it("keeps repository sync successful when relink metric emission throws", async () => {
      const syncedRepositories = [
        {
          id: "repo-rec-1",
          githubRepoId: "r-1",
          fullName: "org/repo1",
        },
      ];
      const mockTx = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue({
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.ACTIVE,
          }),
        },
        gitHubInstallationRepository: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          upsert: vi.fn().mockResolvedValue({ id: "repo-rec-1" }),
          findMany: vi
            .fn()
            // tombstone diff read (all incoming, nothing to tombstone), then
            // syncedRepositories read, then the relink candidate read.
            .mockResolvedValueOnce(syncedRepositories)
            .mockResolvedValueOnce(syncedRepositories)
            .mockResolvedValueOnce([]),
        },
      };
      mockWithDbTx(mockTx);
      mockEmitTelemetryMetric
        .mockImplementationOnce(() => {
          throw new Error("telemetry unavailable");
        })
        .mockImplementationOnce(() => undefined);

      const result = await githubService.syncRepositories(INSTALLATION_ID, [
        {
          githubRepoId: "r-1",
          fullName: "org/repo1",
          name: "repo1",
          owner: "org",
          private: false,
        },
      ]);

      expect(result).toBe(syncedRepositories);
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith({
        metric: RepositoryArtifactRelinkMetricName.Failed,
        count: 1,
        stage: RepositoryArtifactRelinkFailureStage.SyncRepositories,
        reason: RepositoryArtifactRelinkFailureReason.TelemetryEmitFailed,
      });
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
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue({
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.ACTIVE,
          }),
        },
        gitHubInstallationRepository: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce([
              {
                id: "repo-rec-2",
                githubRepoId: "r-2",
                fullName: "org/repo2",
              },
            ])
            .mockResolvedValueOnce([]),
        },
        $executeRaw: vi.fn().mockResolvedValue(1),
      };
      mockWithDbTx(mockTx);

      const result = await githubService.addRepositories(
        INSTALLATION_ID,
        repos
      );

      // One set-based bulk upsert, not a per-row `upsert` fan-out (ISS-4618).
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        { id: "repo-rec-2", githubRepoId: "r-2", fullName: "org/repo2" },
      ]);
      expect(mockTx.gitHubInstallation.findFirst).toHaveBeenCalledWith({
        where: {
          id: INSTALLATION_ID,
          status: GitHubInstallationStatus.ACTIVE,
          organizationId: { not: null },
        },
        select: { organizationId: true, status: true },
      });
    });

    it("returns empty array without hitting DB when input is empty", async () => {
      const mockTx = {
        gitHubInstallationRepository: {
          findMany: vi.fn(),
        },
        $executeRaw: vi.fn(),
      };
      mockWithDbTx(mockTx);

      const result = await githubService.addRepositories(INSTALLATION_ID, []);

      expect(mockTx.$executeRaw).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it("returns added repositories when the separate relink transaction fails", async () => {
      const addedRepositories = [
        {
          id: "repo-rec-2",
          githubRepoId: "r-2",
          fullName: "org/repo2",
        },
      ];
      const addTx = {
        gitHubInstallationRepository: {
          findMany: vi.fn().mockResolvedValue(addedRepositories),
        },
        $executeRaw: vi.fn().mockResolvedValue(1),
      };
      getMockWithDb().tx = vi
        .fn()
        .mockImplementationOnce((callback) => callback(addTx))
        .mockRejectedValueOnce(new Error("relink failed"));

      const result = await githubService.addRepositories(INSTALLATION_ID, [
        {
          githubRepoId: "r-2",
          fullName: "org/repo2",
          name: "repo2",
          owner: "org",
          private: true,
        },
      ]);

      // ISS-4618: the lookup is now a chunked `in` union, so it returns a fresh
      // array with the same rows (not the mock's reference).
      expect(result).toEqual(addedRepositories);
      expect(addTx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith({
        metric: RepositoryArtifactRelinkMetricName.Failed,
        count: 1,
        stage: RepositoryArtifactRelinkFailureStage.AddRepositories,
        reason: RepositoryArtifactRelinkFailureReason.TransactionFailed,
      });
    });

    it("keeps repository add successful when relink metric emission throws", async () => {
      const addedRepositories = [
        {
          id: "repo-rec-2",
          githubRepoId: "r-2",
          fullName: "org/repo2",
        },
      ];
      const mockTx = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue({
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.ACTIVE,
          }),
        },
        gitHubInstallationRepository: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce(addedRepositories)
            .mockResolvedValueOnce([]),
        },
        $executeRaw: vi.fn().mockResolvedValue(1),
      };
      mockWithDbTx(mockTx);
      mockEmitTelemetryMetric
        .mockImplementationOnce(() => {
          throw new Error("telemetry unavailable");
        })
        .mockImplementationOnce(() => undefined);

      const result = await githubService.addRepositories(INSTALLATION_ID, [
        {
          githubRepoId: "r-2",
          fullName: "org/repo2",
          name: "repo2",
          owner: "org",
          private: true,
        },
      ]);

      // ISS-4618: chunked `in` lookup returns a fresh array (same rows).
      expect(result).toEqual(addedRepositories);
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith({
        metric: RepositoryArtifactRelinkMetricName.Failed,
        count: 1,
        stage: RepositoryArtifactRelinkFailureStage.AddRepositories,
        reason: RepositoryArtifactRelinkFailureReason.TelemetryEmitFailed,
      });
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

  describe("disconnectInstallation", () => {
    it("is a no-op when no installation is found for the organization", async () => {
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(null),
          updateMany: vi.fn(),
        },
      };
      mockWithDbCall(mockDb);

      await expect(
        githubService.disconnectInstallation(ORG_ID)
      ).resolves.toBeUndefined();

      expect(mockDb.gitHubInstallation.findFirst).toHaveBeenCalledTimes(1);
      expect(mockDeleteInstallation).not.toHaveBeenCalled();
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
    });

    it("does not uninstall an org-less installation from an unrelated org context", async () => {
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(null),
          updateMany: vi.fn(),
        },
      };
      mockWithDbCall(mockDb);
      mockDeleteInstallation.mockResolvedValue({ success: true });

      await githubService.disconnectInstallation(ORG_ID);

      expect(mockDb.gitHubInstallation.findFirst).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID },
      });
      expect(mockDeleteInstallation).not.toHaveBeenCalled();
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
    });

    it("still marks UNINSTALLED locally even when GitHub API uninstall fails", async () => {
      const installation = {
        id: INSTALLATION_ID,
        installationId: GITHUB_INSTALLATION_ID,
        organizationId: ORG_ID,
      };
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(installation),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockWithDbCall(mockDb);
      mockDeleteInstallation.mockResolvedValue({
        success: false,
        error: "GitHub API error",
      });

      await githubService.disconnectInstallation(ORG_ID);

      // Single write — only the UNINSTALLED status flip. orgId is preserved
      // so a same-account reconnect can reuse this row in-place.
      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledTimes(1);
      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledWith({
        where: { id: INSTALLATION_ID, organizationId: ORG_ID },
        data: { status: GitHubInstallationStatus.UNINSTALLED },
      });
    });

    it("marks installation as UNINSTALLED but preserves orgId on successful disconnect", async () => {
      const installation = {
        id: INSTALLATION_ID,
        installationId: GITHUB_INSTALLATION_ID,
        organizationId: ORG_ID,
      };
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(installation),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockWithDbCall(mockDb);
      mockDeleteInstallation.mockResolvedValue({ success: true });

      await githubService.disconnectInstallation(ORG_ID);

      expect(mockDeleteInstallation).toHaveBeenCalledWith(
        GITHUB_INSTALLATION_ID
      );
      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledTimes(1);
      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledWith({
        where: { id: INSTALLATION_ID, organizationId: ORG_ID },
        data: { status: GitHubInstallationStatus.UNINSTALLED },
      });
    });

    it("does not uninstall remotely or clear local state when ownership changes during disconnect", async () => {
      const installation = {
        id: INSTALLATION_ID,
        installationId: GITHUB_INSTALLATION_ID,
        organizationId: ORG_ID,
      };
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(installation),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      };
      mockWithDbCall(mockDb);
      mockDeleteInstallation.mockResolvedValue({ success: true });

      await githubService.disconnectInstallation(ORG_ID);

      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledWith({
        where: { id: INSTALLATION_ID, organizationId: ORG_ID },
        data: { status: GitHubInstallationStatus.UNINSTALLED },
      });
      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledTimes(1);
      expect(mockDeleteInstallation).not.toHaveBeenCalled();
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
      mockRepoLookup(makeRepoWithInstallation({ removedAt: new Date() }));

      await expect(githubService.getBranches("repo-1", ORG_ID)).rejects.toThrow(
        "Repository not found"
      );

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

    it("throws when repository belongs to a different organization", async () => {
      mockRepoLookup(makeRepoWithInstallation({ orgId: "other-org" }));

      await expect(
        githubService.getPullRequests("repo-1", ORG_ID, null)
      ).rejects.toThrow("Repository does not belong to organization");
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
      const branchUrl = "https://github.com/org/repo/tree/feature-42";

      const mockDb = {
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(makeRepoWithInstallation()),
        },
        artifact: {
          findMany: vi.fn().mockResolvedValue([
            {
              externalUrl: branchUrl,
              branch: {
                branchName: "feature-42",
                currentPullRequestDetail: { htmlUrl: prUrl },
              },
            },
            {
              externalUrl: "https://github.com/org/repo/tree/branch-only",
              branch: {
                branchName: "branch-only",
                currentPullRequestDetail: null,
              },
            },
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
          maxPages: 5,
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
      status: GitHubInstallationStatus.ACTIVE,
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
        json: () =>
          Promise.resolve({
            access_token: "user-access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            refresh_token_expires_in: 7200,
            scope: "",
          }),
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
          json: () =>
            Promise.resolve({
              node_id: "github-node-1",
              avatar_url: "https://github.example/avatar.png",
              html_url: "https://github.example/user",
              ...user,
            }),
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

    // The repo seeding reads the installation's own credential
    // (GET /installation/repositories via octokit), not the user token.
    function mockReposResponse(
      repos: {
        id: number;
        full_name: string;
        name: string;
        owner: { login: string };
        private: boolean;
      }[]
    ) {
      mockListReposAccessible.mockResolvedValueOnce({
        data: { repositories: repos },
      });
    }

    function makeRepoPage(count: number, startId = 1) {
      return Array.from({ length: count }, (_, index) => ({
        id: startId + index,
        full_name: `org/repo${startId + index}`,
        name: `repo${startId + index}`,
        owner: { login: "org" },
        private: false,
      }));
    }

    // GitHub reports the grant's own repository count alongside each page;
    // the walk reads it from the first page to detect a truncated result set.
    function mockReposResponseWithTotal(
      repos: ReturnType<typeof makeRepoPage>,
      totalCount: number
    ) {
      mockListReposAccessible.mockResolvedValueOnce({
        data: { total_count: totalCount, repositories: repos },
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
      // findFirst is called twice in the standard claim flow:
      //   1. PLN-634 reconnect detection (looking for prior UNINSTALLED row) -- null
      //   2. relinkStoredArtifactsForActiveInstallation -- returns the active row
      const base = {
        gitHubInstallation: {
          findUnique: vi.fn().mockResolvedValue(installation),
          findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.ACTIVE,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn().mockResolvedValue({
            ...installation,
            status: GitHubInstallationStatus.ACTIVE,
            organizationId: ORG_ID,
          }),
        },
        gitHubInstallationRepository: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        gitHubUserConnection: {
          upsert: vi.fn().mockResolvedValue({ id: "github-connection-1" }),
        },
        gitHubAccessCapability: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        // ISS-4618: syncRepositories/addRepositories bulk-upsert through
        // tx.$executeRaw (set-based) instead of per-row upsert.
        $executeRaw: vi.fn().mockResolvedValue(1),
      };
      if (!includeRepoSync) {
        return base;
      }
      return {
        ...base,
        gitHubInstallationRepository: {
          ...base.gitHubInstallationRepository,
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          upsert: vi.fn().mockResolvedValue({}),
        },
      };
    }

    it("returns error when token exchange fails", async () => {
      mockTokenExchangeFailure();

      const result = await callOAuth();

      expect(result).toMatchObject({
        status: "error",
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
        status: "error",
        error: expect.stringContaining("Code expired"),
      });
    });

    it("fails closed when fetchGitHubUser returns null (non-OK response)", async () => {
      mockTokenExchangeSuccess();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

      const result = await callOAuth();

      expect(result).toMatchObject({
        status: "error",
        error: "Failed to complete GitHub connection",
      });
    });

    it("returns error when resolveInstallation fails", async () => {
      mockTokenExchangeSuccess();
      mockUserFetch({ id: 1, login: "user" });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      const result = await callOAuth();

      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("Failed to verify installation access"),
      });
    });

    it("blocks claim when installation already belongs to another org", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = {
        gitHubInstallation: {
          // PLN-634 reconnect detection runs first; return null so we
          // proceed to the regular claim path.
          findFirst: vi.fn().mockResolvedValue(null),
          findUnique: vi.fn().mockResolvedValue({
            id: INSTALLATION_ID,
            installationId: GITHUB_INSTALLATION_ID,
            organizationId: "other-org",
            status: GitHubInstallationStatus.ACTIVE,
          }),
          updateMany: vi.fn(),
          upsert: vi.fn(),
        },
      };
      mockWithDbCall(mockDb);

      const result = await callOAuth();

      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining(
          "already connected to another organization"
        ),
      });
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
    });

    it("creates installation record when not found in DB, then claims it", async () => {
      const newInstallation = {
        id: INSTALLATION_ID,
        installationId: "100",
        organizationId: null,
        status: GitHubInstallationStatus.PENDING_CLAIM,
      };

      mockOAuthThroughInstallationResolve();

      const baseMockDb = makeClaimMockDb(newInstallation);
      const mockDb = {
        ...baseMockDb,
        gitHubInstallation: {
          ...baseMockDb.gitHubInstallation,
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(newInstallation),
        },
      };
      mockWithDbAll(mockDb);
      mockReposResponse([]);

      const result = await callOAuth();

      expect(mockDb.gitHubInstallation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            installationId: "100",
            status: GitHubInstallationStatus.PENDING_CLAIM,
          }),
        })
      );
      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: INSTALLATION_ID,
            OR: [{ organizationId: null }, { organizationId: ORG_ID }],
          },
          data: expect.objectContaining({
            status: GitHubInstallationStatus.ACTIVE,
            organizationId: ORG_ID,
          }),
        })
      );
      expect(mockEncryptTokenPair).toHaveBeenCalledWith(
        "user-access-token",
        "refresh-token"
      );
      expect(mockDb.gitHubUserConnection.upsert).toHaveBeenCalledWith({
        where: {
          organizationId_userId: {
            organizationId: ORG_ID,
            userId: USER_ID,
          },
        },
        create: expect.objectContaining({
          organizationId: ORG_ID,
          userId: USER_ID,
          githubUserId: "1",
          githubNodeId: "github-node-1",
          login: "user",
          normalizedLogin: "user",
          avatarUrl: "https://github.example/avatar.png",
          profileUrl: "https://github.example/user",
          accessTokenEncrypted: "encrypted-access-token",
          refreshTokenEncrypted: "encrypted-refresh-token",
          scopes: [],
        }),
        update: expect.objectContaining({
          accessTokenEncrypted: "encrypted-access-token",
          refreshTokenEncrypted: "encrypted-refresh-token",
          revokedAt: null,
          // PLN-1525: a fresh grant resets sync-pool credential state.
          healthState: "healthy",
          backoffUntil: null,
          windowSpend: 0,
          observedLimit: null,
          observedRemaining: null,
          observedResetAt: null,
        }),
        select: { id: true },
      });
      expect(mockDb.gitHubAccessCapability.deleteMany).toHaveBeenCalledWith({
        where: {
          githubUserConnectionId: "github-connection-1",
          organizationId: ORG_ID,
        },
      });
      expect(result).toEqual({ status: "connected" });
    });

    it("does not downgrade an installation claimed during missing-record creation race", async () => {
      mockOAuthThroughInstallationResolve();

      const claimedInstallation = {
        id: INSTALLATION_ID,
        installationId: "100",
        organizationId: "other-org",
        status: GitHubInstallationStatus.ACTIVE,
      };
      const baseMockDb = makeClaimMockDb(claimedInstallation);
      const mockDb = {
        ...baseMockDb,
        gitHubInstallation: {
          ...baseMockDb.gitHubInstallation,
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(claimedInstallation),
          create: vi.fn().mockRejectedValue({ code: "P2002" }),
          updateMany: vi.fn(),
        },
      };
      mockWithDbAll(mockDb);

      const result = await callOAuth();

      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining(
          "already connected to another organization"
        ),
      });
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
    });

    it("returns { status: connected } on successful connection and syncs repos", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION);
      mockWithDbAll(mockDb);
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

      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: INSTALLATION_ID,
            OR: [{ organizationId: null }, { organizationId: ORG_ID }],
          },
          data: expect.objectContaining({
            status: GitHubInstallationStatus.ACTIVE,
            organizationId: ORG_ID,
          }),
        })
      );
      expect(mockDb.gitHubUserConnection.upsert).toHaveBeenCalled();
      expect(result).toEqual({ status: "connected" });
    });

    it("fetches all repository pages with per_page=100 before syncing", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION);
      mockWithDbAll(mockDb);
      // A full first page signals another page; the short second page ends
      // the walk.
      mockReposResponse(makeRepoPage(100));
      mockReposResponse(makeRepoPage(1, 101));
      const repoSyncMock = mockDb.gitHubInstallationRepository as {
        findMany: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
      };

      const result = await callOAuth();

      expect(result).toEqual({ status: "connected" });
      // The seeding read uses the installation's own credential, never the
      // user token (PLN-1525 step 4 — /user/installations retirement).
      expect(mockGetInstallationOctokit).toHaveBeenCalledWith("100");
      // ISS-4618: syncRepositories bulk-upserts via one set-based $executeRaw.
      expect(
        (mockDb as unknown as { $executeRaw: ReturnType<typeof vi.fn> })
          .$executeRaw
      ).toHaveBeenCalled();
      // ISS-4618: the tombstone reads the installation's non-removed ids
      // (bound only to installation_id) and diffs in memory, instead of binding
      // a per-repo `notIn` list that overflows the 65,535 bind-parameter limit.
      expect(repoSyncMock.findMany).toHaveBeenCalledWith({
        where: { installationId: INSTALLATION_ID, removedAt: null },
        select: { githubRepoId: true },
      });
    });

    it("skips repository sync and emits partial metric when the walk ends short of total_count", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION);
      mockWithDbAll(mockDb);
      // A short page ends the walk, but the grant reports five repositories.
      mockReposResponseWithTotal(makeRepoPage(2), 5);
      const repoSyncMock = mockDb.gitHubInstallationRepository as {
        updateMany: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
      };

      const result = await callOAuth();

      expect(result).toEqual({ status: "connected" });
      expect(repoSyncMock.upsert).not.toHaveBeenCalled();
      expect(repoSyncMock.updateMany).not.toHaveBeenCalled();
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith({
        metric: RepositoryArtifactRelinkMetricName.Failed,
        count: 1,
        stage: RepositoryArtifactRelinkFailureStage.OAuthClaim,
        reason: RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial,
      });
    });

    it("syncs repositories when the collected count matches total_count", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION);
      mockWithDbAll(mockDb);
      mockReposResponseWithTotal(makeRepoPage(2), 2);

      const result = await callOAuth();

      expect(result).toEqual({ status: "connected" });
      // ISS-4618: a complete walk reaches the bulk-upsert persistence.
      expect(
        (mockDb as unknown as { $executeRaw: ReturnType<typeof vi.fn> })
          .$executeRaw
      ).toHaveBeenCalled();
      expect(mockEmitTelemetryMetric).not.toHaveBeenCalledWith(
        expect.objectContaining({
          reason: RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial,
        })
      );
    });

    it("syncs repositories when the response carries no usable total_count", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION);
      mockWithDbAll(mockDb);
      // Older/stubbed responses omit total_count; the short page still ends
      // the walk and the result stays complete.
      mockReposResponse(makeRepoPage(2));

      const result = await callOAuth();

      expect(result).toEqual({ status: "connected" });
      // ISS-4618: a complete walk reaches the bulk-upsert persistence.
      expect(
        (mockDb as unknown as { $executeRaw: ReturnType<typeof vi.fn> })
          .$executeRaw
      ).toHaveBeenCalled();
      expect(mockEmitTelemetryMetric).not.toHaveBeenCalledWith(
        expect.objectContaining({
          reason: RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial,
        })
      );
    });

    it("stops at the page cap and emits the partial metric when pages never run short", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION);
      mockWithDbAll(mockDb);
      const maxPages = 20;
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
        mockReposResponse(makeRepoPage(100, pageIndex * 100 + 1));
      }
      const repoSyncMock = mockDb.gitHubInstallationRepository as {
        updateMany: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
      };

      const result = await callOAuth();

      expect(result).toEqual({ status: "connected" });
      expect(mockListReposAccessible).toHaveBeenCalledTimes(maxPages);
      expect(repoSyncMock.upsert).not.toHaveBeenCalled();
      expect(repoSyncMock.updateMany).not.toHaveBeenCalled();
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith({
        metric: RepositoryArtifactRelinkMetricName.Failed,
        count: 1,
        stage: RepositoryArtifactRelinkFailureStage.OAuthClaim,
        reason: RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial,
      });
    });

    it("returns a connection failure without claiming when token encryption fails", async () => {
      mockOAuthThroughInstallationResolve();
      mockEncryptTokenPair.mockRejectedValueOnce(new Error("kms unavailable"));

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION);
      mockWithDbAll(mockDb);

      const result = await callOAuth();

      expect(result).toEqual({
        status: "error",
        error: "Failed to complete GitHub connection",
      });
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
      expect(mockDb.gitHubUserConnection.upsert).not.toHaveBeenCalled();
    });

    it("rolls back the claim when GitHub user connection upsert fails", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION);
      mockDb.gitHubUserConnection.upsert.mockRejectedValueOnce(
        new Error("upsert failed")
      );
      mockWithDbAll(mockDb);

      const result = await callOAuth();

      expect(result).toEqual({
        status: "error",
        error: "Failed to complete GitHub connection",
      });
      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalled();
      expect(mockDb.gitHubUserConnection.upsert).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("returns an ownership error when installation claim loses a race", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb({
        ...UNCLAIMED_INSTALLATION,
        organizationId: null,
      });
      mockDb.gitHubInstallation.updateMany.mockResolvedValueOnce({ count: 0 });
      mockWithDbAll(mockDb);

      const result = await callOAuth();

      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining(
          "already connected to another organization"
        ),
      });
      expect(
        mockDb.gitHubInstallationRepository.findMany
      ).not.toHaveBeenCalled();
      expect(mockDb.gitHubUserConnection.upsert).not.toHaveBeenCalled();
    });

    it("logs warning and returns success when repo fetch fails after claiming", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION, false);
      mockWithDbAll(mockDb);
      mockListReposAccessible.mockRejectedValueOnce(
        Object.assign(new Error("Server error"), { status: 500 })
      );

      const result = await callOAuth();

      expect(result).toEqual({ status: "connected" });
      expect(mockDb.gitHubInstallationRepository.findMany).toHaveBeenCalledWith(
        {
          where: { installationId: INSTALLATION_ID, removedAt: null },
          select: {
            githubRepoId: true,
            fullName: true,
            name: true,
            owner: true,
            private: true,
          },
        }
      );
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith({
        metric: RepositoryArtifactRelinkMetricName.Failed,
        count: 1,
        stage: RepositoryArtifactRelinkFailureStage.OAuthClaim,
        reason: RepositoryArtifactRelinkFailureReason.RepositoryFetchFailed,
      });
    });

    it("skips repository sync and emits partial metric when a later repository page fails", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION);
      mockWithDbAll(mockDb);
      // Full first page, then the second page read throws mid-walk.
      mockReposResponse(makeRepoPage(100));
      mockListReposAccessible.mockRejectedValueOnce(
        Object.assign(new Error("Bad gateway"), { status: 502 })
      );
      const repoSyncMock = mockDb.gitHubInstallationRepository as {
        updateMany: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
      };

      const result = await callOAuth();

      expect(result).toEqual({ status: "connected" });
      expect(repoSyncMock.updateMany).not.toHaveBeenCalled();
      expect(repoSyncMock.upsert).not.toHaveBeenCalled();
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith({
        metric: RepositoryArtifactRelinkMetricName.Failed,
        count: 1,
        stage: RepositoryArtifactRelinkFailureStage.OAuthClaim,
        reason: RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial,
      });
    });

    it("keeps OAuth success when activation-time artifact relink fails", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION, false);
      mockWithDbCall(mockDb);
      mockWithDbTx({
        ...mockDb,
        gitHubInstallationRepository: {
          findMany: vi.fn().mockRejectedValue(new Error("relink failed")),
        },
      });
      mockReposResponse([]);

      const result = await callOAuth();

      expect(result).toEqual({ status: "connected" });
    });

    // PLN-634: reconnect detection and reuse-in-place reconciliation.
    describe("reconnect detection (PLN-634)", () => {
      /** The disconnected installation row a same-account reconnect reuses. */
      function makeReconnectPriorRow() {
        return {
          id: "prior-uuid",
          // accountId matches DEFAULT_GH_INSTALLATION.account.id, which is what
          // makes this the SAME-account path rather than the reset path.
          accountId: "1",
          accountLogin: "org",
          installationId: "OLD-99",
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.UNINSTALLED,
        };
      }

      /**
       * Every reconnect test drives the same graph: a prior UNINSTALLED row
       * that must be reused in place, plus whatever repositories currently
       * hang off it. Only that repository set varies, so it is the parameter.
       */
      function makeReconnectMockDb(
        priorRow: Record<string, unknown>,
        existingRepositories: { id: string; githubRepoId: string }[]
      ) {
        return {
          gitHubInstallation: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(priorRow)
              .mockResolvedValue({
                organizationId: ORG_ID,
                status: GitHubInstallationStatus.ACTIVE,
              }),
            findUnique: vi.fn(),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            update: vi.fn().mockResolvedValue(priorRow),
          },
          gitHubInstallationRepository: {
            findMany: vi.fn().mockResolvedValue(existingRepositories),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          gitHubUserConnection: {
            upsert: vi.fn().mockResolvedValue({ id: "github-connection-1" }),
          },
          gitHubAccessCapability: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
      }

      it("reuses prior UNINSTALLED row in place on same-account reconnect", async () => {
        mockOAuthThroughInstallationResolve();
        mockReposResponse([
          {
            id: 1,
            full_name: "org/repo-1",
            name: "repo-1",
            owner: { login: "org" },
            private: false,
          },
        ]);

        const priorRow = makeReconnectPriorRow();
        const mockDb = makeReconnectMockDb(priorRow, []);
        mockWithDbAll(mockDb);

        const result = await callOAuth();

        expect(result).toEqual({ status: "connected" });
        // Prior row was updated in place, not created fresh
        expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: "prior-uuid" },
            data: expect.objectContaining({
              installationId: "100",
              status: GitHubInstallationStatus.ACTIVE,
            }),
          })
        );
        // Repos reconciled via a single set-based bulk upsert (one statement,
        // not one round-trip per repo) so a large org's reconnect stays inside
        // the interactive-transaction timeout (ISS-4619).
        expect(mockDb.$executeRaw).toHaveBeenCalledTimes(1);
        expect(mockDb.gitHubUserConnection.upsert).toHaveBeenCalled();
      });

      it("reconciles a large repo list with batched set-based statements (ISS-4619)", async () => {
        mockOAuthThroughInstallationResolve();
        // A large org grant. The old per-repo upsert loop issued one serialized
        // round-trip each and blew past Prisma's default 5s interactive-
        // transaction timeout, rolling the whole reconnect back (P2028). The
        // reconnect now routes through the shared bulkUpsertInstallationRepositories
        // helper (service/repository-sync.ts), which reconciles the whole list in
        // batched INSERT ... ON CONFLICT statements chunked at
        // REPO_UPSERT_CHUNK_SIZE rows — not one round-trip per repo.
        //
        // Deliberately exceed the chunk boundary with 17,000 unique repos so the
        // helper's chunk loop iterates across three chunks. This asserts
        // the loop writes EVERY chunk: a broken loop that only emitted the first
        // chunk (or otherwise did not iterate) would issue 1 statement and fail.
        const REPO_COUNT = 2 * REPO_UPSERT_CHUNK_SIZE + 1000;
        const expectedChunkCount = Math.ceil(
          REPO_COUNT / REPO_UPSERT_CHUNK_SIZE
        );
        const largeRepoList = Array.from(
          { length: REPO_COUNT },
          (_, index) => ({
            id: index + 1,
            full_name: `org/repo-${index + 1}`,
            name: `repo-${index + 1}`,
            owner: { login: "org" },
            private: false,
          })
        );
        mockReposResponse(largeRepoList);

        // The standard reconnect graph with no pre-existing repositories; only
        // the size of the incoming grant is what this test varies.
        const mockDb = makeReconnectMockDb(makeReconnectPriorRow(), []);
        mockWithDbAll(mockDb);

        const result = await callOAuth();

        expect(result).toEqual({ status: "connected" });
        // Exactly ceil(REPO_COUNT / REPO_UPSERT_CHUNK_SIZE) batched statements —
        // one set-based upsert per chunk. Asserting the precise count (3 here, > 1)
        // proves the helper's chunk loop wrote ALL chunks, not just the first: a
        // first-chunk-only loop bug would emit 1 statement and fail this.
        expect(expectedChunkCount).toBeGreaterThan(1);
        expect(mockDb.$executeRaw).toHaveBeenCalledTimes(expectedChunkCount);
        // Still dramatically sub-linear in repo count — nowhere near one call per
        // repo, which would signal the per-row serialization regression that trips
        // the 5s interactive-transaction timeout is back.
        expect(mockDb.$executeRaw.mock.calls.length).toBeLessThan(
          largeRepoList.length
        );
      });

      it("returns requires_confirmation status and pins pendingNewInstallationId on different-account reconnect", async () => {
        mockOAuthThroughInstallationResolve();

        const priorRow = {
          id: "prior-uuid",
          installationId: "OLD-99",
          accountId: "9999", // does NOT match DEFAULT_GH_INSTALLATION.account.id of 1
          accountLogin: "old-org",
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.UNINSTALLED,
        };
        const mockDb = {
          gitHubInstallation: {
            findFirst: vi.fn().mockResolvedValue(priorRow),
            findUnique: vi.fn(),
            update: vi.fn().mockResolvedValue(priorRow),
            updateMany: vi.fn(),
          },
          gitHubInstallationRepository: {
            upsert: vi.fn(),
            findMany: vi.fn(),
          },
        };
        mockWithDbAll(mockDb);

        const result = await callOAuth();

        expect(result).toMatchObject({
          status: "requires_confirmation",
          priorAccount: { accountId: "9999", accountLogin: "old-org" },
          newAccount: { accountId: "1", accountLogin: "org" },
          newInstallationId: "100",
        });
        // The candidate install is pinned server-side; confirm-reset reads
        // it from here, not from the request body.
        expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith({
          where: { id: "prior-uuid" },
          data: { pendingNewInstallationId: "100" },
          select: { id: true },
        });
      });

      it("tombstones repos absent from the new install on reconnect", async () => {
        mockOAuthThroughInstallationResolve();
        // Only one repo present in the new install
        mockReposResponse([
          {
            id: 1,
            full_name: "org/repo-1",
            name: "repo-1",
            owner: { login: "org" },
            private: false,
          },
        ]);

        const priorRow = makeReconnectPriorRow();
        const existingRepos = [
          { id: "row-1", githubRepoId: "1" }, // still present
          { id: "row-2", githubRepoId: "2" }, // disappeared
        ];
        const mockDb = makeReconnectMockDb(priorRow, existingRepos);
        mockWithDbAll(mockDb);

        const result = await callOAuth();

        expect(result).toEqual({ status: "connected" });
        expect(
          mockDb.gitHubInstallationRepository.updateMany
        ).toHaveBeenCalledWith({
          where: { id: { in: ["row-2"] } },
          data: { removedAt: expect.any(Date) },
        });
      });

      // Reconnect must fail closed because full reconciliation tombstones rows
      // absent from the provider grant; the claim path can retain partial state.
      it.each([
        {
          arrangeRepos: () => mockReposResponseWithTotal(makeRepoPage(1), 5),
          error:
            "GitHub returned an incomplete repository list. Please try reconnecting.",
          label: "a partial walk",
          reason: RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial,
        },
        {
          arrangeRepos: () =>
            mockListReposAccessible.mockRejectedValueOnce(
              Object.assign(new Error("Server error"), { status: 500 })
            ),
          error: "Failed to fetch repositories from GitHub",
          label: "an outright read failure",
          reason: RepositoryArtifactRelinkFailureReason.RepositoryFetchFailed,
        },
      ])("refuses the reconnect on $label instead of tombstoning unseen repos", async ({
        arrangeRepos,
        error,
        reason,
      }) => {
        mockOAuthThroughInstallationResolve();
        arrangeRepos();

        const mockDb = makeReconnectMockDb(makeReconnectPriorRow(), [
          { id: "row-2", githubRepoId: "2" },
        ]);
        mockWithDbAll(mockDb);

        const result = await callOAuth();

        expect(result).toEqual({ status: "error", error });
        // The incomplete grant is never tombstoned. Its known repositories do
        // receive typed poorer evidence for this acquisition attempt.
        expect(
          mockDb.gitHubInstallationRepository.updateMany
        ).not.toHaveBeenCalled();
        expect(mockDb.$executeRaw).toHaveBeenCalledTimes(1);
        // Reconnect failures were previously invisible to the relink metric.
        expect(mockEmitTelemetryMetric).toHaveBeenCalledWith({
          metric: RepositoryArtifactRelinkMetricName.Failed,
          count: 1,
          stage: RepositoryArtifactRelinkFailureStage.OAuthReconnect,
          reason,
        });
      });
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
