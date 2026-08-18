/**
 * `handlePullRequest` — the rule that settling a pull request settles the PR
 * record and nothing upstream of it. A produces-link says a document caused
 * this PR, not that merging the PR finishes the document, so a merged or
 * closed PR must never write the linked plan or feature. This reverts
 * FEA-3658, which advanced a produces-linked FEATURE to DONE here. Split out
 * of `webhook-pull-request-linkage.test.ts`, which owns how that produces-link
 * is created in the first place.
 */

import type { PullRequestClosedEvent } from "@octokit/webhooks-types";
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
  return {
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      BRANCH: "BRANCH",

      DEPLOYMENT: "DEPLOYMENT",
    },
    GitHubInstallationStatus: {
      ACTIVE: "ACTIVE",
    },
    ArtifactSubtype: {
      PRD: "PRD",
      IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
      TEMPLATE: "TEMPLATE",
      FEATURE: "FEATURE",
    },
    ChecksStatus: {
      UNKNOWN: "UNKNOWN",
      PENDING: "PENDING",
      PASSING: "PASSING",
      FAILING: "FAILING",
    },
    withDb: mockWithDb,
  };
});

vi.mock("@repo/github/artifact-reference-parser", () => ({
  parseArtifactReferences: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: vi.fn().mockResolvedValue("WORK-99"),
}));

