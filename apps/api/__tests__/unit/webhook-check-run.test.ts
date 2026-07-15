/**
 * Unit tests for GitHub check_run webhook handler.
 *
 * Tests the following functions from check-run-handler.ts:
 * - handleCheckRun: Main entry point for check_run.completed events
 * - mapRollupStateToChecksStatus: Pure mapping function for rollup state to ChecksStatus
 *
 * These are pure unit tests with mocked external dependencies:
 * - @repo/database (Prisma client - withDb + withDb.tx)
 * - @repo/github (queryStatusCheckRollupWithProviderResult)
 * - @repo/observability/log (logging)
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

// Mock modules before importing
vi.mock("@repo/database", () => {
  const mockWithDb: any = vi.fn();
  mockWithDb.tx = vi.fn();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  });
  return {
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      BRANCH: "BRANCH",

      DEPLOYMENT: "DEPLOYMENT",
    },
    GitHubInstallationStatus: {
      ACTIVE: "ACTIVE",
    },
    Prisma: {
      join: (values: unknown[]) => values,
      sql,
    },
    withDb: mockWithDb,
  };
});

vi.mock("@repo/github", () => ({
  GitHubProviderResultStatus: {
    Success: "success",
    ProviderRateLimit: "provider_rate_limit",
    ProviderUnavailable: "provider_unavailable",
  },
  queryStatusCheckRollupWithProviderResult: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { mapRollupStateToChecksStatus } from "@repo/api/src/github-checks-status";
import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
} from "@repo/api/src/types/branch-view";
import { StatusCheckRollupFailureReason } from "@repo/api/src/types/github";
import { GitHubInstallationStatus } from "@repo/database";
// Import after mocking
import {
  GitHubProviderResultStatus,
  queryStatusCheckRollupWithProviderResult,
} from "@repo/github";
import { getMockWithDb } from "@/__tests__/utils/db-helpers";
import { handleCheckRun } from "@/app/webhooks/github/handlers/check-run-handler";
import { CheckRunRetryState } from "@/lib/branch-status-check-retry";
import { makePrDetailRow } from "../utils/pr-detail-helpers";
import { statusRollup } from "../utils/status-check-helpers";

// Type aliases for mocked functions
const mockWithDb = getMockWithDb();
const mockQueryStatusCheckRollupWithProviderResult =
  queryStatusCheckRollupWithProviderResult as unknown as Mock;

// Mock database clients
let mockDb: any;
let mockTx: any;

function makeBranchDetailRow(
  partial: Parameters<typeof makePrDetailRow>[0] & {
    branchName?: string;
    currentPullRequestDetailId?: string | null;
  }
) {
  const pr = makePrDetailRow(partial);
  return {
    artifactId: partial.artifactId,
    branchName: partial.branchName ?? "feature/test-branch",
    checksStatus: partial.checksStatus ?? "UNKNOWN",
    headSha: partial.headSha ?? null,
    currentPullRequestDetailId:
      partial.currentPullRequestDetailId ?? "pr-detail-1",
    currentPullRequestDetail: {
      number: partial.number ?? 0,
      title: partial.title ?? "",
      htmlUrl: partial.externalUrl ?? "",
    },
    artifact: {
      ...pr.artifact,
      organizationId: partial.organizationId ?? "org-1",
    },
  };
}

/**
 * Helper to create a minimal check_run event for testing
 */
function createCheckRunEvent(partial?: {
  action?: string;
  headSha?: string;
  headBranch?: string;
  repositoryId?: number;
  repositoryFullName?: string;
  installationId?: number | null;
  checkRunId?: number;
  checkRunName?: string;
  conclusion?: string;
}) {
  const hasInstallation = partial?.installationId !== null;
  return {
    action: partial?.action ?? "completed",
    check_run: {
      id: partial?.checkRunId ?? 1,
      name: partial?.checkRunName ?? "ci / test",
      head_sha: partial?.headSha ?? "abc123def456abc123def456abc123def456abc1",
      conclusion: partial?.conclusion ?? "success",
      check_suite: {
        head_branch: partial?.headBranch ?? "feature/test-branch",
      },
    },
    repository: {
      id: partial?.repositoryId ?? 12_345,
      full_name: partial?.repositoryFullName ?? "org/repo",
    },
    ...(hasInstallation !== false && {
      installation: {
        id: partial?.installationId ?? 99,
      },
    }),
  } as any;
}

