import {
  BranchDataState,
  BranchLinkedArtifactCollectionProvenance,
  BranchLinkedArtifactCollectionState,
  BranchLinkedArtifactEvidenceKind,
} from "@repo/api/src/types/branch";
import { BranchAssociatedPullRequestSelectionReason } from "@repo/api/src/types/branch-associated-pull-request";
import { DocumentType } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ArtifactType } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({ ChecksStatus: { UNKNOWN: "UNKNOWN" } });
});

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return { ...actual, getSinglePullRequestWithProviderResult: vi.fn() };
});

const syncServiceMocks = vi.hoisted(() => ({
  refreshTombstonedBranchPullRequest: vi.fn(),
}));

vi.mock("@/app/integrations/github/sync-service", () => ({
  GitHubServerSyncReason: {
    NoEligibleSessionReference: "no_eligible_session_reference",
  },
  GitHubServerSyncStatus: {
    Failed: "failed",
    NotApplicable: "not_applicable",
    Refreshed: "refreshed",
    Retryable: "retryable",
  },
  githubServerSyncService: syncServiceMocks,
}));

vi.mock("@/app/agent-sessions/service", () => ({
  agentSessionsService: { findSessionDetail: vi.fn() },
}));

import {
  branchId,
  createMockDb,
  makeBranchRow,
  makeCurrentPullRequestDetail,
  mockBranchCandidateIds,
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

describe("branchReadService associated PR selection", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
  });

  it("reports ambiguity when repository-qualified linked PRs are both active", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        pullRequestDetails: [
          makeCurrentPullRequestDetail({
            id: "foreign-pr-detail",
            repositoryId: "repo-2",
            number: 99,
          }),
          makeCurrentPullRequestDetail({ id: "owned-pr-detail", number: 17 }),
        ],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    expect(response.items[0]).toMatchObject({
      dataState: BranchDataState.NoSessions,
      prNumber: null,
      prTitle: null,
      prUrl: null,
      multiPrWarning: false,
    });
    const select = mockDb.artifact.findMany.mock.calls.at(-1)?.[0]?.select;
    expect(select?.pullRequestDetails?.where).toBeUndefined();
    expect(select?.pullRequestDetails?.take).toBeUndefined();
  });

  it("uses associated selection when analytics current pointers are historical", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    const historical = makeCurrentPullRequestDetail({
      number: 6,
      prState: GitHubPRState.Closed,
      closedAt: now,
      isCurrent: true,
    });
    const active = makeCurrentPullRequestDetail({
      id: "pr-detail-active",
      number: 7,
      isCurrent: false,
      prState: GitHubPRState.Open,
    });
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        currentPullRequestDetail: historical,
        pullRequestDetails: [historical, active],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 10, offset: 0 }
    );

    expect(response.activePrCount).toMatchObject({ value: 1 });
    expect(response.mergedCount).toMatchObject({ value: 0 });
  });

  it("loads body and reviews only for the PR chosen from summary history", async () => {
    const older = makeCurrentPullRequestDetail({
      id: "older-pr-detail",
      number: 6,
      prState: GitHubPRState.Closed,
      closedAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    const selected = makeCurrentPullRequestDetail({
      id: "selected-pr-detail",
      number: 7,
      prState: GitHubPRState.Closed,
      closedAt: new Date("2026-08-02T10:00:00.000Z"),
      body: "Selected body",
    });
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        currentPullRequestDetail: older,
        pullRequestDetails: [older, selected],
      })
    );
    mockDb.pullRequestDetail.findUnique.mockResolvedValue(selected);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    const artifactSelect = mockDb.artifact.findFirst.mock.calls[0]?.[0]?.select;
    expect(artifactSelect?.pullRequestDetails?.select?.body).toBeUndefined();
    expect(artifactSelect?.pullRequestDetails?.select?.reviews).toBeUndefined();
    expect(mockDb.pullRequestDetail.findUnique).toHaveBeenCalledOnce();
    expect(mockDb.pullRequestDetail.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id_branchArtifactId: {
            id: "selected-pr-detail",
            branchArtifactId: branchId,
          },
        },
      })
    );
    expect(detail).toMatchObject({
      prNumber: 7,
      prBody: "Selected body",
      associatedPullRequests: {
        selectedId: "closedloop-ai/symphony-alpha#7",
        items: [{ number: 6 }, { number: 7 }],
      },
    });
  });

  it("projects an explicitly selected historical PR and its persisted head", async () => {
    const historical = makeCurrentPullRequestDetail({
      id: "historical-pr-detail",
      number: 6,
      prState: GitHubPRState.Closed,
      closedAt: new Date("2026-08-01T10:00:00.000Z"),
      body: "Historical body",
      headRefOid: "a".repeat(40),
    });
    const active = makeCurrentPullRequestDetail({
      id: "active-pr-detail",
      number: 7,
      prState: GitHubPRState.Open,
      headRefOid: "b".repeat(40),
    });
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        headSha: "c".repeat(40),
        pullRequestDetails: [historical, active],
      })
    );
    mockDb.pullRequestDetail.findUnique.mockResolvedValue(historical);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId,
      undefined,
      {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        pullRequestNumber: 6,
      }
    );

    expect(detail).toMatchObject({
      prNumber: 6,
      prBody: "Historical body",
      headSha: "a".repeat(40),
      branchHeadSha: "c".repeat(40),
      associatedPullRequests: {
        selectedId: "closedloop-ai/symphony-alpha#6",
        selectionReason: BranchAssociatedPullRequestSelectionReason.Explicit,
      },
      selectedPullRequest: {
        number: 6,
        headRefOid: "a".repeat(40),
      },
    });
  });

  it("adds only permission-filtered persisted Document PRODUCES Branch evidence", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        branchName: "fea-3457-fix",
        targetLinks: [
          {
            id: "link-1",
            createdAt: now,
            source: {
              id: "document-1",
              type: ArtifactType.DOCUMENT,
              subtype: DocumentType.Feature,
              name: "Fix branch details",
              slug: "FEA-3457",
              externalUrl: null,
            },
          },
          {
            id: "link-2",
            createdAt: now,
            source: {
              id: "document-2",
              type: ArtifactType.DOCUMENT,
              subtype: DocumentType.Prd,
              name: "Branch contract",
              slug: "PRD-600",
              externalUrl: null,
            },
          },
          {
            id: "link-invalid",
            createdAt: now,
            source: {
              id: "document-invalid",
              type: ArtifactType.DOCUMENT,
              subtype: null,
              name: "Unroutable document",
              slug: "DOC-1",
              externalUrl: null,
            },
          },
        ],
      })
    );

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.linkedArtifacts).toEqual([
      expect.objectContaining({
        artifactId: "document-1",
        slug: "FEA-3457",
        evidence: {
          kind: BranchLinkedArtifactEvidenceKind.DocumentProducesBranch,
          linkId: "link-1",
        },
      }),
      expect.objectContaining({
        artifactId: "document-2",
        slug: "PRD-600",
        href: "/prds/PRD-600",
      }),
    ]);
    expect(detail?.linkedArtifactsCollection).toEqual({
      state: BranchLinkedArtifactCollectionState.Incomplete,
      provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
    });
    expect(
      mockDb.artifact.findFirst.mock.calls[0]?.[0]?.select?.targetLinks?.where
    ).toMatchObject({
      organizationId,
      linkType: "PRODUCES",
      source: { organizationId, type: ArtifactType.DOCUMENT },
    });
  });
});
