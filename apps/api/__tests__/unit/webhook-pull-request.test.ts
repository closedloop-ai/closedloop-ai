/**
 * Pins pull_request webhook lifecycle writes and guarded actions. The sibling
 * linkage suite owns artifact references and upstream status isolation.
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

import { parseArtifactReferences } from "@repo/github/artifact-reference-parser";
import {
  createPullRequestWebhookTx,
  installNestedBranchActivityProducer,
  installPullRequestTransactionMock,
  type PullRequestWebhookTx,
  pullRequestWebhookWriteMocks,
  stubLinkedPlanMergeCascade,
} from "@/__tests__/support/webhooks/github/pull-request-handler.test-mocks";
import { branchService } from "@/app/branches/branch-service";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "@/app/webhooks/github/handlers/branch-activity-producer";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";
import { reconcilePullRequestLabelsForWebhook } from "@/app/webhooks/github/handlers/pull-request-label-reconciliation";
import {
  createHandledPullRequestEvent,
  createPullRequest,
  createPullRequestClosedEvent,
  createPullRequestConvertedToDraftEvent,
  createPullRequestReadyForReviewEvent,
  createPullRequestReopenedEvent,
  createPullRequestSynchronizeEvent,
  createRepository,
} from "../fixtures/github-webhook-fixtures";
import { makePrDetailRow } from "../utils/pr-detail-helpers";

const mockParseArtifactReferences = parseArtifactReferences as Mock;
const mockUpsertBranchArtifact = branchService.upsertBranchArtifact as Mock;
const mockReconcileLabels = reconcilePullRequestLabelsForWebhook as Mock;
const mockPersistGitHubBranchActivity = persistGitHubBranchActivity as Mock;

let mockTx: PullRequestWebhookTx;
let topLevelTxDoubles: unknown[] = [];

function _webhookWriteMocks() {
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
    topLevelTxDoubles = installPullRequestTransactionMock(mockWithDbTx, mockTx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("closed action with merged=true", () => {
    it("updates state to MERGED and sets mergedAt, mergeCommitSha, creates GITHUB_PR_MERGED event", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 42,
        title: "Add feature X",
        state: "closed",
        merged: true,
        closed_at: "2026-02-10T12:00:00Z",
        merged_at: "2026-02-10T12:00:00Z",
        merge_commit_sha: "def456",
      });

      const event = createPullRequestClosedEvent(pullRequest, { repository });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-123",
        installation: { organizationId: "org-uuid-123" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-456",
          organizationId: "org-uuid-123",
          linkedDoc: { id: "artifact-doc-123", slug: "plan-feature-x" },
        })
      );

      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event, {
        deliveryId: "pr-delivery-1",
        observedAt: new Date("2026-08-12T14:00:00.000Z"),
      });

      expect(mockTx.artifact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "artifact-pr-456",
          }),
          data: expect.objectContaining({
            status: "MERGED",
          }),
        })
      );
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { githubId: String(pullRequest.id) },
        data: expect.objectContaining({
          prState: "MERGED",
          mergedAt: new Date("2026-02-10T12:00:00Z"),
          mergeCommitSha: "def456",
        }),
        select: { id: true },
      });

      // Merging a PR must NOT propagate status to upstream documents.
      // A feature/plan can have many PRs, so merging one leaves the linked
      // document untouched.
      expect(mockTx.artifact.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "artifact-doc-123" } })
      );
      expect(mockTx.artifact.updateMany).not.toHaveBeenCalled();
      expect(mockPersistGitHubBranchActivity).toHaveBeenCalledWith({
        eventName: GitHubBranchActivityEventName.PullRequest,
        deliveryId: "pr-delivery-1",
        payload: event,
        attribution: {
          organizationId: "org-uuid-123",
          branchArtifactId: "artifact-pr-456",
          pullRequestDetailId: "artifact-pr-456",
        },
      });
    });
  });

  // FEA-2732 regression: a desktop-synced row can already occupy this
  // (repo, PR#) with repositoryId set but githubId still null (a session
  // referenced an existing PR before any webhook fired). findPullRequestDetail
  // matches it, so the repo-less adopt is skipped and the githubId is never
  // stamped. Before the fix, applyPrAction's githubId-keyed update threw P2025
  // ("record to update not found") and rolled back the entire webhook tx.
  describe("desktop-created row with a null githubId (FEA-2732)", () => {
    it("stamps githubId in place, keyed by the row id, before the action update", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 77,
        title: "Existing PR first synced from desktop",
        state: "closed",
        merged: true,
        closed_at: "2026-03-01T12:00:00Z",
        merged_at: "2026-03-01T12:00:00Z",
        merge_commit_sha: "abc789",
      });

      const event = createPullRequestClosedEvent(pullRequest, { repository });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-123",
        installation: { organizationId: "org-uuid-123" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue({
        ...makePrDetailRow({
          id: "pr-detail-null-gid",
          artifactId: "artifact-pr-null-gid",
          organizationId: "org-uuid-123",
        }),
        githubId: null,
      });
      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.pullRequestDetail.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: "pr-detail-null-gid",
          organizationId: "org-uuid-123",
          githubId: null,
        }),
        data: expect.objectContaining({ githubId: String(pullRequest.id) }),
      });
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { githubId: String(pullRequest.id) },
        })
      );
    });

    it("does not issue an id-keyed stamp when the matched row already has a githubId", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 78,
        title: "App-owned PR",
        state: "closed",
        merged: false,
        closed_at: "2026-03-01T13:00:00Z",
        merged_at: null,
        merge_commit_sha: null,
      });

      const event = createPullRequestClosedEvent(pullRequest, { repository });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-123",
        installation: { organizationId: "org-uuid-123" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue({
        ...makePrDetailRow({
          id: "pr-detail-app",
          artifactId: "artifact-pr-app",
          organizationId: "org-uuid-123",
        }),
        githubId: String(pullRequest.id),
      });
      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event);

      // The githubId-backfill stamp (its distinctive signature: id-keyed with a
      // githubId-only data payload) must not fire — other id-keyed updates from
      // the normal lifecycle are unrelated and allowed.
      expect(mockTx.pullRequestDetail.update).not.toHaveBeenCalledWith({
        where: { id: "pr-detail-app" },
        data: { githubId: String(pullRequest.id) },
      });
    });
  });

  describe("closed action with merged=false", () => {
    it("updates state to CLOSED and creates GITHUB_PR_CLOSED event", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 43,
        title: "Feature rejected",
        state: "closed",
        merged: false,
        closed_at: "2026-02-10T13:00:00Z",
        merged_at: null,
        merge_commit_sha: null,
      });

      const event = createPullRequestClosedEvent(pullRequest, { repository });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-123",
        installation: { organizationId: "org-uuid-123" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-789",
          organizationId: "org-uuid-456",
          linkedDoc: null,
        })
      );

      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.artifact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "artifact-pr-789",
          }),
          data: expect.objectContaining({
            status: "CLOSED",
          }),
        })
      );
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { githubId: String(pullRequest.id) },
        data: expect.objectContaining({
          prState: "CLOSED",
          mergedAt: null,
          mergeCommitSha: null,
        }),
        select: { id: true },
      });

      // Lifecycle status is owned by the closed action; current-PR
      // relationship repair does not issue a duplicate artifact status write.
      expect(mockTx.artifact.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("reopened action", () => {
    it("updates state to OPEN and clears closedAt", async () => {
      const repository = createRepository(123);
      const pullRequest = createPullRequest({
        number: 44,
        title: "Reopened PR",
        state: "open",
      });

      const event = createPullRequestReopenedEvent(pullRequest, { repository });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-456",
        installation: { organizationId: "org-uuid-456" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-reopen",
          organizationId: "org-uuid-456",
          // Already linked so linkage path is skipped
          linkedDoc: { id: "artifact-doc-reopen", slug: "plan-reopen" },
        })
      );

      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.artifact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "artifact-pr-reopen",
          }),
          data: expect.objectContaining({
            status: "OPEN",
          }),
        })
      );
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { githubId: String(pullRequest.id) },
        data: expect.objectContaining({
          prState: "OPEN",
          closedAt: null,
        }),
        select: { id: true },
      });
    });
  });

  describe("ISS-4664 label reconciliation wiring", () => {
    function buildLinkageEvent(action: "opened" | "edited" | "reopened") {
      const repository = createRepository(777);
      const pullRequest = createPullRequest({
        number: 88,
        title: `${action} PR`,
        state: "open",
      });
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-4664",
        installation: { organizationId: "org-uuid-4664" },
      });
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-4664",
          organizationId: "org-uuid-4664",
          linkedDoc: { id: "artifact-doc-4664", slug: "iss-4664" },
        })
      );
      mockTx.artifact.update.mockResolvedValue({});
      return createHandledPullRequestEvent(action, pullRequest, { repository });
    }

    it.each(["opened", "edited", "reopened"] as const)(
      "reconciles labels for the %s linkage action with the repo/PR context",
      async (action) => {
        await handlePullRequest(buildLinkageEvent(action));

        expect(mockReconcileLabels).toHaveBeenCalledTimes(1);
        // The repo id / full name / installation come straight from the webhook
        // event payload (not the DB row), and the PR number identifies the PR.
        expect(mockReconcileLabels).toHaveBeenCalledWith({
          githubRepoId: "777",
          repositoryFullName: "owner/test-repo",
          installationId: "99",
          pullNumber: 88,
        });
      }
    );

    it("does not reconcile labels for a non-linkage action (synchronize)", async () => {
      const repository = createRepository(778);
      const pullRequest = createPullRequest({
        number: 89,
        title: "Synchronized PR",
        head: { sha: "sync-sha" },
      });
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-4664b",
        installation: { organizationId: "org-uuid-4664b" },
      });
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-4664b",
          organizationId: "org-uuid-4664b",
          linkedDoc: null,
        })
      );
      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(
        createPullRequestSynchronizeEvent(pullRequest, { repository }, "old")
      );

      expect(mockReconcileLabels).not.toHaveBeenCalled();
    });

    it("returns a successful 200 webhook response after reconciling a linkage action", async () => {
      const response = await handlePullRequest(buildLinkageEvent("opened"));

      expect(mockReconcileLabels).toHaveBeenCalledTimes(1);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });
  });

  describe("synchronize action", () => {
    it("updates headSha and resets checksStatus to PENDING when PR is synchronized with new commits", async () => {
      const repository = createRepository(456);
      const pullRequest = createPullRequest({
        number: 45,
        title: "Updated PR",
        head: { sha: "new-sha-xyz" },
      });

      const event = createPullRequestSynchronizeEvent(
        pullRequest,
        { repository },
        "old-sha-abc"
      );

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-sync",
        installation: { organizationId: "org-uuid-sync" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-sync",
          checksStatus: "UNKNOWN",
          organizationId: "org-uuid-sync",
          linkedDoc: null,
        })
      );

      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.pullRequestDetail.updateMany).toHaveBeenCalledWith({
        where: {
          id: "artifact-pr-sync",
          organizationId: "org-uuid-sync",
        },
        data: expect.objectContaining({
          prState: "OPEN",
          isDraft: false,
        }),
      });
      expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
        where: { artifactId: "artifact-pr-sync" },
        data: expect.objectContaining({
          headSha: "new-sha-xyz",
          checksStatus: "PENDING",
        }),
      });
    });

    it("applies synchronize even when a push webhook already advanced the branch head", async () => {
      const repository = createRepository(456);
      const pullRequest = createPullRequest({
        number: 45,
        title: "Updated PR",
        head: { sha: "new-sha-xyz" },
      });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-sync",
        installation: { organizationId: "org-uuid-sync" },
      });
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-sync",
          checksStatus: "PASSING",
          headSha: "new-sha-xyz",
          prState: "OPEN",
          isDraft: false,
          organizationId: "org-uuid-sync",
          linkedDoc: null,
        })
      );

      await handlePullRequest(
        createPullRequestSynchronizeEvent(
          pullRequest,
          { repository },
          "old-sha-abc"
        )
      );

      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { githubId: String(pullRequest.id) },
        data: expect.objectContaining({ prState: "OPEN" }),
        select: { id: true },
      });
      expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
        where: { artifactId: "artifact-pr-sync" },
        data: expect.objectContaining({
          headSha: "new-sha-xyz",
          checksStatus: "PENDING",
        }),
      });
    });

    it("does not let a stale foreign current PR suppress a branch synchronize event", async () => {
      const repository = createRepository(456);
      const pullRequest = createPullRequest({
        id: 9020,
        number: 210,
        title: "Updated branch PR",
        head: { sha: "incoming-pr-head" },
      });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-sync",
        installation: { organizationId: "org-uuid-sync" },
      });
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);
      mockTx.pullRequestDetail.upsert.mockResolvedValueOnce({
        id: "incoming-pr-detail-id",
      });
      mockTx.branchDetail.findFirst.mockResolvedValueOnce({
        artifactId: "branch-artifact-sync",
        currentPullRequestDetailId: "foreign-terminal-pr-detail-id",
        checksStatus: "PASSING",
        headSha: "older-head",
        artifact: {
          organizationId: "org-uuid-sync",
          projectId: "project-uuid-sync",
          targetLinks: [],
        },
        currentPullRequestDetail: {
          id: "foreign-terminal-pr-detail-id",
          branchArtifactId: "other-branch-artifact",
          repositoryId: "other-repo",
          githubId: "old-github-pr-id",
          prState: "MERGED",
          isDraft: false,
          closedAt: null,
          mergedAt: new Date("2026-03-01T12:00:00Z"),
        },
      });

      await handlePullRequest(
        createPullRequestSynchronizeEvent(
          pullRequest,
          { repository },
          "older-head"
        )
      );

      expect(mockTx.pullRequestDetail.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            repositoryId_number: {
              repositoryId: "repo-uuid-sync",
              number: pullRequest.number,
            },
          },
          create: expect.objectContaining({
            branchArtifactId: "branch-artifact-sync",
            githubId: String(pullRequest.id),
            repositoryId: "repo-uuid-sync",
          }),
        })
      );
      expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
        where: {
          artifactId: "branch-artifact-sync",
          organizationId: "org-uuid-sync",
        },
        data: { currentPullRequestDetailId: "incoming-pr-detail-id" },
      });
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { githubId: String(pullRequest.id) },
        data: expect.objectContaining({
          prState: "OPEN",
          isDraft: false,
        }),
        select: { id: true },
      });
      expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
        where: { artifactId: "branch-artifact-sync" },
        data: expect.objectContaining({
          headSha: "incoming-pr-head",
          checksStatus: "PENDING",
        }),
      });
    });

    it("creates GITHUB_CI_STATUS_CHANGED event with previousChecksStatus when status was PASSING", async () => {
      const repository = createRepository(456);
      const pullRequest = createPullRequest({
        number: 45,
        title: "Updated PR",
        head: { sha: "new-sha-xyz" },
      });

      const event = createPullRequestSynchronizeEvent(
        pullRequest,
        { repository },
        "old-sha-abc"
      );

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-sync",
        installation: { organizationId: "org-uuid-sync" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-sync",
          checksStatus: "PASSING",
          organizationId: "org-uuid-sync",
          linkedDoc: null,
        })
      );

      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.pullRequestDetail.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            branchArtifact: expect.objectContaining({
              select: expect.objectContaining({
                branch: {
                  select: expect.objectContaining({
                    checksStatus: true,
                    headSha: true,
                  }),
                },
              }),
            }),
          }),
        })
      );
    });
  });

  describe("converted_to_draft action", () => {
    it("sets isDraft to true", async () => {
      const repository = createRepository(111);
      const pullRequest = createPullRequest({
        number: 46,
        title: "Draft PR",
        draft: true,
      });

      const event = createPullRequestConvertedToDraftEvent(pullRequest, {
        repository,
      });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-draft",
        installation: { organizationId: "org-uuid-draft" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-draft",
          organizationId: "org-uuid-draft",
          linkedDoc: null,
        })
      );

      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.artifact.update).toHaveBeenCalledWith({
        where: { id: "artifact-pr-draft" },
        data: { status: "OPEN" },
        select: { id: true },
      });
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { githubId: String(pullRequest.id) },
        data: expect.objectContaining({ isDraft: true }),
        select: { id: true },
      });
    });
  });

  describe("ready_for_review action", () => {
    it("sets isDraft to false", async () => {
      const repository = createRepository(222);
      const pullRequest = createPullRequest({
        number: 47,
        title: "Ready for review",
        draft: false,
      });

      const event = createPullRequestReadyForReviewEvent(pullRequest, {
        repository,
      });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-ready",
        installation: { organizationId: "org-uuid-ready" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-ready",
          organizationId: "org-uuid-ready",
          linkedDoc: null,
        })
      );

      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.artifact.update).toHaveBeenCalledWith({
        where: { id: "artifact-pr-ready" },
        data: { status: "OPEN" },
        select: { id: true },
      });
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { githubId: String(pullRequest.id) },
        data: expect.objectContaining({ isDraft: false }),
        select: { id: true },
      });
    });
  });

  describe("transaction behavior", () => {
    it("executes all reads and writes within a single transaction", async () => {
      const repository = createRepository(555);
      const pullRequest = createPullRequest({
        number: 53,
        title: "Transaction test",
        state: "closed",
        merged: true,
        closed_at: "2026-02-10T14:00:00Z",
        merged_at: "2026-02-10T14:00:00Z",
        merge_commit_sha: "commit-sha",
      });

      const event = createPullRequestClosedEvent(pullRequest, { repository });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: "repo-uuid-tx",
        installation: { organizationId: "org-uuid-tx" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-tx",
          organizationId: "org-uuid-tx",
          linkedDoc: { id: "artifact-doc-tx", slug: "plan-tx" },
        })
      );

      mockTx.artifact.update.mockResolvedValue({});

      stubLinkedPlanMergeCascade(mockTx, "artifact-doc-tx");

      // A producer double that never enters `withDb.tx` leaves the nested path
      // unexercised, so the counts below would hold even if ambient joining broke.
      const readNestedTx = installNestedBranchActivityProducer(
        mockPersistGitHubBranchActivity,
        mockWithDbTx
      );

      await handlePullRequest(event);

      // Atomicity is one top-level entry that every nested `withDb.tx` from a
      // downstream service joins. A raw invocation count would assert mock
      // plumbing instead, so pin the doubles themselves.
      expect(mockWithDbTx).toHaveBeenCalled();
      expect(readNestedTx()).toBe(mockTx);
      expect(topLevelTxDoubles).toHaveLength(1);
      expect(mockTx.gitHubInstallationRepository.findFirst).toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.findUnique).toHaveBeenCalled();
      expect(mockTx.artifact.update).toHaveBeenCalled();
    });
  });
});
