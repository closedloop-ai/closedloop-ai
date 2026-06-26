/**
 * Unit tests for `documentPullRequestService`.
 *
 * Covers:
 *  - `getDocumentPullRequests` returns [] when `findTargetLinks` returns no links
 *  - `getDocumentPullRequests` returns a single-element array with
 *    `repoFullName` populated from `row.pullRequest.repository.fullName`
 *  - `getDocumentPullRequests` returns a correctly ordered array (primary-repo
 *    entry first) when multiple PR artifacts exist
 *  - `getDocumentPullRequest` (singular) returns a single PullRequestInfo with
 *    `repoFullName` populated via the PR artifact query helper
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => {
  const mockWithDb = Object.assign(vi.fn(), { tx: vi.fn() });
  return {
    withDb: mockWithDb,
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      BRANCH: "BRANCH",
      DEPLOYMENT: "DEPLOYMENT",
    },
  };
});

vi.mock("@/app/artifact-links/service", () => ({
  artifactLinksService: {
    findTargetLinks: vi.fn(),
  },
}));

vi.mock("@/lib/artifact-adapters", () => ({
  branchArtifactToInfo: vi.fn(() => null),
}));

import { LinkType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { artifactLinksService } from "@/app/artifact-links/service";
import { documentPullRequestService } from "@/app/documents/document-pull-request-service";
import { branchArtifactToInfo } from "@/lib/artifact-adapters";
import { buildPullRequestInfo } from "../../../__tests__/fixtures/pull-request-info";

const mockWithDb = withDb as unknown as Mock;
const mockFindTargetLinks = artifactLinksService.findTargetLinks as Mock;
const mockPrToInfo = branchArtifactToInfo as Mock;

function buildBranchInfoForPr(info: ReturnType<typeof buildPullRequestInfo>) {
  return {
    id: info.externalLinkId ?? info.id,
    name: info.headBranch,
    htmlUrl: null,
    branchName: info.headBranch,
    baseBranch: info.baseBranch,
    headSha: null,
    checksStatus: info.checksStatus,
    externalLinkId: info.externalLinkId,
    repoFullName: info.repoFullName,
    currentPullRequest: info,
  };
}

/** Build a minimal branch artifact row. */
function makePrArtifactRow(overrides?: { id?: string; repoFullName?: string }) {
  const id = overrides?.id ?? "pr-art-1";
  const repoFullName = overrides?.repoFullName ?? "owner/repo";
  return {
    id,
    type: "BRANCH",
    branch: {
      branchName: "feature/test",
      repository: { fullName: repoFullName },
      currentPullRequestDetail: {
        number: 1,
        repository: { fullName: repoFullName },
      },
    },
  };
}

/**
 * Build a `repository_snapshot` JSON payload for a single primary repo, or an
 * empty `source: 'none'` snapshot when null. Matches the shape produced by
 * `buildSnapshotFromProjectDefaults` in apps/api/app/documents/
 * repository-snapshot-helpers.ts.
 */
function snapshotFor(targetRepo: string | null) {
  if (!targetRepo) {
    return { repositories: [], source: "none" };
  }
  return {
    repositories: [{ fullName: targetRepo, role: "primary", position: 0 }],
    source: "project_defaults",
  };
}

/**
 * Set up the two sequential `withDb` calls that the PR artifact query helper makes:
 *   1. `artifact.findUnique` — returns the document artifact with its
 *      `repository_snapshot` (parsed for primary-repo ordering)
 *   2. `artifact.findMany`  — returns the PR artifact rows
 */
function mockPrArtifactsDb(
  targetRepo: string | null,
  prRows: ReturnType<typeof makePrArtifactRow>[]
) {
  mockWithDb
    .mockImplementationOnce((fn: (db: object) => unknown) =>
      fn({
        artifact: {
          findUnique: vi.fn().mockResolvedValue({
            type: "DOCUMENT",
            document: { repositorySnapshot: snapshotFor(targetRepo) },
          }),
        },
      })
    )
    .mockImplementationOnce((fn: (db: object) => unknown) =>
      fn({
        artifact: {
          findMany: vi.fn().mockResolvedValue(prRows),
        },
      })
    );
}