describe("mapRollupStateToChecksStatus", () => {
  it("maps SUCCESS to PASSING", () => {
    expect(mapRollupStateToChecksStatus("SUCCESS")).toBe("PASSING");
  });

  it("maps FAILURE to FAILING", () => {
    expect(mapRollupStateToChecksStatus("FAILURE")).toBe("FAILING");
  });

  it("maps ERROR to FAILING", () => {
    expect(mapRollupStateToChecksStatus("ERROR")).toBe("FAILING");
  });

  it("maps PENDING to PENDING", () => {
    expect(mapRollupStateToChecksStatus("PENDING")).toBe("PENDING");
  });

  it("maps EXPECTED to PENDING", () => {
    expect(mapRollupStateToChecksStatus("EXPECTED")).toBe("PENDING");
  });
});

describe("handleCheckRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      gitHubInstallationRepository: {
        findFirst: vi.fn(),
      },
      branchDetail: {
        findFirst: vi.fn(),
      },
    };

    mockTx = {
      $executeRaw: vi.fn(),
      branchDetail: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      branchStatusCheck: {
        deleteMany: vi.fn(),
        upsert: vi.fn(),
      },
      pullRequestDetail: {
        update: vi.fn(),
      },
      workstreamEvent: {
        create: vi.fn(),
      },
    };

    mockTx.branchDetail.findFirst.mockImplementation(async (args: any) => {
      const row = await mockTx.branchDetail.findUnique();
      if (!row || row.deletedAt || row.headSha !== args.where.headSha) {
        return null;
      }
      return {
        artifactId: args.where.artifactId,
        checksStatus: row.checksStatus,
      };
    });
    mockWithDb.mockImplementation((fn: any) => fn(mockDb));
    mockWithDb.tx.mockImplementation((fn: any) => fn(mockTx));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("action guard", () => {
    it("returns early without calling withDb when action is 'created'", async () => {
      const event = createCheckRunEvent({ action: "created" });

      const response = await handleCheckRun(event);

      expect(mockWithDb).not.toHaveBeenCalled();
      expect(
        mockQueryStatusCheckRollupWithProviderResult
      ).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });

    it("returns early without calling withDb when action is 'rerequested'", async () => {
      const event = createCheckRunEvent({ action: "rerequested" });

      const response = await handleCheckRun(event);

      expect(mockWithDb).not.toHaveBeenCalled();
      expect(
        mockQueryStatusCheckRollupWithProviderResult
      ).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("installation guard", () => {
    it("returns 400 when installation field is missing", async () => {
      const event = createCheckRunEvent({ installationId: null });
      // Remove installation property entirely (use undefined to satisfy Biome noDelete rule)
      event.installation = undefined;

      const response = await handleCheckRun(event);

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.ok).toBe(false);
      expect(data.message).toBe("Missing installation");

      expect(mockWithDb).not.toHaveBeenCalled();
      expect(
        mockQueryStatusCheckRollupWithProviderResult
      ).not.toHaveBeenCalled();
    });
  });

  describe("repository lookup", () => {
    it("returns ok:true without calling rollup when repository is not found", async () => {
      const event = createCheckRunEvent({ repositoryId: 99_999 });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

      const response = await handleCheckRun(event);

      expect(
        mockDb.gitHubInstallationRepository.findFirst
      ).toHaveBeenCalledWith({
        where: {
          githubRepoId: String(event.repository.id),
          fullName: event.repository.full_name,
          removedAt: null,
          installation: {
            installationId: String(event.installation.id),
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        select: {
          id: true,
          installation: { select: { organizationId: true } },
          name: true,
          owner: true,
        },
      });
      expect(
        mockQueryStatusCheckRollupWithProviderResult
      ).not.toHaveBeenCalled();
      expect(mockWithDb.tx).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("PR lookup", () => {
    it("returns ok:true without calling rollup when no open PR matches headSha", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(null);

      const response = await handleCheckRun(event);

      expect(mockDb.branchDetail.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            repositoryId: "repo-uuid-123",
          }),
        })
      );
      expect(
        mockQueryStatusCheckRollupWithProviderResult
      ).not.toHaveBeenCalled();
      expect(mockWithDb.tx).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("GraphQL rollup", () => {
    it("skips DB writes when queryStatusCheckRollupWithProviderResult returns null", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const installationId = 99;
      const event = createCheckRunEvent({ headSha, installationId });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-123",
          number: 42,
          title: "Test PR",
          externalUrl: "https://github.com/org/repo/pull/42",
          headSha,
          workstreamId: "ws-uuid-123",
          linkedDoc: { id: "artifact-doc-123", slug: "test-slug" },
        })
      );

      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue(
        providerSuccess({
          ok: false,
          reason: StatusCheckRollupFailureReason.GraphqlError,
        })
      );
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        deletedAt: null,
      });
      mockTx.branchDetail.updateMany.mockImplementation((args: any) => {
        if (
          args?.data?.checkRunRetryState === CheckRunRetryState.Pending &&
          args?.where?.checkRunRetryResourceId !== undefined
        ) {
          return Promise.resolve({ count: 0 });
        }
        return Promise.resolve({ count: 1 });
      });

      const response = await handleCheckRun(event);

      expect(mockQueryStatusCheckRollupWithProviderResult).toHaveBeenCalledWith(
        String(installationId),
        "org",
        "repo",
        headSha
      );
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
        data: expect.objectContaining({
          checksDetailProviderState:
            BranchViewChecksProviderState.ProviderUnavailable,
          checksDetailUnavailableReason:
            StatusCheckRollupFailureReason.GraphqlError,
        }),
        where: {
          artifact: { organizationId: "org-1" },
          artifactId: "artifact-pr-123",
          deletedAt: null,
          headSha,
        },
      });

      const data = await response.json();
      expect(data.ok).toBe(true);
    });

    it("schedules rate-limited check_run retries with provider retry metadata", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({
        checkRunId: 24_681,
        headSha,
        installationId: 99,
      });
      const now = new Date("2026-07-03T01:00:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-123",
          number: 42,
          title: "Test PR",
          externalUrl: "https://github.com/org/repo/pull/42",
          headSha,
          workstreamId: "ws-uuid-123",
          linkedDoc: { id: "artifact-doc-123", slug: "test-slug" },
        })
      );
      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue({
        status: GitHubProviderResultStatus.ProviderRateLimit,
        retryAfterSeconds: 37,
      });
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        deletedAt: null,
      });

      const response = await handleCheckRun(event);

      expect(mockTx.branchDetail.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            checkRunRetryNextAt: new Date("2026-07-03T01:00:37Z"),
            checkRunRetryReason: StatusCheckRollupFailureReason.RateLimited,
            checkRunRetryState: CheckRunRetryState.Pending,
          }),
          where: expect.objectContaining({
            artifact: { organizationId: "org-1" },
            artifactId: "artifact-pr-123",
            deletedAt: null,
            headSha,
            repositoryId: "repo-uuid-123",
          }),
        })
      );
      expect(response.status).toBe(200);
    });
  });

  describe("successful check_run.completed for matching open PR", () => {
    it("calls rollup and updates checksStatus when status changes", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const installationId = 99;
      const repositoryId = 12_345;
      const event = createCheckRunEvent({
        headSha,
        installationId,
        repositoryId,
      });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-123",
          number: 42,
          title: "Test PR",
          externalUrl: "https://github.com/org/repo/pull/42",
          headSha,
          workstreamId: "ws-uuid-123",
          linkedDoc: { id: "artifact-doc-123", slug: "test-slug" },
        })
      );

      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue(
        providerSuccess(statusRollup("SUCCESS"))
      );

      // TOCTOU guard: re-read in tx returns same headSha and different checksStatus
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        deletedAt: null,
        currentPullRequestDetailId: "pr-detail-1",
      });
      mockTx.workstreamEvent.create.mockResolvedValue({});

      const response = await handleCheckRun(event);

      // Verify GraphQL call
      expect(mockQueryStatusCheckRollupWithProviderResult).toHaveBeenCalledWith(
        String(installationId),
        "org",
        "repo",
        headSha
      );

      // Verify transaction was opened
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);

      // Verify TOCTOU re-read on branchDetail
      expect(mockTx.branchDetail.findFirst).toHaveBeenCalledWith({
        where: {
          artifact: { organizationId: "org-1" },
          artifactId: "artifact-pr-123",
          deletedAt: null,
          headSha,
        },
        select: { artifactId: true, checksStatus: true },
      });

      // Verify checksStatus update on BranchDetail only; PullRequestDetail
      // keeps review/comment-specific PR state after Migration B.
      expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
        where: {
          artifact: { organizationId: "org-1" },
          artifactId: "artifact-pr-123",
          deletedAt: null,
          headSha,
        },
        data: expect.objectContaining({ checksStatus: "PASSING" }),
      });
      expect(mockTx.pullRequestDetail.update).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });

    it("persists status check rows with one batch upsert statement", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-123",
          number: 42,
          title: "Test PR",
          externalUrl: "https://github.com/org/repo/pull/42",
          checksStatus: "PASSING",
          headSha,
          workstreamId: "ws-uuid-123",
          linkedDoc: { id: "artifact-doc-123", slug: "test-slug" },
        })
      );
      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue(
        providerSuccess({
          ok: true,
          state: "SUCCESS",
          totalCount: 1,
          truncated: false,
          checks: [
            {
              id: "check-run-1",
              kind: BranchViewCheckKind.CheckRun,
              providerNodeId: "node-1",
              name: "Build",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              targetUrl: "https://github.com/org/repo/actions/runs/1",
              position: 0,
            },
          ],
        })
      );
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "PASSING",
        deletedAt: null,
        currentPullRequestDetailId: "pr-detail-1",
      });

      const response = await handleCheckRun(event);

      expect(mockTx.branchStatusCheck.deleteMany).toHaveBeenCalledWith({
        where: {
          branchArtifactId: "artifact-pr-123",
          headSha,
          providerKey: { notIn: ["check-run-1"] },
        },
      });
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockTx.branchStatusCheck.upsert).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });

    it("prefers the check suite head branch over another branch with the same head SHA", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({
        headBranch: "feature/right-branch",
        headSha,
      });
      const wrongBranch = makeBranchDetailRow({
        artifactId: "artifact-wrong-same-sha",
        branchName: "feature/wrong-branch",
        number: 50,
        title: "Wrong branch",
        externalUrl: "https://github.com/org/repo/pull/50",
        headSha,
        workstreamId: "ws-wrong",
        linkedDoc: null,
      });
      const rightBranch = makeBranchDetailRow({
        artifactId: "artifact-right-branch",
        branchName: "feature/right-branch",
        number: 51,
        title: "Right branch",
        externalUrl: "https://github.com/org/repo/pull/51",
        headSha,
        workstreamId: "ws-right",
        linkedDoc: null,
      });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-same-sha",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockImplementation(({ where }: any) => {
        if (where.branchName === "feature/right-branch") {
          return Promise.resolve(rightBranch);
        }
        if (where.headSha === headSha) {
          return Promise.resolve(wrongBranch);
        }
        return Promise.resolve(null);
      });
      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue(
        providerSuccess(statusRollup("SUCCESS"))
      );
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        deletedAt: null,
        currentPullRequestDetailId: "pr-detail-1",
      });

      const response = await handleCheckRun(event);

      expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
        where: {
          artifact: { organizationId: "org-1" },
          artifactId: "artifact-right-branch",
          deletedAt: null,
          headSha,
        },
        data: expect.objectContaining({ checksStatus: "PASSING" }),
      });
      expect(mockTx.branchDetail.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            artifactId: "artifact-wrong-same-sha",
          }),
        })
      );
      expect(await response.json()).toMatchObject({ ok: true });
    });
  });

  describe("idempotency", () => {
    it("does NOT call update or workstreamEvent.create when checksStatus is already the same", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-idempotent",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-idempotent",
          number: 43,
          title: "Idempotent PR",
          externalUrl: "https://github.com/org/repo/pull/43",
          checksStatus: "PASSING",
          headSha,
          workstreamId: "ws-uuid-idempotent",
          linkedDoc: null,
        })
      );

      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue(
        providerSuccess(statusRollup("SUCCESS"))
      );

      // TOCTOU re-read returns same status (PASSING == PASSING after mapping SUCCESS)
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "PASSING",
        deletedAt: null,
        currentPullRequestDetailId: "pr-detail-1",
      });

      const response = await handleCheckRun(event);

      // Detail rows/metadata refresh even when the aggregate status is unchanged.
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
        data: expect.objectContaining({ checksStatus: "PASSING" }),
        where: {
          artifact: { organizationId: "org-1" },
          artifactId: "artifact-pr-idempotent",
          deletedAt: null,
          headSha,
        },
      });
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("headSha TOCTOU guard", () => {
    it("skips update when PR headSha changed between non-tx read and tx write", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const newHeadSha = "111222333444555666777888999000aaabbbcccd";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-toctou",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-toctou",
          number: 44,
          title: "TOCTOU PR",
          externalUrl: "https://github.com/org/repo/pull/44",
          headSha,
          workstreamId: "ws-uuid-toctou",
          linkedDoc: null,
        })
      );

      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue(
        providerSuccess(statusRollup("SUCCESS"))
      );

      // TX re-read returns a different headSha (synchronize event arrived)
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha: newHeadSha,
        checksStatus: "UNKNOWN",
        deletedAt: null,
        currentPullRequestDetailId: "pr-detail-1",
      });

      const response = await handleCheckRun(event);

      // Transaction opened but no writes
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockTx.branchDetail.updateMany).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });

    it("skips rows and events when the guarded current-head write misses", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-toctou-write",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-toctou-write",
          number: 44,
          title: "TOCTOU write PR",
          externalUrl: "https://github.com/org/repo/pull/44",
          headSha,
          workstreamId: "ws-uuid-toctou-write",
          linkedDoc: null,
        })
      );

      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue(
        providerSuccess(statusRollup("SUCCESS"))
      );
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        deletedAt: null,
        currentPullRequestDetailId: "pr-detail-1",
      });
      mockTx.branchDetail.updateMany.mockResolvedValue({ count: 0 });

      const response = await handleCheckRun(event);

      expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
        data: expect.objectContaining({ checksStatus: "PASSING" }),
        where: {
          artifact: { organizationId: "org-1" },
          artifactId: "artifact-pr-toctou-write",
          deletedAt: null,
          headSha,
        },
      });
      expect(mockTx.branchStatusCheck.deleteMany).not.toHaveBeenCalled();
      expect(mockTx.branchStatusCheck.upsert).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("branch delete guard in transaction", () => {
    it("skips update when branch is deleted in tx re-read", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-merged",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-merged",
          number: 45,
          title: "Merged PR",
          externalUrl: "https://github.com/org/repo/pull/45",
          headSha,
          workstreamId: "ws-uuid-merged",
          linkedDoc: null,
        })
      );

      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue(
        providerSuccess(statusRollup("SUCCESS"))
      );

      // TX re-read shows the branch was deleted between initial read and tx.
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        deletedAt: new Date("2026-05-15T00:00:00Z"),
        currentPullRequestDetailId: "pr-detail-1",
      });

      const response = await handleCheckRun(event);

      // Transaction opened but no writes
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockTx.branchDetail.updateMany).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("PR no longer exists in transaction", () => {
    it("skips update when PR no longer exists during tx re-read", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-gone",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-gone",
          number: 46,
          title: "Gone PR",
          externalUrl: "https://github.com/org/repo/pull/46",
          headSha,
          workstreamId: "ws-uuid-gone",
          linkedDoc: null,
        })
      );

      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue(
        providerSuccess(statusRollup("SUCCESS"))
      );

      // TX re-read: PR was deleted
      mockTx.branchDetail.findUnique.mockResolvedValue(null);

      const response = await handleCheckRun(event);

      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockTx.branchDetail.updateMany).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("full flow with FAILURE conclusion", () => {
    it("maps FAILURE rollup state to FAILING and updates checksStatus", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha, conclusion: "failure" });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-fail",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-fail",
          number: 47,
          title: "Failing PR",
          externalUrl: "https://github.com/org/repo/pull/47",
          checksStatus: "PASSING",
          headSha,
          workstreamId: "ws-uuid-fail",
          linkedDoc: { id: "artifact-doc-fail", slug: "fail-slug" },
        })
      );

      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue(
        providerSuccess(statusRollup("FAILURE"))
      );

      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "PASSING",
        deletedAt: null,
        currentPullRequestDetailId: "pr-detail-1",
      });
      mockTx.workstreamEvent.create.mockResolvedValue({});

      const response = await handleCheckRun(event);

      expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
        where: {
          artifact: { organizationId: "org-1" },
          artifactId: "artifact-pr-fail",
          deletedAt: null,
          headSha,
        },
        data: expect.objectContaining({ checksStatus: "FAILING" }),
      });

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("transaction behavior", () => {
    it("executes the write within a single transaction (withDb.tx called once)", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-tx",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-tx",
          number: 48,
          title: "TX PR",
          externalUrl: "https://github.com/org/repo/pull/48",
          headSha,
          workstreamId: "ws-uuid-tx",
          linkedDoc: null,
        })
      );

      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue(
        providerSuccess(statusRollup("SUCCESS"))
      );

      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        deletedAt: null,
        currentPullRequestDetailId: "pr-detail-1",
      });
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handleCheckRun(event);

      // The non-transactional read uses withDb (once)
      expect(mockWithDb).toHaveBeenCalledTimes(1);
      // The transactional write uses withDb.tx (once)
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
    });
  });
});

function providerSuccess<T>(value: T) {
  return {
    status: GitHubProviderResultStatus.Success,
    value,
  };
}
