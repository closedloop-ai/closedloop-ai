/**
 * `githubService.relinkBranchViewRepositoryCredential` — the repository
 * artifact relink sweep that re-points Branch and PullRequest detail rows at an
 * ACTIVE repository row after a reconnect, its collision taxonomy, its
 * guarded-write outcomes, and its telemetry. Split out of `service.test.ts`,
 * which owns the rest of the service surface. The behavior under test lives in
 * `service/repository-artifact-relink.ts`.
 */

import type * as GitHubModule from "@repo/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../../../__tests__/utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  // Minimal `Prisma.sql`/`Prisma.join` so the set-based bulk-upsert path the
  // service module pulls in builds its statement without the real client.
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
import { GitHubInstallationStatus } from "@repo/database";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { githubService } from "@/app/integrations/github/service";
import {
  RepositoryArtifactRelinkFailureReason,
  RepositoryArtifactRelinkFailureStage,
  RepositoryArtifactRelinkMetricName,
  RepositoryArtifactRelinkReason,
  RepositoryArtifactRelinkStatus,
} from "@/app/integrations/github/service/repository-relink-telemetry";

const mockEmitTelemetryMetric = emitTelemetryMetric as ReturnType<typeof vi.fn>;

const ORG_ID = "org-1";
const INSTALLATION_ID = "install-1";

describe("githubService.relinkBranchViewRepositoryCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
      // BranchDetail is class-table-inheritance keyed on artifactId.
      select: { artifactId: true },
    });
    // PullRequestDetail is keyed on `id`, NOT artifactId — it is the one
    // `*Detail` table that is not class-table-inheritance keyed.
    expect(relinkTx.pullRequestDetail.update).toHaveBeenCalledWith({
      where: { id: "pr-1" },
      data: { isCurrent: true, repositoryId: "active-repo-1" },
      select: { id: true },
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

  // ISS-6319: the relink writes stay single-row `update` on purpose. Each one
  // is immediately followed by a `branchCount++` / `pullRequestCount++`, so
  // the P2025 is what stops the sweep from counting a row it never wrote.
  // The sweep DOES catch it — but into a distinct observable outcome
  // (`skipped` / `guarded_write_failed` / count 0), which is precisely why
  // the throw is load-bearing rather than incidental. An `updateMany` here
  // would report `completed` with a relinked count of 1 for a row that was
  // never touched.
  it("reports skipped/guarded_write_failed when the relink row vanished, never a count it did not write", async () => {
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
        // `@repo/database` is mocked in this suite, so the real
        // PrismaClientKnownRequestError constructor is not available. The
        // relink path never inspects the error type — it only lets it out —
        // so an error carrying the code is a faithful stand-in.
        update: vi
          .fn()
          .mockRejectedValue(
            Object.assign(
              new Error("synthetic P2025 for branchDetail.update"),
              { code: "P2025" }
            )
          ),
        // Load-bearing: without this the batch form would throw TypeError on
        // an undefined delegate, which the same guarded-write catch swallows
        // into the identical `skipped` result — and this test would pass
        // against the very conversion it exists to reject. Resolving `count:
        // 0` is what an `updateMany` against a vanished row really does.
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
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
      status: RepositoryArtifactRelinkStatus.Skipped,
      reasons: [RepositoryArtifactRelinkReason.GuardedWriteFailed],
      branchRelinkedCount: 0,
      pullRequestRelinkedCount: 0,
    });
    // The counter never advanced past the write that failed.
    expect(mockEmitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: RepositoryArtifactRelinkMetricName.Completed,
      })
    );
  });

  // The sibling half of the invariant above. The PR-detail write runs FIRST in
  // the sweep, so its P2025 is what stops `pullRequestCount++` and also keeps
  // the branch write from ever running. Without this case an `updateMany`
  // conversion on that call site would go unnoticed: `pullRequestCount++` is
  // unconditional on the resolved value, so the completed-counts test above
  // would keep reporting 1 for a row that was never touched.
  it("reports skipped/guarded_write_failed when the relink PR-detail row vanished", async () => {
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
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
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
        update: vi
          .fn()
          .mockRejectedValue(
            Object.assign(
              new Error("synthetic P2025 for pullRequestDetail.update"),
              { code: "P2025" }
            )
          ),
        // Resolves, exactly as a real `updateMany` against a vanished row
        // would. That is what makes the conversion detectable here: swapping
        // the `update` for it turns this case green-to-red rather than
        // silently keeping it green.
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDbTx(relinkTx);

    const result = await githubService.relinkBranchViewRepositoryCredential({
      organizationId: ORG_ID,
      activeRepositoryId: activeRepository.id,
    });

    expect(result).toMatchObject({
      status: RepositoryArtifactRelinkStatus.Skipped,
      reasons: [RepositoryArtifactRelinkReason.GuardedWriteFailed],
      branchRelinkedCount: 0,
      pullRequestRelinkedCount: 0,
    });
    // The PR write aborts the branch it belongs to, so the branch write for
    // that same branch never runs.
    expect(relinkTx.branchDetail.update).not.toHaveBeenCalled();
    expect(mockEmitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: RepositoryArtifactRelinkMetricName.Completed,
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
