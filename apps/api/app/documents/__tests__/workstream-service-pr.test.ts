/**
 * Unit tests for `getDocumentPullRequests` and the refactored
 * `getDocumentPullRequest` in `documentWorkstreamService`.
 *
 * Covers:
 *  - `getDocumentPullRequests` returns [] when `findTargetLinks` returns no links
 *  - `getDocumentPullRequests` returns a single-element array with
 *    `repoFullName` populated from `row.pullRequest.repository.fullName`
 *  - `getDocumentPullRequests` returns a correctly ordered array (primary-repo
 *    entry first) when multiple PR artifacts exist
 *  - `getDocumentPullRequest` (singular) returns a single PullRequestInfo with
 *    `repoFullName` populated via `_queryPrArtifacts` (post T-2.2 refactor)
 */

import { type Mock, vi } from "vitest";

vi.mock("@repo/database", () => {
  const mockWithDb = Object.assign(vi.fn(), { tx: vi.fn() });
  return {
    withDb: mockWithDb,
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      PULL_REQUEST: "PULL_REQUEST",
      DEPLOYMENT: "DEPLOYMENT",
    },
  };
});

vi.mock("@/app/artifact-links/service", () => ({
  artifactLinksService: {
    findSourceLinks: vi.fn(),
    findTargetLinks: vi.fn(),
    createLink: vi.fn(),
  },
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: { getLatest: vi.fn() },
}));

vi.mock("@/lib/artifact-adapters", () => ({
  pullRequestArtifactToInfo: vi.fn(),
  pullRequestWhere: (where: Record<string, unknown>) => where,
}));

import { withDb } from "@repo/database";
import { artifactLinksService } from "@/app/artifact-links/service";
import { documentWorkstreamService } from "@/app/documents/workstream-service";
import { pullRequestArtifactToInfo } from "@/lib/artifact-adapters";
import { buildPullRequestInfo } from "../../../__tests__/fixtures/pull-request-info";

const mockWithDb = withDb as unknown as Mock;
const mockFindTargetLinks = artifactLinksService.findTargetLinks as Mock;
const mockPrToInfo = pullRequestArtifactToInfo as Mock;

/** Build a minimal PR artifact row (PrArtifactRow shape). */
function makePrArtifactRow(overrides?: { id?: string; repoFullName?: string }) {
  const id = overrides?.id ?? "pr-art-1";
  const repoFullName = overrides?.repoFullName ?? "owner/repo";
  return {
    id,
    type: "PULL_REQUEST",
    pullRequest: {
      number: 1,
      repository: { fullName: repoFullName },
    },
  };
}

/**
 * Set up the two sequential `withDb` calls that `_queryPrArtifacts` makes:
 *   1. `artifact.findUnique` — returns the document artifact with targetRepo
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
            document: { targetRepo },
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

describe("documentWorkstreamService.getDocumentPullRequests", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns [] when findTargetLinks returns no links", async () => {
    mockWithDb.mockImplementationOnce((fn: (db: object) => unknown) =>
      fn({
        artifact: {
          findUnique: vi.fn().mockResolvedValue({
            type: "DOCUMENT",
            document: { targetRepo: null },
          }),
        },
      })
    );
    mockFindTargetLinks.mockResolvedValue([]);

    const result = await documentWorkstreamService.getDocumentPullRequests(
      "doc-1",
      "org-1"
    );

    expect(result).toEqual([]);
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
    mockPrToInfo.mockReturnValue(expectedInfo);

    const result = await documentWorkstreamService.getDocumentPullRequests(
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
      .mockReturnValueOnce(secondaryInfo)
      .mockReturnValueOnce(primaryInfo);

    const result = await documentWorkstreamService.getDocumentPullRequests(
      "doc-1",
      "org-1"
    );

    expect(result).toHaveLength(2);
    // Primary-repo entry must be sorted to position 0
    expect(result[0].repoFullName).toBe("owner/primary-repo");
    expect(result[1].repoFullName).toBe("owner/other-repo");
  });
});

describe("documentWorkstreamService.getDocumentPullRequest (singular, post T-2.2 refactor)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns a PullRequestInfo with repoFullName from row.pullRequest.repository.fullName via _queryPrArtifacts", async () => {
    const prRow = makePrArtifactRow({
      id: "pr-art-1",
      repoFullName: "owner/repo",
    });
    mockPrArtifactsDb("owner/repo", [prRow]);
    mockFindTargetLinks.mockResolvedValue([
      { id: "link-1", sourceId: "doc-1", targetId: "pr-art-1" },
    ]);
    const expectedInfo = buildPullRequestInfo({ repoFullName: "owner/repo" });
    mockPrToInfo.mockReturnValue(expectedInfo);

    const result = await documentWorkstreamService.getDocumentPullRequest(
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
});