describe("documentPullRequestService.getDocumentPullRequests", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns [] when the artifact is not a document", async () => {
    mockWithDb.mockImplementationOnce((fn: (db: object) => unknown) =>
      fn({
        artifact: {
          findUnique: vi.fn().mockResolvedValue({ type: "BRANCH" }),
        },
      })
    );

    const result = await documentPullRequestService.getDocumentPullRequests(
      "doc-1",
      "org-1"
    );

    expect(result).toEqual([]);
    expect(mockFindTargetLinks).not.toHaveBeenCalled();
  });

  it("returns [] when findTargetLinks returns no links", async () => {
    mockWithDb.mockImplementationOnce((fn: (db: object) => unknown) =>
      fn({
        artifact: {
          findUnique: vi.fn().mockResolvedValue({
            type: "DOCUMENT",
            document: { repositorySnapshot: snapshotFor(null) },
          }),
        },
      })
    );
    mockFindTargetLinks.mockResolvedValue([]);

    const result = await documentPullRequestService.getDocumentPullRequests(
      "doc-1",
      "org-1"
    );

    expect(result).toEqual([]);
    expect(mockFindTargetLinks).toHaveBeenCalledWith(
      "org-1",
      "doc-1",
      LinkType.Produces
    );
  });

  it("returns a single-element array with repoFullName from row.pullRequest.repository.fullName", async () => {
    const prRow = makePrArtifactRow({
      id: "pr-art-1",
      repoFullName: "owner/repo",
    });
    mockPrArtifactsDb("owner/repo", [prRow]);
    mockFindTargetLinks.mockResolvedValue([
      { id: "link-1", sourceId: "doc-1", targetId: "pr-art-1" },
    ]);
    const expectedInfo = buildPullRequestInfo({ repoFullName: "owner/repo" });
    mockPrToInfo.mockReturnValue(buildBranchInfoForPr(expectedInfo));

    const result = await documentPullRequestService.getDocumentPullRequests(
      "doc-1",
      "org-1"
    );

    expect(result).toHaveLength(1);
    expect(result[0].repoFullName).toBe("owner/repo");
    expect(mockPrToInfo).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pr-art-1" }),
      expect.objectContaining({ externalLinkId: "pr-art-1" })
    );
  });

  it("returns primary-repo entry first when multiple PR artifacts exist", async () => {
    const primaryRow = makePrArtifactRow({
      id: "pr-art-primary",
      repoFullName: "owner/primary-repo",
    });
    const secondaryRow = makePrArtifactRow({
      id: "pr-art-secondary",
      repoFullName: "owner/other-repo",
    });
    // `findMany` returns secondary before primary (as if by createdAt desc order)
    mockPrArtifactsDb("owner/primary-repo", [secondaryRow, primaryRow]);
    mockFindTargetLinks.mockResolvedValue([
      { id: "link-1", sourceId: "doc-1", targetId: "pr-art-secondary" },
      { id: "link-2", sourceId: "doc-1", targetId: "pr-art-primary" },
    ]);

    const primaryInfo = buildPullRequestInfo({
      id: "pr-art-primary",
      repoFullName: "owner/primary-repo",
      externalLinkId: "pr-art-primary",
    });
    const secondaryInfo = buildPullRequestInfo({
      id: "pr-art-secondary",
      repoFullName: "owner/other-repo",
      externalLinkId: "pr-art-secondary",
    });

    mockPrToInfo
      .mockReturnValueOnce(buildBranchInfoForPr(secondaryInfo))
      .mockReturnValueOnce(buildBranchInfoForPr(primaryInfo));

    const result = await documentPullRequestService.getDocumentPullRequests(
      "doc-1",
      "org-1"
    );

    expect(result).toHaveLength(2);
    // Primary-repo entry must be sorted to position 0
    expect(result[0].repoFullName).toBe("owner/primary-repo");
    expect(result[1].repoFullName).toBe("owner/other-repo");
  });

  it("returns [] when produced artifacts contain no PR", async () => {
    mockPrArtifactsDb(null, []);
    mockFindTargetLinks.mockResolvedValue([
      { id: "link-1", sourceId: "doc-1", targetId: "deploy-art-1" },
    ]);

    const result = await documentPullRequestService.getDocumentPullRequests(
      "doc-1",
      "org-1"
    );

    expect(result).toEqual([]);
  });
});

describe("documentPullRequestService.getDocumentPullRequest", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns a PullRequestInfo with repoFullName from row.pullRequest.repository.fullName", async () => {
    const prRow = makePrArtifactRow({
      id: "pr-art-1",
      repoFullName: "owner/repo",
    });
    mockPrArtifactsDb("owner/repo", [prRow]);
    mockFindTargetLinks.mockResolvedValue([
      { id: "link-1", sourceId: "doc-1", targetId: "pr-art-1" },
    ]);
    const expectedInfo = buildPullRequestInfo({ repoFullName: "owner/repo" });
    mockPrToInfo.mockReturnValue(buildBranchInfoForPr(expectedInfo));

    const result = await documentPullRequestService.getDocumentPullRequest(
      "doc-1",
      "org-1"
    );

    expect(result).not.toBeNull();
    expect(result?.repoFullName).toBe("owner/repo");
    expect(mockPrToInfo).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pr-art-1" }),
      expect.objectContaining({ externalLinkId: "pr-art-1" })
    );
  });

  it("returns the PR for the requested repo instead of the newest linked PR", async () => {
    const newerSecondaryRow = makePrArtifactRow({
      id: "pr-art-secondary",
      repoFullName: "owner/secondary",
    });
    const olderPrimaryRow = makePrArtifactRow({
      id: "pr-art-primary",
      repoFullName: "owner/primary",
    });
    mockPrArtifactsDb("owner/primary", [newerSecondaryRow, olderPrimaryRow]);
    mockFindTargetLinks.mockResolvedValue([
      { id: "link-1", sourceId: "doc-1", targetId: "pr-art-secondary" },
      { id: "link-2", sourceId: "doc-1", targetId: "pr-art-primary" },
    ]);
    const secondaryInfo = buildPullRequestInfo({
      id: "pr-art-secondary",
      repoFullName: "owner/secondary",
      externalLinkId: "pr-art-secondary",
    });
    const primaryInfo = buildPullRequestInfo({
      id: "pr-art-primary",
      repoFullName: "owner/primary",
      externalLinkId: "pr-art-primary",
    });
    mockPrToInfo
      .mockReturnValueOnce(buildBranchInfoForPr(secondaryInfo))
      .mockReturnValueOnce(buildBranchInfoForPr(primaryInfo));

    const result = await documentPullRequestService.getDocumentPullRequest(
      "doc-1",
      "org-1",
      "owner/primary"
    );

    expect(result?.repoFullName).toBe("owner/primary");
  });
});
