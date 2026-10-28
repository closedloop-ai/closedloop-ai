/**
 * Pins that a pull_request webhook for an unknown repository, or one outside
 * its installation's organization, writes nothing. Split from
 * `webhook-pull-request.test.ts`, which owns the lifecycle actions.
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

const { mockWithDbTx } = vi.hoisted(() => ({ mockWithDbTx: vi.fn() }));

vi.mock("@/app/branches/branch-detail-signal", () => ({
  emitBranchDetailChanged: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: Object.assign(vi.fn(), { tx: mockWithDbTx }),
}));

vi.mock("@repo/github/artifact-reference-parser", () => ({
  parseArtifactReferences: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: vi.fn().mockResolvedValue("WORK-99"),
}));

vi.mock("@/lib/artifact-adapters", () => ({
  documentWhere: (where: Record<string, unknown>) => ({
    ...where,
    type: "DOCUMENT",
  }),
}));

vi.mock("@/app/branches/branch-service", () => ({
  branchService: {
    upsertBranchArtifact: vi.fn().mockResolvedValue({
      ok: true,
      value: { id: "new-branch-artifact-id" },
    }),
  },
  // PLN-1034: PR-lifecycle actions bump branch_detail.last_activity_at.
  bumpBranchActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/branches/pull-request-author-identity", () => ({
  ensurePullRequestAuthorIdentity: vi.fn(),
}));

// ISS-4664: the handler calls this AFTER the transaction commits, only for the
// linkage actions. Mock it so the tests below can assert the caller wiring —
// which action set triggers reconciliation and that it never fails the webhook.
vi.mock(
  "@/app/webhooks/github/handlers/pull-request-label-reconciliation",
  () => ({
    reconcilePullRequestLabelsForWebhook: vi.fn().mockResolvedValue(undefined),
  })
);

vi.mock("@/app/webhooks/github/handlers/branch-activity-producer", () => ({
  GitHubBranchActivityEventName: { PullRequest: "pull_request" },
  persistGitHubBranchActivity: vi.fn().mockResolvedValue({
    status: "persisted",
    persistenceStatus: "inserted",
  }),
}));

import { GitHubInstallationStatus } from "@repo/database";
import { parseArtifactReferences } from "@repo/github/artifact-reference-parser";
import {
  createPullRequestWebhookTx,
  installPullRequestTransactionMock,
  type PullRequestWebhookTx,
  pullRequestWebhookWriteMocks,
} from "@/__tests__/support/webhooks/github/pull-request-handler.test-mocks";
import { branchService } from "@/app/branches/branch-service";
import { persistGitHubBranchActivity } from "@/app/webhooks/github/handlers/branch-activity-producer";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";
import { reconcilePullRequestLabelsForWebhook } from "@/app/webhooks/github/handlers/pull-request-label-reconciliation";
import {
  createInstallationLite,
  createPullRequest,
  createPullRequestClosedEvent,
  createPullRequestOpenedEvent,
  createRepository,
} from "../fixtures/github-webhook-fixtures";

const mockParseArtifactReferences = parseArtifactReferences as Mock;
const mockUpsertBranchArtifact = branchService.upsertBranchArtifact as Mock;
const _mockReconcileLabels = reconcilePullRequestLabelsForWebhook as Mock;
const _mockPersistGitHubBranchActivity = persistGitHubBranchActivity as Mock;

let mockTx: PullRequestWebhookTx;
let _topLevelTxDoubles: unknown[] = [];

function webhookWriteMocks() {
  return pullRequestWebhookWriteMocks(mockTx, mockUpsertBranchArtifact);
}

describe("handlePullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockParseArtifactReferences.mockReturnValue([]);
    mockUpsertBranchArtifact.mockResolvedValue({
      ok: true,
      value: { id: "new-branch-artifact-id" },
    });

    mockTx = createPullRequestWebhookTx();
    _topLevelTxDoubles = installPullRequestTransactionMock(
      mockWithDbTx,
      mockTx
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("unknown repository", () => {
    it("returns without error when repository is not found", async () => {
      const repository = createRepository(999);
      const pullRequest = createPullRequest({
        number: 50,
        title: "Unknown repo PR",
        state: "closed",
        closed_at: "2026-02-10T15:00:00Z",
      });

      const event = createPullRequestClosedEvent(pullRequest, { repository });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

      await handlePullRequest(event);

      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
      expect(mockTx.artifact.update).not.toHaveBeenCalled();
    });

    it("pins active repository lookup to non-tombstoned installation repositories", async () => {
      const repository = createRepository(999);
      const pullRequest = createPullRequest({
        number: 51,
        title: "Tombstoned repo PR",
        state: "closed",
        closed_at: "2026-02-10T15:00:00Z",
      });

      const event = createPullRequestClosedEvent(pullRequest, { repository });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

      await handlePullRequest(event);

      expect(
        mockTx.gitHubInstallationRepository.findFirst
      ).toHaveBeenCalledWith({
        where: {
          githubRepoId: String(repository.id),
          fullName: repository.full_name,
          removedAt: null,
          installation: {
            installationId: "99",
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        select: {
          id: true,
          fullName: true,
          installation: {
            select: { organizationId: true, installationId: true },
          },
        },
      });
      for (const writeMock of webhookWriteMocks()) {
        expect(writeMock).not.toHaveBeenCalled();
      }
    });
  });

  describe("repository and installation isolation", () => {
    it("rejects missing installation before database reads or writes", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 60,
        title: "Missing installation",
      });

      const response = await handlePullRequest(
        createPullRequestOpenedEvent(pullRequest, {
          repository,
          installation: null,
        })
      );

      expect(response.status).toBe(400);
      expect(mockWithDbTx).not.toHaveBeenCalled();
      expect(
        mockTx.gitHubInstallationRepository.findFirst
      ).not.toHaveBeenCalled();
      for (const write of webhookWriteMocks()) {
        expect(write).not.toHaveBeenCalled();
      }
    });

    it("skips writes when the installation id does not match the registered repository", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 61,
        title: "Wrong installation",
      });
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValueOnce(null);

      await handlePullRequest(
        createPullRequestOpenedEvent(pullRequest, {
          repository,
          installation: createInstallationLite(12_345),
        })
      );

      expect(
        mockTx.gitHubInstallationRepository.findFirst
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            githubRepoId: "789",
            fullName: "owner/test-repo",
            installation: {
              installationId: "12345",
              status: GitHubInstallationStatus.ACTIVE,
            },
          }),
        })
      );
      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
      expect(mockTx.artifact.findUnique).not.toHaveBeenCalled();
      for (const write of webhookWriteMocks()) {
        expect(write).not.toHaveBeenCalled();
      }
    });

    it("skips writes when the GitHub repository id does not match", async () => {
      const repository = createRepository(999_999);
      const pullRequest = createPullRequest({
        number: 62,
        title: "Wrong repository id",
      });
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

      await handlePullRequest(
        createPullRequestOpenedEvent(pullRequest, { repository })
      );

      expect(
        mockTx.gitHubInstallationRepository.findFirst
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            githubRepoId: "999999",
            fullName: "owner/test-repo",
            installation: expect.objectContaining({
              installationId: "99",
            }),
          }),
        })
      );
      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
      for (const write of webhookWriteMocks()) {
        expect(write).not.toHaveBeenCalled();
      }
    });

    it("skips writes when the repository full name does not match", async () => {
      const repository = {
        ...createRepository(789),
        full_name: "owner/renamed-repo",
      };
      const pullRequest = createPullRequest({
        number: 63,
        title: "Wrong full name",
      });
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

      await handlePullRequest(
        createPullRequestOpenedEvent(pullRequest, { repository })
      );

      expect(
        mockTx.gitHubInstallationRepository.findFirst
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            githubRepoId: "789",
            fullName: "owner/renamed-repo",
            installation: expect.objectContaining({
              installationId: "99",
            }),
          }),
        })
      );
      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
      for (const write of webhookWriteMocks()) {
        expect(write).not.toHaveBeenCalled();
      }
    });
  });
});
