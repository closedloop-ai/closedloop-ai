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

import type * as GitHubModule from "@repo/github";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const { mockGetInstallationOctokit, mockOctokit } = vi.hoisted(() => ({
  mockGetInstallationOctokit: vi.fn(),
  mockOctokit: { marker: "installation-octokit" },
}));

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

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  return {
    GitHubProviderResultStatus: actual.GitHubProviderResultStatus,
    queryStatusCheckRollupWithProviderResult: vi.fn(),
    // Real classifier (a plain function, immune to restoreAllMocks) so the
    // mint-failure tests pin the production rate-limit-vs-unavailable
    // classification instead of a mock's reimplementation.
  };
});

vi.mock("@repo/github/installation-auth", () => ({
  // Spy wrapper (not a bare vi.fn implementation) so this suite's
  // restoreAllMocks pass can never strip the marker client the handler
  // threads into the rollup query. Mint-failure tests inject a one-shot
  // rejection through the spy; any non-undefined spy result wins over the
  // resolved marker client fallback.
  getInstallationOctokit: (installationId: string) =>
    mockGetInstallationOctokit(installationId) ?? Promise.resolve(mockOctokit),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/app/webhooks/github/handlers/branch-activity-producer", () => ({
  GitHubBranchActivityEventName: { CheckRun: "check_run" },
  persistGitHubBranchActivity: vi.fn().mockResolvedValue({
    status: "persisted",
    persistenceStatus: "inserted",
  }),
}));

import { BranchViewCheckKind } from "@repo/api/src/types/branch-view";
// Import after mocking
import { queryStatusCheckRollupWithProviderResult } from "@repo/github";
import { log } from "@repo/observability/log";
import { getMockWithDb } from "@/__tests__/utils/db-helpers";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "@/app/webhooks/github/handlers/branch-activity-producer";
import { handleCheckRun } from "@/app/webhooks/github/handlers/check-run-handler";
import {
  createCheckRunDbDoubles,
  createCheckRunEvent,
  makeBranchDetailRow,
} from "../utils/check-run-helpers";
import { providerSuccess, statusRollup } from "../utils/status-check-helpers";

// Type aliases for mocked functions
const mockWithDb = getMockWithDb();
const mockQueryStatusCheckRollupWithProviderResult =
  queryStatusCheckRollupWithProviderResult as unknown as Mock;
const mockPersistGitHubBranchActivity =
  persistGitHubBranchActivity as unknown as Mock;

// Mock database clients
let mockDb: any;
let mockTx: any;

describe("handleCheckRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ({ mockDb, mockTx } = createCheckRunDbDoubles());
    mockWithDb.mockImplementation((fn: any) => fn(mockDb));
    mockWithDb.tx.mockImplementation((fn: any) => fn(mockTx));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("successful check_run.completed for matching open PR", () => {
    it("calls rollup and updates checksStatus when status changes", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const installationId = 99;
      const repositoryId = 12_345;
      const event = createCheckRunEvent({
        headBranch: "",
        headSha,
        installationId,
        repositoryId,
      });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findMany.mockResolvedValue([
        makeBranchDetailRow({
          artifactId: "artifact-pr-123",
          number: 42,
          title: "Test PR",
          externalUrl: "https://github.com/org/repo/pull/42",
          headSha,
          workstreamId: "ws-uuid-123",
          linkedDoc: { id: "artifact-doc-123", slug: "test-slug" },
        }),
      ]);

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

      const response = await handleCheckRun(event, {
        deliveryId: "check-run-delivery-1",
        observedAt: new Date("2026-08-12T14:00:00.000Z"),
      });

      // Verify GraphQL call goes out with the client minted for this event's
      // installation
      expect(mockGetInstallationOctokit).toHaveBeenCalledWith(
        String(installationId)
      );
      expect(mockQueryStatusCheckRollupWithProviderResult).toHaveBeenCalledWith(
        mockOctokit,
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
      expect(mockPersistGitHubBranchActivity).toHaveBeenCalledWith({
        eventName: GitHubBranchActivityEventName.CheckRun,
        deliveryId: "check-run-delivery-1",
        payload: event,
        attribution: {
          organizationId: "org-1",
          branchArtifactId: "artifact-pr-123",
        },
      });

      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(log.info).toHaveBeenCalledWith(
        "[handleCheckRun] Completed check_run webhook handling",
        expect.objectContaining({
          checksStatusChanged: true,
          outcome: "processed_checks_changed",
          provider: "github",
        })
      );
    });

    it("no-writes activity when a head-SHA fallback is ambiguous", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headBranch: "", headSha });
      const firstBranch = makeBranchDetailRow({
        artifactId: "artifact-first-same-sha",
        headSha,
        number: 42,
        title: "First branch",
      });
      const secondBranch = makeBranchDetailRow({
        artifactId: "artifact-second-same-sha",
        headSha,
        number: 43,
        title: "Second branch",
      });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findMany.mockResolvedValue([
        firstBranch,
        secondBranch,
      ]);
      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue(
        providerSuccess(statusRollup("SUCCESS"))
      );
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        deletedAt: null,
        currentPullRequestDetailId: "pr-detail-1",
      });

      await handleCheckRun(event, {
        deliveryId: "check-run-ambiguous-delivery",
        observedAt: new Date("2026-08-12T14:00:00.000Z"),
      });

      expect(mockDb.branchDetail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 2 })
      );
      expect(mockPersistGitHubBranchActivity).not.toHaveBeenCalled();
    });

    it("fails closed when a repository rename leaves duplicate branch-name matches", async () => {
      const event = createCheckRunEvent({
        headBranch: "feature/renamed-repository",
      });
      const firstBranch = makeBranchDetailRow({
        artifactId: "artifact-old-repository-name",
        branchName: "feature/renamed-repository",
      });
      const secondBranch = makeBranchDetailRow({
        artifactId: "artifact-new-repository-name",
        branchName: "feature/renamed-repository",
      });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-renamed",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findMany.mockResolvedValue([
        firstBranch,
        secondBranch,
      ]);

      const response = await handleCheckRun(event, {
        deliveryId: "check-run-duplicate-branch-name",
        observedAt: new Date("2026-08-12T14:00:00.000Z"),
      });

      expect(mockDb.branchDetail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 2 })
      );
      expect(
        mockQueryStatusCheckRollupWithProviderResult
      ).not.toHaveBeenCalled();
      expect(mockPersistGitHubBranchActivity).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ ok: true });
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
      expect(log.info).toHaveBeenCalledWith(
        "[handleCheckRun] Completed check_run webhook handling",
        expect.objectContaining({
          checksStatusChanged: false,
          outcome: "processed",
          provider: "github",
        })
      );
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
      expect(log.info).toHaveBeenCalledWith(
        "[handleCheckRun] Completed check_run webhook handling",
        expect.objectContaining({
          checksStatusChanged: false,
          outcome: "processed",
          provider: "github",
        })
      );
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
      expect(mockPersistGitHubBranchActivity).toHaveBeenCalledWith({
        eventName: GitHubBranchActivityEventName.CheckRun,
        deliveryId: undefined,
        payload: event,
        attribution: {
          organizationId: "org-1",
          branchArtifactId: "artifact-pr-toctou",
        },
      });

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
