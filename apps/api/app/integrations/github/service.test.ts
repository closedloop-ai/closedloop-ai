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
 *  - `disconnectInstallation` — idempotent no-op, org-scoped GitHub uninstall
 *    success and failure, database update
 *  - `getRepositories` — active installation found and not found
 *  - `getBranches` — repository not found, org mismatch, and successful branch fetch
 *  - `getPullRequests` — repository not found, org mismatch, successful fetch with
 *    tracked PR URL resolution
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../../../__tests__/utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
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

vi.mock("@repo/github", () => ({
  deleteInstallation: vi.fn(),
  getRepositoryBranches: vi.fn(),
  getRepositoryContributors: vi.fn(),
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

import { GitHubInstallationStatus } from "@repo/database";
// Import after mocks are set up
import {
  deleteInstallation,
  getRepositoryBranches,
  getRepositoryContributors,
  getRepositoryPullRequests,
} from "@repo/github";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { publicRepositoryService } from "@/app/integrations/github/public-repositories/service";
import {
  githubService,
  RepositoryArtifactRelinkFailureReason,
  RepositoryArtifactRelinkFailureStage,
  RepositoryArtifactRelinkMetricName,
  RepositoryArtifactRelinkReason,
  RepositoryArtifactRelinkStatus,
} from "@/app/integrations/github/service";
import { encryptTokenPair } from "@/lib/integration-encryption";

const mockDeleteInstallation = deleteInstallation as ReturnType<typeof vi.fn>;
const mockGetRepositoryBranches = getRepositoryBranches as ReturnType<
  typeof vi.fn
>;
const mockGetRepositoryContributors = getRepositoryContributors as ReturnType<
  typeof vi.fn
>;
const mockGetRepositoryPullRequests = getRepositoryPullRequests as ReturnType<
  typeof vi.fn
>;
const mockGetPublicRepositoryBranches =
  publicRepositoryService.getBranches as ReturnType<typeof vi.fn>;
const mockEncryptTokenPair = encryptTokenPair as ReturnType<typeof vi.fn>;
const mockEmitTelemetryMetric = emitTelemetryMetric as ReturnType<typeof vi.fn>;

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
            status: GitHubInstallationStatus.ACTIVE,
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
          status: GitHubInstallationStatus.ACTIVE,
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
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue({
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.ACTIVE,
          }),
        },
        gitHubInstallationRepository: {
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          upsert: vi.fn().mockResolvedValue({ id: "repo-rec-1" }),
          findMany: vi
            .fn()
            .mockResolvedValueOnce([
              {
                id: "repo-rec-1",
                githubRepoId: "r-1",
                fullName: "org/repo1",
              },
            ])
            .mockResolvedValueOnce([]),
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
      expect(result).toEqual([
        { id: "repo-rec-1", githubRepoId: "r-1", fullName: "org/repo1" },
      ]);
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
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          upsert: vi.fn().mockResolvedValue({ id: "repo-rec-1" }),
          findMany: vi.fn().mockResolvedValue(syncedRepositories),
        },
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
      expect(syncTx.gitHubInstallationRepository.upsert).toHaveBeenCalled();
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
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          upsert: vi.fn().mockResolvedValue({ id: "repo-rec-1" }),
          findMany: vi
            .fn()
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
          upsert: vi.fn().mockResolvedValue({ id: "repo-rec-2" }),
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
          upsert: vi.fn(),
          findMany: vi.fn(),
        },
      };
      mockWithDbTx(mockTx);

      const result = await githubService.addRepositories(INSTALLATION_ID, []);

      expect(mockTx.gitHubInstallationRepository.upsert).not.toHaveBeenCalled();
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
          upsert: vi.fn().mockResolvedValue({ id: "repo-rec-2" }),
          findMany: vi.fn().mockResolvedValue(addedRepositories),
        },
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

      expect(result).toBe(addedRepositories);
      expect(addTx.gitHubInstallationRepository.upsert).toHaveBeenCalled();
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
          upsert: vi.fn().mockResolvedValue({ id: "repo-rec-2" }),
          findMany: vi
            .fn()
            .mockResolvedValueOnce(addedRepositories)
            .mockResolvedValueOnce([]),
        },
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

      expect(result).toBe(addedRepositories);
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith({
        metric: RepositoryArtifactRelinkMetricName.Failed,
        count: 1,
        stage: RepositoryArtifactRelinkFailureStage.AddRepositories,
        reason: RepositoryArtifactRelinkFailureReason.TelemetryEmitFailed,
      });
    });
  });

  describe("relinkBranchViewRepositoryCredential", () => {
    it("returns no-active-repository taxonomy when the active row is unavailable", async () => {
      const mockDb = {
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      const result = await githubService.relinkBranchViewRepositoryCredential({
        organizationId: ORG_ID,
        activeRepositoryId: "missing-active-repo",
      });

      expect(result).toMatchObject({
        status: RepositoryArtifactRelinkStatus.Skipped,
        reasons: [RepositoryArtifactRelinkReason.NoActiveRepositories],
      });
      expect(getMockWithDb().tx).not.toHaveBeenCalled();
    });

    it("returns completed counts for eligible stale branch and PR rows", async () => {
      const activeRepository = {
        id: "active-repo-1",
        githubRepoId: "r-1",
        fullName: "org/repo",
        installationId: INSTALLATION_ID,
      };
      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(activeRepository),
        },
      });
      const relinkTx = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue({
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.ACTIVE,
          }),
        },
        gitHubInstallationRepository: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "stale-repo-1",
              githubRepoId: "r-1",
              fullName: "org/old-repo",
            },
          ]),
        },
        branchDetail: {
          findMany: vi.fn().mockImplementation(({ where }) =>
            where.repositoryId === activeRepository.id
              ? Promise.resolve([])
              : Promise.resolve([
                  {
                    artifactId: "branch-artifact-1",
                    branchName: "feature/relink",
                    currentPullRequestDetailId: "pr-1",
                  },
                ])
          ),
          update: vi.fn().mockResolvedValue({}),
        },
        pullRequestDetail: {
          findFirst: vi.fn().mockResolvedValue({ id: "pr-1" }),
          findMany: vi
            .fn()
            .mockImplementation(({ where }) =>
              where.repositoryId === activeRepository.id
                ? Promise.resolve([])
                : Promise.resolve([{ id: "pr-1", isCurrent: true, number: 42 }])
            ),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockWithDbTx(relinkTx);

      const result = await githubService.relinkBranchViewRepositoryCredential({
        organizationId: ORG_ID,
        activeRepositoryId: activeRepository.id,
      });

      expect(result).toMatchObject({
        status: RepositoryArtifactRelinkStatus.Completed,
        branchRelinkedCount: 1,
        pullRequestRelinkedCount: 1,
      });
      expect(relinkTx.branchDetail.update).toHaveBeenCalledWith({
        where: { artifactId: "branch-artifact-1" },
        data: {
          currentPullRequestDetailId: "pr-1",
          repositoryId: "active-repo-1",
        },
      });
      // Lock in the batch-scope invariant: collision lookups are a single
      // number-/name-filtered read against the active repository, not a
      // per-row findFirst/findUnique.
      expect(relinkTx.pullRequestDetail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            repositoryId: activeRepository.id,
            number: { in: [42] },
          }),
        })
      );
      expect(relinkTx.branchDetail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            repositoryId: activeRepository.id,
            branchName: { in: ["feature/relink"] },
          }),
        })
      );
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: RepositoryArtifactRelinkMetricName.Completed,
          status: RepositoryArtifactRelinkStatus.Completed,
          branchRelinkedCount: 1,
          pullRequestRelinkedCount: 1,
        })
      );
    });

    it("returns skipped on an idempotent second sweep with no stale rows", async () => {
      const activeRepository = {
        id: "active-repo-1",
        githubRepoId: "r-1",
        fullName: "org/repo",
        installationId: INSTALLATION_ID,
      };
      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(activeRepository),
        },
      });
      mockWithDbTx({
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue({
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.ACTIVE,
          }),
        },
        gitHubInstallationRepository: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      });

      const result = await githubService.relinkBranchViewRepositoryCredential({
        organizationId: ORG_ID,
        activeRepositoryId: activeRepository.id,
      });

      expect(result).toMatchObject({
        status: RepositoryArtifactRelinkStatus.Skipped,
        reasons: [RepositoryArtifactRelinkReason.None],
        branchRelinkedCount: 0,
        pullRequestRelinkedCount: 0,
      });
    });

    it("returns relink result when sync-preflight metric emission throws", async () => {
      const activeRepository = {
        id: "active-repo-1",
        githubRepoId: "r-1",
        fullName: "org/repo",
        installationId: INSTALLATION_ID,
      };
      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(activeRepository),
        },
      });
      mockWithDbTx({
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue({
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.ACTIVE,
          }),
        },
        gitHubInstallationRepository: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      });
      mockEmitTelemetryMetric
        .mockImplementationOnce(() => {
          throw new Error("telemetry unavailable");
        })
        .mockImplementationOnce(() => undefined);

      const result = await githubService.relinkBranchViewRepositoryCredential({
        organizationId: ORG_ID,
        activeRepositoryId: activeRepository.id,
      });

      expect(result).toMatchObject({
        status: RepositoryArtifactRelinkStatus.Skipped,
        reasons: [RepositoryArtifactRelinkReason.None],
      });
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith({
        metric: RepositoryArtifactRelinkMetricName.Failed,
        count: 1,
        stage: RepositoryArtifactRelinkFailureStage.SyncPreflightRelink,
        reason: RepositoryArtifactRelinkFailureReason.TelemetryEmitFailed,
      });
    });

    it("returns branch collision taxonomy without unsafe overwrite", async () => {
      const activeRepository = {
        id: "active-repo-1",
        githubRepoId: "r-1",
        fullName: "org/repo",
        installationId: INSTALLATION_ID,
      };
      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(activeRepository),
        },
      });
      const relinkTx = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue({
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.ACTIVE,
          }),
        },
        gitHubInstallationRepository: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "stale-repo-1",
              githubRepoId: "r-1",
              fullName: "org/old-repo",
            },
          ]),
        },
        branchDetail: {
          findMany: vi.fn().mockImplementation(({ where }) =>
            where.repositoryId === activeRepository.id
              ? Promise.resolve([
                  {
                    artifactId: "existing-branch-artifact",
                    branchName: "feature/relink",
                  },
                ])
              : Promise.resolve([
                  {
                    artifactId: "branch-artifact-1",
                    branchName: "feature/relink",
                    currentPullRequestDetailId: "pr-1",
                  },
                ])
          ),
          update: vi.fn(),
        },
        pullRequestDetail: {
          findFirst: vi.fn(),
          findMany: vi.fn(),
          update: vi.fn(),
          updateMany: vi.fn(),
        },
      };
      mockWithDbTx(relinkTx);

      const result = await githubService.relinkBranchViewRepositoryCredential({
        organizationId: ORG_ID,
        activeRepositoryId: activeRepository.id,
      });

      expect(result).toMatchObject({
        status: RepositoryArtifactRelinkStatus.Partial,
        reasons: [RepositoryArtifactRelinkReason.BranchNameCollision],
        branchCollisionSkippedCount: 1,
      });
      expect(relinkTx.branchDetail.update).not.toHaveBeenCalled();
      expect(relinkTx.pullRequestDetail.update).not.toHaveBeenCalled();
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

      expect(mockGetRepositoryBranches).toHaveBeenCalledWith(
        GITHUB_INSTALLATION_ID,
        "org",
        "repo",
        20
      );
      expect(mockGetPublicRepositoryBranches).not.toHaveBeenCalled();
      expect(result).toEqual({ branches });
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

      expect(result).toEqual({
        pullRequests: prs,
        trackedPrUrls: [],
        trackedBranches: [],
        trackedBranchKeys: [],
      });
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
      mockGetRepositoryPullRequests.mockResolvedValue(prs);

      const result = await githubService.getPullRequests(
        "repo-1",
        ORG_ID,
        "proj-1"
      );

      expect(result.pullRequests).toBe(prs);
      expect(result.trackedPrUrls).toContain(prUrl);
      expect(result.trackedBranchKeys).toEqual([
        "org/repo:feature-42",
        "org/repo:branch-only",
      ]);
      expect(result.trackedBranches).toContainEqual({
        branchName: "branch-only",
        branchKey: "org/repo:branch-only",
        htmlUrl: "https://github.com/org/repo/tree/branch-only",
        pullRequestUrl: null,
      });
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
            scope: "read:user,repo",
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
        headers: { get: vi.fn().mockReturnValue(null) },
        json: () => Promise.resolve({ repositories: repos }),
      });
    }

    function mockReposResponseWithLink(
      repos: {
        id: number;
        full_name: string;
        name: string;
        owner: { login: string };
        private: boolean;
      }[],
      link: string | null
    ) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: vi.fn().mockReturnValue(link) },
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
      };
      if (!includeRepoSync) {
        return base;
      }
      return {
        ...base,
        gitHubInstallationRepository: {
          ...base.gitHubInstallationRepository,
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
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
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);
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
          scopes: ["read:user", "repo"],
        }),
        update: expect.objectContaining({
          accessTokenEncrypted: "encrypted-access-token",
          refreshTokenEncrypted: "encrypted-refresh-token",
          revokedAt: null,
        }),
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
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);

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
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);
      mockReposResponseWithLink(
        [
          {
            id: 1,
            full_name: "org/repo1",
            name: "repo1",
            owner: { login: "org" },
            private: false,
          },
        ],
        '<https://api.github.com/user/installations/100/repositories?page=2&per_page=100>; rel="next"'
      );
      mockReposResponseWithLink(
        [
          {
            id: 2,
            full_name: "org/repo2",
            name: "repo2",
            owner: { login: "org" },
            private: true,
          },
        ],
        null
      );
      const repoSyncMock = mockDb.gitHubInstallationRepository as {
        deleteMany: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
      };

      const result = await callOAuth();

      expect(result).toEqual({ status: "connected" });
      expect(mockFetch.mock.calls[3]?.[0]).toBe(
        "https://api.github.com/user/installations/100/repositories?per_page=100"
      );
      expect(mockFetch.mock.calls[4]?.[0]).toBe(
        "https://api.github.com/user/installations/100/repositories?page=2&per_page=100"
      );
      expect(repoSyncMock.upsert).toHaveBeenCalledTimes(2);
      expect(repoSyncMock.deleteMany).toHaveBeenCalledWith({
        where: {
          installationId: INSTALLATION_ID,
          githubRepoId: { notIn: ["1", "2"] },
        },
      });
    });

    it("returns a connection failure without claiming when token encryption fails", async () => {
      mockOAuthThroughInstallationResolve();
      mockEncryptTokenPair.mockRejectedValueOnce(new Error("kms unavailable"));

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION);
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);

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
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);

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
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);

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
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await callOAuth();

      expect(result).toEqual({ status: "connected" });
      expect(
        mockDb.gitHubInstallationRepository.findMany
      ).not.toHaveBeenCalled();
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
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);
      mockReposResponseWithLink(
        [
          {
            id: 1,
            full_name: "org/repo1",
            name: "repo1",
            owner: { login: "org" },
            private: false,
          },
        ],
        '<https://api.github.com/user/installations/100/repositories?page=2&per_page=100>; rel="next"'
      );
      mockFetch.mockResolvedValueOnce({ ok: false, status: 502 });
      const repoSyncMock = mockDb.gitHubInstallationRepository as {
        deleteMany: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
      };

      const result = await callOAuth();

      expect(result).toEqual({ status: "connected" });
      expect(repoSyncMock.deleteMany).not.toHaveBeenCalled();
      expect(repoSyncMock.upsert).not.toHaveBeenCalled();
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith({
        metric: RepositoryArtifactRelinkMetricName.Failed,
        count: 1,
        stage: RepositoryArtifactRelinkFailureStage.OAuthClaim,
        reason: RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial,
      });
    });

    it("does not fetch non-GitHub repository pagination links with the OAuth token", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION);
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);
      mockReposResponseWithLink(
        [
          {
            id: 1,
            full_name: "org/repo1",
            name: "repo1",
            owner: { login: "org" },
            private: false,
          },
        ],
        '<https://attacker.example/steal>; rel="next"'
      );
      const repoSyncMock = mockDb.gitHubInstallationRepository as {
        deleteMany: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
      };

      const result = await callOAuth();
      const fetchedUrls = mockFetch.mock.calls.map(([url]) => String(url));

      expect(result).toEqual({ status: "connected" });
      expect(fetchedUrls).toContain(
        "https://api.github.com/user/installations/100/repositories?per_page=100"
      );
      expect(fetchedUrls.some((url) => url.includes("attacker.example"))).toBe(
        false
      );
      expect(repoSyncMock.deleteMany).not.toHaveBeenCalled();
      expect(repoSyncMock.upsert).not.toHaveBeenCalled();
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith({
        metric: RepositoryArtifactRelinkMetricName.Failed,
        count: 1,
        stage: RepositoryArtifactRelinkFailureStage.OAuthClaim,
        reason: RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial,
      });
    });

    it("treats malformed next repository pagination links as partial fetches", async () => {
      mockOAuthThroughInstallationResolve();

      const mockDb = makeClaimMockDb(UNCLAIMED_INSTALLATION);
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);
      mockReposResponseWithLink(
        [
          {
            id: 1,
            full_name: "org/repo1",
            name: "repo1",
            owner: { login: "org" },
            private: false,
          },
        ],
        'https://attacker.example/steal; rel="next"'
      );
      const repoSyncMock = mockDb.gitHubInstallationRepository as {
        deleteMany: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
      };

      const result = await callOAuth();
      const fetchedUrls = mockFetch.mock.calls.map(([url]) => String(url));

      expect(result).toEqual({ status: "connected" });
      expect(fetchedUrls).toContain(
        "https://api.github.com/user/installations/100/repositories?per_page=100"
      );
      expect(fetchedUrls.some((url) => url.includes("attacker.example"))).toBe(
        false
      );
      expect(repoSyncMock.deleteMany).not.toHaveBeenCalled();
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

        const priorRow = {
          id: "prior-uuid",
          installationId: "OLD-99",
          accountId: "1", // matches DEFAULT_GH_INSTALLATION.account.id
          accountLogin: "org",
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.UNINSTALLED,
        };
        const mockDb = {
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
            upsert: vi.fn().mockResolvedValue({}),
            findMany: vi.fn().mockResolvedValue([]),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          gitHubUserConnection: {
            upsert: vi.fn().mockResolvedValue({ id: "github-connection-1" }),
          },
        };
        mockWithDbCall(mockDb);
        mockWithDbTx(mockDb);

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
        expect(mockDb.gitHubInstallationRepository.upsert).toHaveBeenCalled();
        expect(mockDb.gitHubUserConnection.upsert).toHaveBeenCalled();
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
        mockWithDbCall(mockDb);
        mockWithDbTx(mockDb);

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

        const priorRow = {
          id: "prior-uuid",
          installationId: "OLD-99",
          accountId: "1",
          accountLogin: "org",
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.UNINSTALLED,
        };
        const existingRepos = [
          { id: "row-1", githubRepoId: "1" }, // still present
          { id: "row-2", githubRepoId: "2" }, // disappeared
        ];
        const mockDb = {
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
            upsert: vi.fn().mockResolvedValue({}),
            findMany: vi.fn().mockResolvedValue(existingRepos),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          gitHubUserConnection: {
            upsert: vi.fn().mockResolvedValue({ id: "github-connection-1" }),
          },
        };
        mockWithDbCall(mockDb);
        mockWithDbTx(mockDb);

        const result = await callOAuth();

        expect(result).toEqual({ status: "connected" });
        expect(
          mockDb.gitHubInstallationRepository.updateMany
        ).toHaveBeenCalledWith({
          where: { id: { in: ["row-2"] } },
          data: { removedAt: expect.any(Date) },
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
      });
      // New row claimed for the org
      expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith({
        where: { id: NEW_INSTALLATION_UUID },
        data: expect.objectContaining({
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.ACTIVE,
          claimedByUserId: USER_ID,
        }),
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

  describe("getContributorsAcrossRepos", () => {
    function mockInstallationWithRepos(
      repos: { owner: string; name: string }[]
    ) {
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
      expect(mockGetRepositoryContributors).not.toHaveBeenCalled();
    });

    it("returns empty contributors when installation has no repositories", async () => {
      mockInstallationWithRepos([]);

      const result = await githubService.getContributorsAcrossRepos(ORG_ID);

      expect(result).toEqual({ contributors: [] });
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
      const mockDb = mockInstallationWithRepos([
        { owner: "org", name: "repo1" },
      ]);
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
        GITHUB_INSTALLATION_ID,
        "org",
        "repo1",
        { perPage: 50 }
      );
    });

    it("uses default maxRepos=10 and perRepoLimit=30 when no options provided", async () => {
      const mockDb = mockInstallationWithRepos([
        { owner: "org", name: "repo1" },
      ]);
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
        GITHUB_INSTALLATION_ID,
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
  });
});
