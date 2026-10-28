/**
 * `githubService.syncRepositories` and `githubService.addRepositories` — the
 * two repository-write paths, their ISS-4618 set-based bulk upsert, the
 * tombstone diff, and the relink telemetry they emit. Split out of
 * `service.test.ts`, which owns the rest of the service surface. The behavior
 * under test lives in `service/repository-sync.ts`.
 */

import type * as GitHubModule from "@repo/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMockWithDb,
  mockWithDbTx,
} from "../../../__tests__/utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  // Minimal `Prisma.sql`/`Prisma.join` so the set-based bulk-upsert path builds
  // its statement without pulling in the real client.
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

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/observability/error", () => ({
  parseError: vi.fn((err: unknown) => String(err)),
}));

vi.mock("@/app/integrations/github/public-repositories/service", () => ({
  publicRepositoryService: { getBranches: vi.fn() },
}));

// Import after mocks are set up
import { GitHubInstallationStatus } from "@repo/database";
import { getInstallationOctokit } from "@repo/github/installation-auth";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import {
  createInstallationDelegate,
  createSyncRepositoryFixture,
  PREVIOUSLY_REMOVED_AT,
} from "@/__tests__/support/integrations/github/installation-store.test-fixtures";
import { githubService } from "@/app/integrations/github/service";
import {
  RepositoryArtifactRelinkFailureReason,
  RepositoryArtifactRelinkFailureStage,
  RepositoryArtifactRelinkMetricName,
  RepositoryArtifactRelinkStatus,
} from "@/app/integrations/github/service/repository-relink-telemetry";

const mockGetInstallationOctokit = getInstallationOctokit as ReturnType<
  typeof vi.fn
>;
const mockEmitTelemetryMetric = emitTelemetryMetric as ReturnType<typeof vi.fn>;

const ORG_ID = "org-1";
const INSTALLATION_ID = "install-1";
const INSTALLATION_OCTOKIT = {
  kind: "installation-octokit",
  rest: {
    apps: { listReposAccessibleToInstallation: vi.fn() },
  },
};

describe("githubService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstallationOctokit.mockResolvedValue(INSTALLATION_OCTOKIT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("syncRepositories", () => {
    it("leaves exactly the repos absent from the grant tombstoned, and returns the rest", async () => {
      const { repositories, executeRaw } =
        createSyncRepositoryFixture(INSTALLATION_ID);
      mockWithDbTx({
        gitHubInstallation: createInstallationDelegate([
          {
            id: INSTALLATION_ID,
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.ACTIVE,
          },
        ]),
        gitHubInstallationRepository: repositories,
        $executeRaw: executeRaw,
      });

      const result = await githubService.syncRepositories(INSTALLATION_ID, [
        {
          githubRepoId: "r-1",
          fullName: "org/repo1",
          name: "repo1",
          owner: "org",
          private: false,
        },
      ]);

      // ISS-6666: assert the rows the sync leaves behind, not the `where` it
      // built. ISS-4618: the tombstone diffs the installation's non-removed ids
      // in memory rather than binding a per-repo `notIn` list, so the behaviour
      // that matters is which rows end up stamped.
      expect(
        repositories.rowByGithubRepoId(INSTALLATION_ID, "stale-1")?.removedAt
      ).toBeInstanceOf(Date);
      expect(
        repositories.rowByGithubRepoId(INSTALLATION_ID, "r-1")?.removedAt
      ).toBeNull();
      // Already tombstoned: still excluded, and not re-stamped with a new date.
      expect(
        repositories.rowByGithubRepoId(INSTALLATION_ID, "gone-1")?.removedAt
      ).toEqual(PREVIOUSLY_REMOVED_AT);
      // Another installation's live repo is neither tombstoned nor returned.
      expect(
        repositories.rowByGithubRepoId("other-install", "o-1")?.removedAt
      ).toBeNull();
      // `name`/`owner`/`private` are here because the bulk upsert writes them:
      // the stand-in materializes the statement's row binds, where it used to
      // resolve to a no-op, so the returned row now carries every column the
      // grant supplied rather than only the seeded subset.
      expect(result).toEqual([
        {
          id: "repo-rec-1",
          installationId: INSTALLATION_ID,
          githubRepoId: "r-1",
          fullName: "org/repo1",
          name: "repo1",
          owner: "org",
          private: false,
          removedAt: null,
        },
      ]);
      // ISS-4618: one set-based `$executeRaw` per chunk, never a per-row ORM
      // upsert. Call count IS the behaviour here — a per-row loop is the
      // regression — so this pairing stays, now anchored by the end state above.
      expect(executeRaw).toHaveBeenCalledTimes(1);
      expect(repositories.upsert).not.toHaveBeenCalled();
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

    it("reports no active installation when the installation is not ACTIVE", async () => {
      const { repositories, executeRaw } =
        createSyncRepositoryFixture(INSTALLATION_ID);
      mockWithDbTx({
        gitHubInstallation: createInstallationDelegate([
          {
            id: INSTALLATION_ID,
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.SUSPENDED,
          },
        ]),
        gitHubInstallationRepository: repositories,
        $executeRaw: executeRaw,
      });

      await githubService.syncRepositories(INSTALLATION_ID, [
        {
          githubRepoId: "r-1",
          fullName: "org/repo1",
          name: "repo1",
          owner: "org",
          private: false,
        },
      ]);

      // The relink's installation lookup is ACTIVE-scoped; dropping that scope
      // makes the suspended row match and the reason count fall to 0, so this
      // catches the scoping regression from the sync path. It does NOT pin
      // WHICH reason was reported — the completed metric carries only
      // `reasonCount`, never `reasons`. `NoActiveInstallation` is pinned by
      // name in `service-relink.test.ts`, whose entry point returns the result.
      expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: RepositoryArtifactRelinkMetricName.Completed,
          status: RepositoryArtifactRelinkStatus.Skipped,
          activeRepositoryCount: 1,
          reasonCount: 1,
        })
      );
    });

    it("issues one set-based statement for a multi-repo grant, not one per repo", async () => {
      const { repositories, executeRaw } =
        createSyncRepositoryFixture(INSTALLATION_ID);
      mockWithDbTx({
        gitHubInstallation: createInstallationDelegate([
          {
            id: INSTALLATION_ID,
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.ACTIVE,
          },
        ]),
        gitHubInstallationRepository: repositories,
        $executeRaw: executeRaw,
      });

      await githubService.syncRepositories(
        INSTALLATION_ID,
        ["r-1", "stale-1", "gone-1"].map((githubRepoId) => ({
          githubRepoId,
          fullName: `org/${githubRepoId}`,
          name: githubRepoId,
          owner: "org",
          private: false,
        }))
      );

      expect(executeRaw).toHaveBeenCalledTimes(1);
      expect(repositories.upsert).not.toHaveBeenCalled();
      // ISS-6666: the call counts above prove the shape of the write, not that
      // it wrote. The stand-in materializes the statement's own row binds, so
      // these assert the three incoming repos are stored and active — including
      // `gone-1`, whose revival from a prior tombstone only happens if the bulk
      // upsert actually ran. A statement that writes nothing leaves `gone-1`
      // removed and the two live rows on their seeded names.
      expect(
        repositories.rows.map((row) => [
          row.githubRepoId,
          row.fullName,
          row.removedAt,
        ])
      ).toEqual([
        ["r-1", "org/r-1", null],
        ["stale-1", "org/stale-1", null],
        ["gone-1", "org/gone-1", null],
        ["o-1", "other/repo", null],
      ]);
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
});