vi.mock("@/lib/artifact-adapters", () => ({
  documentWhere: (where: any) => ({ ...where, type: "DOCUMENT" }),
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

// ISS-4664: the handler calls this AFTER the transaction commits. Mocked so a
// closed-action assertion here is never mixed with real label reconciliation.
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

// Import after mocking
import { ArtifactSubtype } from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { parseArtifactReferences } from "@repo/github/artifact-reference-parser";
import { createPullRequestWebhookTx } from "@/__tests__/support/webhooks/github/pull-request-handler.test-mocks";
import { branchService } from "@/app/branches/branch-service";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";
import {
  createPullRequest,
  createRepository,
  createSender,
} from "../fixtures/github-webhook-fixtures";
import { makePrDetailRow } from "../utils/pr-detail-helpers";

const mockParseArtifactReferences = parseArtifactReferences as Mock;
const mockUpsertBranchArtifact = branchService.upsertBranchArtifact as Mock;

// Type aliases for mocked functions
const mockWithDbTx = withDb.tx as unknown as Mock;

// Mock database transaction client
let mockTx: any;

describe("handlePullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockParseArtifactReferences.mockReturnValue([]);
    mockUpsertBranchArtifact.mockResolvedValue({
      ok: true,
      value: { id: "new-branch-artifact-id" },
    });

    mockTx = createPullRequestWebhookTx();

    mockWithDbTx.mockImplementation((callback: any) => callback(mockTx));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("settling a PR never propagates status upstream", () => {
    const ORG_ID = "org-uuid-link";
    const REPO_ID = "repo-uuid-link";
    const ARTIFACT_ID = "artifact-uuid-link";

    function setupRepoMock() {
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: REPO_ID,
        installation: { organizationId: ORG_ID },
      });
    }

    it("PR merge with a linked plan does not change the plan status", async () => {
      setupRepoMock();

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-merge",
          checksStatus: "PASSING",
          organizationId: ORG_ID,
          linkedDoc: { id: ARTIFACT_ID, slug: "PLN-42" },
        })
      );
      mockTx.artifact.update.mockResolvedValue({});

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: 106,
        pull_request: createPullRequest({
          id: 9007,
          number: 106,
          title: "PLN-42: Feature",
          state: "closed",
          merged: true,
          closed_at: "2026-03-01T12:00:00Z",
          merged_at: "2026-03-01T12:00:00Z",
          merge_commit_sha: "merge-sha",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as any;

      await handlePullRequest(event);

      // Merging a PR must not propagate status to the upstream plan.
      expect(mockTx.artifact.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: ARTIFACT_ID } })
      );
      expect(mockTx.artifact.updateMany).not.toHaveBeenCalled();
    });

    // A merge settles the PR record and nothing upstream of it. A produces-link
    // says a document caused this PR, not that merging the PR finishes the
    // document — those statuses stay human-owned. This reverts FEA-3658, which
    // advanced a produces-linked FEATURE to DONE here.
    it("merging a FEA-linked PR settles only the PR record, never the feature", async () => {
      setupRepoMock();

      const FEATURE_ID = "feature-uuid-merge";
      const BRANCH_ARTIFACT_ID = "artifact-pr-feature-merge";
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: BRANCH_ARTIFACT_ID,
          checksStatus: "PASSING",
          organizationId: ORG_ID,
          linkedDoc: { id: FEATURE_ID, slug: "FEA-42" },
        })
      );
      // Every precondition the removed auto-advance required is satisfied here:
      // a non-terminal FEATURE...
      mockTx.artifact.findFirst.mockResolvedValue({
        id: FEATURE_ID,
        subtype: ArtifactSubtype.Feature,
        status: IssueStatus.InProgress,
      });
      // ...with no other open PR left on it. It must still not advance.
      mockTx.pullRequestDetail.findFirst.mockResolvedValue(null);
      mockTx.artifact.update.mockResolvedValue({});

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: 203,
        pull_request: createPullRequest({
          id: 9011,
          number: 203,
          title: "FEA-42: fix login timeout",
          state: "closed",
          merged: true,
          closed_at: "2026-03-01T12:00:00Z",
          merged_at: "2026-03-01T12:00:00Z",
          merge_commit_sha: "merge-sha-feature",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as any;

      await handlePullRequest(event);

      // The PR's own record IS settled — the branch artifact goes MERGED...
      expect(mockTx.artifact.update).toHaveBeenCalledWith({
        where: { id: BRANCH_ARTIFACT_ID },
        data: { status: GitHubPRState.Merged },
        select: { id: true },
      });
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { githubId: "9011" },
        data: expect.objectContaining({ prState: GitHubPRState.Merged }),
        select: { id: true },
      });
      // ...and that is the ONLY artifact status write the merge performs.
      expect(mockTx.artifact.update).toHaveBeenCalledTimes(1);
      expect(mockTx.artifact.updateMany).not.toHaveBeenCalled();
      // The linked feature is never read, so it cannot be written.
      expect(mockTx.artifact.findFirst).not.toHaveBeenCalled();
      // And no per-document advisory lock is taken on the merge path.
      expect(mockTx.$executeRaw).not.toHaveBeenCalled();
    });

    it("closing a FEA-linked PR without merging settles only the PR record", async () => {
      setupRepoMock();

      const FEATURE_ID = "feature-uuid-closed";
      const BRANCH_ARTIFACT_ID = "artifact-pr-feature-closed";
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: BRANCH_ARTIFACT_ID,
          checksStatus: "PASSING",
          organizationId: ORG_ID,
          linkedDoc: { id: FEATURE_ID, slug: "FEA-99" },
        })
      );
      mockTx.artifact.update.mockResolvedValue({});

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: 213,
        pull_request: createPullRequest({
          id: 9024,
          number: 213,
          title: "FEA-99: abandoned",
          state: "closed",
          merged: false,
          closed_at: "2026-03-01T12:00:00Z",
          merged_at: null,
          merge_commit_sha: null,
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as any;

      await handlePullRequest(event);

      expect(mockTx.artifact.update).toHaveBeenCalledWith({
        where: { id: BRANCH_ARTIFACT_ID },
        data: { status: GitHubPRState.Closed },
        select: { id: true },
      });
      expect(mockTx.artifact.update).toHaveBeenCalledTimes(1);
      expect(mockTx.artifact.findFirst).not.toHaveBeenCalled();
      expect(mockTx.artifact.updateMany).not.toHaveBeenCalled();
    });

    it("merging a plan-linked PR does not cascade to the plan or its upstream features", async () => {
      setupRepoMock();

      const PLAN_ID = "plan-uuid-cascade";
      const BRANCH_ARTIFACT_ID = "artifact-pr-cascade";
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: BRANCH_ARTIFACT_ID,
          checksStatus: "PASSING",
          organizationId: ORG_ID,
          linkedDoc: { id: PLAN_ID, slug: "PLN-17" },
        })
      );
      mockTx.artifact.update.mockResolvedValue({});

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: 204,
        pull_request: createPullRequest({
          id: 9012,
          number: 204,
          title: "PLN-17: ship feature bundle",
          state: "closed",
          merged: true,
          closed_at: "2026-03-01T12:00:00Z",
          merged_at: "2026-03-01T12:00:00Z",
          merge_commit_sha: "merge-sha-cascade",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as any;

      await handlePullRequest(event);

      // Only the branch/PR artifact moves; the plan (and anything upstream of
      // it) is untouched.
      expect(mockTx.artifact.update).toHaveBeenCalledWith({
        where: { id: BRANCH_ARTIFACT_ID },
        data: { status: GitHubPRState.Merged },
        select: { id: true },
      });
      expect(mockTx.artifact.update).toHaveBeenCalledTimes(1);
      expect(mockTx.artifact.updateMany).not.toHaveBeenCalled();
    });
  });
});
