/**
 * Unit tests for GitHub pull_request webhook handler.
 *
 * Tests the handlePullRequest function which processes PR lifecycle events:
 * - opened: Parse plan references from title/body, link PR to plan artifact
 * - edited: Parse plan references from title/body, link PR to plan artifact (if not already linked)
 * - closed (merged=true) → Updates state to MERGED, sets mergedAt and mergeCommitSha
 * - closed (merged=false) → Updates state to CLOSED
 * - reopened → Updates state to OPEN, re-checks plan references
 * - synchronize → Updates headSha
 * - converted_to_draft → Sets isDraft=true
 * - ready_for_review → Sets isDraft=false
 * - Unknown PR/Repository → Returns without error
 * - Unsupported actions → Skips without DB queries
 */

import type {
  PullRequestClosedEvent,
  PullRequestConvertedToDraftEvent,
  PullRequestReadyForReviewEvent,
  PullRequestReopenedEvent,
  PullRequestSynchronizeEvent,
} from "@octokit/webhooks-types";
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
      PULL_REQUEST: "PULL_REQUEST",
      DEPLOYMENT: "DEPLOYMENT",
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
    WorkstreamType: {
      FEATURE_DELIVERY: "FEATURE_DELIVERY",
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

// Import after mocking
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { withDb } from "@repo/database";
import { parseArtifactReferences } from "@repo/github/artifact-reference-parser";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";
import {
  createPullRequest,
  createRepository,
  createSender,
} from "../fixtures/github-webhook-fixtures";
import { makePrDetailRow } from "../utils/pr-detail-helpers";

const mockParseArtifactReferences = parseArtifactReferences as Mock;

// Type aliases for mocked functions
const mockWithDb = withDb as unknown as Mock;
const mockWithDbTx = withDb.tx as unknown as Mock;

// Mock database transaction client
let mockTx: any;

describe("handlePullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockParseArtifactReferences.mockReturnValue([]);

    mockTx = {
      gitHubInstallationRepository: {
        findFirst: vi.fn(),
      },
      pullRequestDetail: {
        findUnique: vi.fn(),
      },
      artifact: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifactLink: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
      },
      workstream: {
        create: vi.fn(),
      },
      workstreamEvent: {
        create: vi.fn(),
      },
    };

    mockWithDbTx.mockImplementation((callback: any) => callback(mockTx));
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

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        installation: { organizationId: "org-uuid-123" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-456",
          organizationId: "org-uuid-123",
          workstreamId: "ws-uuid-789",
          linkedDoc: { id: "artifact-doc-123", slug: "plan-feature-x" },
        })
      );

      mockTx.artifact.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      // Merge cascade: artifactLink.findMany → artifact.findMany
      mockTx.artifactLink.findMany.mockResolvedValueOnce([
        { sourceId: "artifact-doc-123" },
      ]);
      mockTx.artifact.findMany.mockResolvedValueOnce([
        {
          id: "artifact-doc-123",
          subtype: "IMPLEMENTATION_PLAN",
          status: DocumentStatus.InProgress,
        },
      ]);

      await handlePullRequest(event);

      // PR artifact update with status = MERGED
      expect(mockTx.artifact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "artifact-pr-456" },
          data: expect.objectContaining({
            status: "MERGED",
            pullRequest: expect.objectContaining({
              update: expect.objectContaining({
                prState: "MERGED",
                mergedAt: new Date("2026-02-10T12:00:00Z"),
                mergeCommitSha: "def456",
              }),
            }),
          }),
        })
      );

      // Workstream event
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: {
          workstreamId: "ws-uuid-789",
          type: "GITHUB_PR_MERGED",
          actorType: "system",
          data: {
            prNumber: 42,
            prTitle: "Add feature X",
            prUrl: "https://github.com/owner/test-repo/pull/1",
            documentId: "artifact-doc-123",
            slug: "plan-feature-x",
            mergedAt: "2026-02-10T12:00:00Z",
            mergeCommitSha: "def456",
          },
        },
      });

      // Linked document → EXECUTED via artifact.update (second update call)
      expect(mockTx.artifact.update).toHaveBeenCalledWith({
        where: { id: "artifact-doc-123" },
        data: { status: DocumentStatus.Executed },
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

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        installation: { organizationId: "org-uuid-123" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-789",
          organizationId: "org-uuid-456",
          workstreamId: "ws-uuid-abc",
          linkedDoc: null,
        })
      );

      mockTx.artifact.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.artifact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "artifact-pr-789" },
          data: expect.objectContaining({
            status: "CLOSED",
            pullRequest: expect.objectContaining({
              update: expect.objectContaining({
                prState: "CLOSED",
                mergedAt: null,
                mergeCommitSha: null,
              }),
            }),
          }),
        })
      );

      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: {
          workstreamId: "ws-uuid-abc",
          type: "GITHUB_PR_CLOSED",
          actorType: "system",
          data: {
            prNumber: 43,
            prTitle: "Feature rejected",
            prUrl: "https://github.com/owner/test-repo/pull/1",
            documentId: null,
            slug: undefined,
          },
        },
      });

      // Only one artifact.update (PR); no cascade update since merged=false
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

      const event: PullRequestReopenedEvent = {
        action: "reopened",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-456",
        installation: { organizationId: "org-uuid-456" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-reopen",
          organizationId: "org-uuid-456",
          workstreamId: "ws-uuid-def",
          // Already linked so linkage path is skipped
          linkedDoc: { id: "artifact-doc-reopen", slug: "plan-reopen" },
        })
      );

      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.artifact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "artifact-pr-reopen" },
          data: expect.objectContaining({
            status: "OPEN",
            pullRequest: expect.objectContaining({
              update: expect.objectContaining({
                prState: "OPEN",
                closedAt: null,
              }),
            }),
          }),
        })
      );
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

      const event: PullRequestSynchronizeEvent = {
        action: "synchronize",
        number: pullRequest.number,
        before: "old-sha-abc",
        after: "new-sha-xyz",
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-sync",
        installation: { organizationId: "org-uuid-sync" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-sync",
          checksStatus: "UNKNOWN",
          organizationId: "org-uuid-sync",
          workstreamId: "ws-uuid-sync",
          linkedDoc: null,
        })
      );

      mockTx.artifact.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.artifact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "artifact-pr-sync" },
          data: expect.objectContaining({
            pullRequest: expect.objectContaining({
              update: expect.objectContaining({
                headSha: "new-sha-xyz",
                checksStatus: "PENDING",
              }),
            }),
          }),
        })
      );
    });

    it("creates GITHUB_CI_STATUS_CHANGED event with previousChecksStatus when status was PASSING", async () => {
      const repository = createRepository(456);
      const pullRequest = createPullRequest({
        number: 45,
        title: "Updated PR",
        head: { sha: "new-sha-xyz" },
      });

      const event: PullRequestSynchronizeEvent = {
        action: "synchronize",
        number: pullRequest.number,
        before: "old-sha-abc",
        after: "new-sha-xyz",
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-sync",
        installation: { organizationId: "org-uuid-sync" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-sync",
          checksStatus: "PASSING",
          organizationId: "org-uuid-sync",
          workstreamId: "ws-uuid-sync",
          linkedDoc: null,
        })
      );

      mockTx.artifact.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.pullRequestDetail.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ checksStatus: true }),
        })
      );

      // Verify GITHUB_CI_STATUS_CHANGED workstream event is created with previousChecksStatus
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workstreamId: "ws-uuid-sync",
          type: "GITHUB_CI_STATUS_CHANGED",
          actorType: "system",
          data: expect.objectContaining({
            checksStatus: "PENDING",
            previousChecksStatus: "PASSING",
            headSha: "new-sha-xyz",
          }),
        }),
      });
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

      const event: PullRequestConvertedToDraftEvent = {
        action: "converted_to_draft",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-draft",
        installation: { organizationId: "org-uuid-draft" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-draft",
          organizationId: "org-uuid-draft",
          workstreamId: "ws-uuid-draft",
          linkedDoc: null,
        })
      );

      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.artifact.update).toHaveBeenCalledWith({
        where: { id: "artifact-pr-draft" },
        data: { pullRequest: { update: { isDraft: true } } },
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

      const event: PullRequestReadyForReviewEvent = {
        action: "ready_for_review",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-ready",
        installation: { organizationId: "org-uuid-ready" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-ready",
          organizationId: "org-uuid-ready",
          workstreamId: "ws-uuid-ready",
          linkedDoc: null,
        })
      );

      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.artifact.update).toHaveBeenCalledWith({
        where: { id: "artifact-pr-ready" },
        data: { pullRequest: { update: { isDraft: false } } },
      });
    });
  });

  describe("unknown repository", () => {
    it("returns without error when repository is not found", async () => {
      const repository = createRepository(999);
      const pullRequest = createPullRequest({
        number: 50,
        title: "Unknown repo PR",
      });

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

      await handlePullRequest(event);

      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
      expect(mockTx.artifact.update).not.toHaveBeenCalled();
    });
  });

  describe("unknown pull request", () => {
    it("returns without error when PR is not found in database", async () => {
      const repository = createRepository(333);
      const pullRequest = createPullRequest({
        number: 51,
        title: "Unknown PR",
      });

      const event: PullRequestReopenedEvent = {
        action: "reopened",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-exists",
        installation: { organizationId: "org-uuid-exists" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);

      await handlePullRequest(event);

      expect(mockTx.artifact.update).not.toHaveBeenCalled();
    });
  });

  describe("unsupported actions", () => {
    it("skips DB queries for unsupported action types", async () => {
      const repository = createRepository(444);
      const pullRequest = createPullRequest({
        number: 52,
        title: "Labeled PR",
      });

      const event = {
        action: "labeled",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      await handlePullRequest(event);

      expect(
        mockTx.gitHubInstallationRepository.findFirst
      ).not.toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
      expect(mockTx.artifact.update).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
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

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-tx",
        installation: { organizationId: "org-uuid-tx" },
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-tx",
          organizationId: "org-uuid-tx",
          workstreamId: "ws-uuid-tx",
          linkedDoc: { id: "artifact-doc-tx", slug: "plan-tx" },
        })
      );

      mockTx.artifact.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      // Merge cascade
      mockTx.artifactLink.findMany.mockResolvedValueOnce([
        { sourceId: "artifact-doc-tx" },
      ]);
      mockTx.artifact.findMany.mockResolvedValueOnce([
        {
          id: "artifact-doc-tx",
          subtype: "IMPLEMENTATION_PLAN",
          status: DocumentStatus.InProgress,
        },
      ]);

      await handlePullRequest(event);

      expect(mockWithDbTx).toHaveBeenCalledTimes(1);
      expect(mockWithDb).not.toHaveBeenCalled();

      expect(mockTx.gitHubInstallationRepository.findFirst).toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.findUnique).toHaveBeenCalled();
      expect(mockTx.artifact.update).toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).toHaveBeenCalled();
    });
  });

  describe("plan reference linkage", () => {
    const ORG_ID = "org-uuid-link";
    const REPO_ID = "repo-uuid-link";
    const ARTIFACT_ID = "artifact-uuid-link";
    const WORKSTREAM_ID = "ws-uuid-link";

    function setupRepoMock() {
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: REPO_ID,
        installation: { organizationId: ORG_ID },
      });
    }

    function setupArtifactMock(
      overrides?: Partial<{
        id: string;
        type: string;
        subtype: string;
        organizationId: string;
        projectId: string | null;
        workstreamId: string | null;
        slug: string;
      }>
    ) {
      // tx.artifact.findUnique (by organizationId_slug) → returns Document artifact
      mockTx.artifact.findUnique.mockResolvedValue({
        id: ARTIFACT_ID,
        type: "DOCUMENT",
        subtype: "IMPLEMENTATION_PLAN",
        name: "Test Plan",
        organizationId: ORG_ID,
        projectId: "project-uuid-link",
        workstreamId: WORKSTREAM_ID,
        assigneeId: null,
        createdById: "user-uuid-link",
        slug: "PLAN-42",
        ...overrides,
      });
    }

    function setupPlanRef(slug = "PLN-42") {
      mockParseArtifactReferences.mockReturnValue([
        {
          slug,
          prefix: SlugPrefix.Plan,
          docType: DocumentType.ImplementationPlan,
          matchType: "slug",
          source: "title",
        },
      ]);
    }

    function setupFeatureRef(slug = "FEA-42") {
      mockParseArtifactReferences.mockReturnValue([
        {
          slug,
          prefix: SlugPrefix.Feature,
          docType: DocumentType.Feature,
          matchType: "slug",
          source: "title",
        },
      ]);
    }

    function setupLinkageMocks() {
      // No existing PR detail by githubId
      // First findUnique call is by repositoryId_number (returns null).
      // Second findUnique call is by githubId (returns null).
      mockTx.artifact.findFirst.mockResolvedValue(null);
      mockTx.artifactLink.findFirst.mockResolvedValue(null);
      mockTx.artifactLink.create.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});
    }

    it("links PR opened with valid PLAN slug to artifact", async () => {
      setupRepoMock();
      setupPlanRef();
      setupArtifactMock();
      setupLinkageMocks();
      // First findUnique call (repositoryId_number lookup) returns null (no PR yet).
      // Second findUnique call (githubId dedup) returns null.
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);
      // Simulate create returning a new PR artifact
      mockTx.artifact.create.mockResolvedValue({
        id: "new-pr-artifact-id",
      });
      // After create, createLinkageRecords looks up by githubId first; still null.
      // Then fallback: artifact.findFirst by externalUrl returns the newly-created PR artifact.
      mockTx.artifact.findFirst.mockResolvedValue({
        id: "new-pr-artifact-id",
      });

      const event = {
        action: "opened",
        number: 100,
        pull_request: createPullRequest({
          id: 9001,
          number: 100,
          title: "PLAN-42: Add feature",
        }),
        repository: createRepository(789),
        sender: createSender(),
      } as any;

      await handlePullRequest(event);

      // Should create a new PR Artifact with nested pullRequest detail
      expect(mockTx.artifact.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "PULL_REQUEST",
            organizationId: ORG_ID,
            workstreamId: WORKSTREAM_ID,
            status: "OPEN",
            pullRequest: expect.objectContaining({
              create: expect.objectContaining({
                repositoryId: REPO_ID,
                number: 100,
                prState: "OPEN",
              }),
            }),
          }),
        })
      );

      // Should create an ArtifactLink (DOCUMENT → PULL_REQUEST via Produces)
      expect(mockTx.artifactLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: ORG_ID,
            sourceId: ARTIFACT_ID,
            linkType: "PRODUCES",
          }),
        })
      );

      // Should create GITHUB_PR_LINKED workstream event
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workstreamId: WORKSTREAM_ID,
            type: "GITHUB_PR_LINKED",
            data: expect.objectContaining({
              documentId: ARTIFACT_ID,
              slug: "PLAN-42",
            }),
          }),
        })
      );
    });

    it("links PR edited to add plan reference retroactively", async () => {
      setupRepoMock();
      setupPlanRef();
      setupArtifactMock();
      setupLinkageMocks();

      // First findUnique (repositoryId_number) → existing PR without linkedDoc
      mockTx.pullRequestDetail.findUnique.mockResolvedValueOnce(
        makePrDetailRow({
          artifactId: "artifact-pr-edit",
          organizationId: ORG_ID,
          workstreamId: WORKSTREAM_ID,
          linkedDoc: null,
        })
      );
      // Second findUnique (by githubId in createLinkageRecords) → returns artifactId
      mockTx.pullRequestDetail.findUnique.mockResolvedValueOnce({
        artifactId: "artifact-pr-edit",
      });
      mockTx.artifact.update.mockResolvedValue({});

      const event = {
        action: "edited",
        number: 101,
        pull_request: createPullRequest({
          id: 9002,
          number: 101,
          title: "PLAN-42: Updated",
        }),
        repository: createRepository(789),
        sender: createSender(),
        changes: {},
      } as any;

      await handlePullRequest(event);

      // Should update PR artifact (via createLinkageRecords) and create linkage
      expect(mockTx.artifactLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sourceId: ARTIFACT_ID,
            targetId: "artifact-pr-edit",
            linkType: "PRODUCES",
          }),
        })
      );

      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "GITHUB_PR_LINKED",
          }),
        })
      );
    });

    it("does not fail for invalid slug (returns 200)", async () => {
      setupRepoMock();
      setupPlanRef("PLAN-999");
      mockTx.artifact.findUnique.mockResolvedValue(null);
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);

      const event = {
        action: "opened",
        number: 102,
        pull_request: createPullRequest({
          id: 9003,
          number: 102,
          title: "PLAN-999: Missing",
        }),
        repository: createRepository(789),
        sender: createSender(),
      } as any;

      const response = await handlePullRequest(event);
      const json = await response.json();

      expect(json.ok).toBe(true);
      expect(mockTx.artifactLink.create).not.toHaveBeenCalled();
      expect(mockTx.artifact.create).not.toHaveBeenCalled();
    });

    it("does not link when docType mismatches ref prefix (prefix collision)", async () => {
      setupRepoMock();
      setupPlanRef("PLN-42");
      // Artifact is a PRD (not ImplementationPlan, which is what the ref claims)
      setupArtifactMock({ subtype: "PRD" });
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);

      const event = {
        action: "opened",
        number: 103,
        pull_request: createPullRequest({
          id: 9004,
          number: 103,
          title: "PLN-42: PRD ref",
        }),
        repository: createRepository(789),
        sender: createSender(),
      } as any;

      await handlePullRequest(event);

      expect(mockTx.artifactLink.create).not.toHaveBeenCalled();
      expect(mockTx.artifact.create).not.toHaveBeenCalled();
    });

    it("does not overwrite existing link (AC-004)", async () => {
      setupRepoMock();
      setupPlanRef("PLAN-42");

      // PR already linked to a different document
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-linked",
          organizationId: ORG_ID,
          workstreamId: WORKSTREAM_ID,
          linkedDoc: { id: "existing-doc-id", slug: "PLAN-1" },
        })
      );

      const event = {
        action: "edited",
        number: 104,
        pull_request: createPullRequest({
          id: 9005,
          number: 104,
          title: "PLAN-42: Override attempt",
        }),
        repository: createRepository(789),
        sender: createSender(),
        changes: {},
      } as any;

      await handlePullRequest(event);

      // Should NOT look up artifact or create linkage
      expect(mockTx.artifact.findUnique).not.toHaveBeenCalled();
      expect(mockTx.artifactLink.create).not.toHaveBeenCalled();
    });

    it("does not create duplicate ArtifactLink on repeated webhook delivery (AC-008)", async () => {
      setupRepoMock();
      setupPlanRef();
      setupArtifactMock();

      // First findUnique (repositoryId_number) → existing PR without linkedDoc
      mockTx.pullRequestDetail.findUnique.mockResolvedValueOnce(
        makePrDetailRow({
          artifactId: "artifact-pr-dup",
          organizationId: ORG_ID,
          workstreamId: WORKSTREAM_ID,
          linkedDoc: null,
        })
      );
      // Second findUnique (by githubId in createLinkageRecords) → returns artifactId
      mockTx.pullRequestDetail.findUnique.mockResolvedValueOnce({
        artifactId: "artifact-pr-dup",
      });
      mockTx.artifact.update.mockResolvedValue({});

      // ArtifactLink already exists
      mockTx.artifactLink.findFirst.mockResolvedValue({
        id: "existing-artifact-link",
      });

      mockTx.workstreamEvent.create.mockResolvedValue({});

      const event = {
        action: "reopened",
        number: 105,
        pull_request: createPullRequest({
          id: 9006,
          number: 105,
          title: "PLAN-42: Reopened",
        }),
        repository: createRepository(789),
        sender: createSender(),
      } as any;

      await handlePullRequest(event);

      // Should NOT create duplicate ArtifactLink
      expect(mockTx.artifactLink.create).not.toHaveBeenCalled();

      // Should still create workstream event
      expect(mockTx.workstreamEvent.create).toHaveBeenCalled();
    });

    it("PR merge with linked plan sets status to EXECUTED (existing behavior)", async () => {
      setupRepoMock();

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-merge",
          checksStatus: "PASSING",
          organizationId: ORG_ID,
          workstreamId: WORKSTREAM_ID,
          linkedDoc: { id: ARTIFACT_ID, slug: "PLN-42" },
        })
      );
      mockTx.artifact.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      // Merge cascade
      mockTx.artifactLink.findMany.mockResolvedValueOnce([
        { sourceId: ARTIFACT_ID },
      ]);
      mockTx.artifact.findMany.mockResolvedValueOnce([
        {
          id: ARTIFACT_ID,
          subtype: "IMPLEMENTATION_PLAN",
          status: DocumentStatus.InProgress,
        },
      ]);

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
      } as any;

      await handlePullRequest(event);

      expect(mockTx.artifact.update).toHaveBeenCalledWith({
        where: { id: ARTIFACT_ID },
        data: { status: DocumentStatus.Executed },
      });
    });

    it("PR opened with FEA slug links to feature document", async () => {
      setupRepoMock();
      setupFeatureRef("FEA-42");
      setupArtifactMock({
        subtype: "FEATURE",
        slug: "FEA-42",
      });
      setupLinkageMocks();
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);
      mockTx.artifact.create.mockResolvedValue({ id: "new-pr-id-feature" });
      mockTx.artifact.findFirst.mockResolvedValue({ id: "new-pr-id-feature" });

      const event = {
        action: "opened",
        number: 200,
        pull_request: createPullRequest({
          id: 9008,
          number: 200,
          title: "FEA-42: fix login timeout",
        }),
        repository: createRepository(789),
        sender: createSender(),
      } as any;

      await handlePullRequest(event);

      // PR artifact created via tx.artifact.create (with nested pullRequest)
      expect(mockTx.artifact.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "PULL_REQUEST",
          }),
        })
      );
      // ArtifactLink created with FEATURE document as source
      expect(mockTx.artifactLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sourceId: ARTIFACT_ID,
            linkType: "PRODUCES",
          }),
        })
      );
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "GITHUB_PR_LINKED",
            data: expect.objectContaining({
              slug: "FEA-42",
            }),
          }),
        })
      );
    });

    it("skips linkage when FEA slug resolves to non-Feature document (prefix collision)", async () => {
      setupRepoMock();
      setupFeatureRef("FEA-42");
      // Document exists but is an ImplementationPlan (simulated collision)
      setupArtifactMock({
        subtype: "IMPLEMENTATION_PLAN",
        slug: "FEA-42",
      });
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);

      const event = {
        action: "opened",
        number: 201,
        pull_request: createPullRequest({
          id: 9009,
          number: 201,
          title: "FEA-42: collision",
        }),
        repository: createRepository(789),
        sender: createSender(),
      } as any;

      await handlePullRequest(event);

      expect(mockTx.artifactLink.create).not.toHaveBeenCalled();
      expect(mockTx.artifact.create).not.toHaveBeenCalled();
    });

    it("when PR references both PLN and FEA, plan wins and only one link is created", async () => {
      setupRepoMock();
      // Parser returns both refs — plan first (matches real behaviour for same-source refs)
      mockParseArtifactReferences.mockReturnValue([
        {
          slug: "PLN-17",
          prefix: SlugPrefix.Plan,
          docType: DocumentType.ImplementationPlan,
          matchType: "slug",
          source: "title",
        },
        {
          slug: "FEA-42",
          prefix: SlugPrefix.Feature,
          docType: DocumentType.Feature,
          matchType: "slug",
          source: "title",
        },
      ]);
      setupArtifactMock({ slug: "PLN-17" });
      setupLinkageMocks();
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);
      mockTx.artifact.create.mockResolvedValue({ id: "new-pr-id-both" });
      mockTx.artifact.findFirst.mockResolvedValue({ id: "new-pr-id-both" });

      const event = {
        action: "opened",
        number: 202,
        pull_request: createPullRequest({
          id: 9010,
          number: 202,
          title: "FEA-42: implement PLN-17",
        }),
        repository: createRepository(789),
        sender: createSender(),
      } as any;

      await handlePullRequest(event);

      // Only the plan was looked up by slug
      expect(mockTx.artifact.findUnique).toHaveBeenCalledTimes(1);
      expect(mockTx.artifact.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId_slug: { organizationId: ORG_ID, slug: "PLN-17" },
          }),
        })
      );
      // Only one ArtifactLink + one WorkstreamEvent
      expect(mockTx.artifactLink.create).toHaveBeenCalledTimes(1);
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledTimes(1);
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "GITHUB_PR_LINKED",
            data: expect.objectContaining({
              documentId: ARTIFACT_ID,
              slug: "PLN-17",
            }),
          }),
        })
      );
    });

    it("merging a direct-FEA-linked PR sets the feature to DONE", async () => {
      setupRepoMock();

      const FEATURE_ID = "feature-uuid-merge";
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-feature-merge",
          checksStatus: "PASSING",
          organizationId: ORG_ID,
          workstreamId: WORKSTREAM_ID,
          linkedDoc: { id: FEATURE_ID, slug: "FEA-42" },
        })
      );
      mockTx.artifact.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      mockTx.artifactLink.findMany.mockResolvedValueOnce([
        { sourceId: FEATURE_ID },
      ]);
      mockTx.artifact.findMany.mockResolvedValueOnce([
        {
          id: FEATURE_ID,
          subtype: "FEATURE",
          status: DocumentStatus.InProgress,
        },
      ]);

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
      } as any;

      await handlePullRequest(event);

      expect(mockTx.artifact.update).toHaveBeenCalledWith({
        where: { id: FEATURE_ID },
        data: { status: DocumentStatus.Done },
      });
      // Plan cascade (updateMany for features upstream of a plan) should NOT run
      expect(mockTx.artifact.updateMany).not.toHaveBeenCalled();
    });

    it("merging a plan-linked PR cascades upstream features to DONE", async () => {
      setupRepoMock();

      const PLAN_ID = "plan-uuid-cascade";
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-cascade",
          checksStatus: "PASSING",
          organizationId: ORG_ID,
          workstreamId: WORKSTREAM_ID,
          linkedDoc: { id: PLAN_ID, slug: "PLN-17" },
        })
      );
      mockTx.artifact.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      // First findMany: upstream documents of the PR artifact — returns the plan.
      // Second findMany: features upstream of the plan — returns two features.
      mockTx.artifactLink.findMany
        .mockResolvedValueOnce([{ sourceId: PLAN_ID }])
        .mockResolvedValueOnce([
          { sourceId: "feat-a" },
          { sourceId: "feat-b" },
        ]);
      mockTx.artifact.findMany.mockResolvedValueOnce([
        {
          id: PLAN_ID,
          subtype: "IMPLEMENTATION_PLAN",
          status: DocumentStatus.InProgress,
        },
      ]);
      mockTx.artifact.updateMany.mockResolvedValue({ count: 2 });

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
      } as any;

      await handlePullRequest(event);

      // Plan → EXECUTED
      expect(mockTx.artifact.update).toHaveBeenCalledWith({
        where: { id: PLAN_ID },
        data: { status: DocumentStatus.Executed },
      });
      // Feature cascade → DONE (with docWhere stamped type: DOCUMENT)
      expect(mockTx.artifact.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { in: ["feat-a", "feat-b"] },
            subtype: "FEATURE",
            status: {
              notIn: [DocumentStatus.Done, DocumentStatus.Obsolete],
            },
          }),
          data: { status: DocumentStatus.Done },
        })
      );
    });
  });
});
