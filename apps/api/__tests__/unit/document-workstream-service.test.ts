/**
 * Unit tests for `documentWorkstreamService`.
 *
 * Covers:
 *  - `findSourceWithContent` — resolves source PRD/Feature via artifact
 *    links, prefers PRD over Feature when both exist.
 *  - `findOrCreateWorkstream` — the multi-branch resolution:
 *      • Document already has a workstream → return as-is + source.
 *      • No projectId → return null/null.
 *      • Source exists with workstreamId → attach document to that
 *        workstream.
 *      • Source exists without workstreamId → auto-create a workstream and
 *        attach both.
 *      • Title fallback — when no source link, look up by stripped title.
 *  - `getDocumentPullRequest` — most recent PR that the document directly
 *    PRODUCES via an artifact link; null when no such link exists.
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

import { LinkType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { artifactLinksService } from "@/app/artifact-links/service";
import type { DocumentWithRegenerationContext } from "@/app/documents/document-utils";
import { documentVersionService } from "@/app/documents/document-version-service";
import { documentWorkstreamService } from "@/app/documents/workstream-service";
import { pullRequestArtifactToInfo } from "@/lib/artifact-adapters";

const mockWithDb = withDb as unknown as Mock;
const mockWithDbTx = (withDb as unknown as { tx: Mock }).tx;
const mockFindSourceLinks = artifactLinksService.findSourceLinks as Mock;
const mockFindTargetLinks = artifactLinksService.findTargetLinks as Mock;
const mockCreateLink = artifactLinksService.createLink as Mock;
const mockGetLatest = documentVersionService.getLatest as Mock;
const mockPrToInfo = pullRequestArtifactToInfo as Mock;

function mockDb(db: Record<string, unknown>) {
  mockWithDb.mockImplementation(
    async (fn: (db: Record<string, unknown>) => unknown) => fn(db)
  );
}

function mockTx(tx: Record<string, unknown>) {
  mockWithDbTx.mockImplementation(
    async (fn: (tx: Record<string, unknown>) => unknown) => fn(tx)
  );
}

const PRD_ARTIFACT = {
  id: "prd-1",
  organizationId: "org-1",
  type: "DOCUMENT",
  subtype: "PRD",
  name: "My PRD",
  slug: "prd-my",
  status: "APPROVED",
  createdById: "user-1",
  assigneeId: null,
  projectId: "proj-1",
  workstreamId: "ws-prd",
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  assignee: null,
  document: {
    latestVersion: 3,
    fileName: null,
    approverId: null,
    approver: null,
    targetRepo: "owner/repo",
    targetBranch: "main",
  },
};

// Test fixture builder. The real `DocumentWithRegenerationContext` shape has
// many fields that the service doesn't read in these tests, so we cast through
// `unknown`. Overrides accept any partial shape (including null projectId,
// which simulates the orphan-document branch even though the production type
// requires a string).
function makePlanArtifact(
  overrides?: Record<string, unknown>
): NonNullable<DocumentWithRegenerationContext> {
  return {
    id: "plan-1",
    organizationId: "org-1",
    type: "IMPLEMENTATION_PLAN",
    title: "Plan: Build feature",
    slug: "plan-1",
    status: "DRAFT",
    projectId: "proj-1",
    workstreamId: null,
    targetRepo: null,
    targetBranch: null,
    workstream: null,
    ...overrides,
  } as unknown as NonNullable<DocumentWithRegenerationContext>;
}

describe("documentWorkstreamService.findSourceWithContent", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns null when there are no source links", async () => {
    mockFindSourceLinks.mockResolvedValue([]);
    const result = await documentWorkstreamService.findSourceWithContent(
      makePlanArtifact()
    );
    expect(result).toBeNull();
  });

  it("returns null when source links exist but none point to a DOCUMENT PRD/Feature", async () => {
    mockFindSourceLinks.mockResolvedValue([{ sourceId: "art-x" }]);
    mockDb({ artifact: { findMany: vi.fn().mockResolvedValue([]) } });

    const result = await documentWorkstreamService.findSourceWithContent(
      makePlanArtifact()
    );
    expect(result).toBeNull();
  });

  it("prefers a PRD source over a Feature source when both are linked", async () => {
    mockFindSourceLinks.mockResolvedValue([
      { sourceId: "feat-1" },
      { sourceId: "prd-1" },
    ]);
    mockDb({
      artifact: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { ...PRD_ARTIFACT, id: "feat-1", subtype: "FEATURE" },
            PRD_ARTIFACT,
          ]),
      },
    });
    mockGetLatest.mockResolvedValue({ content: "PRD body" });

    const result = await documentWorkstreamService.findSourceWithContent(
      makePlanArtifact()
    );
    expect(result?.id).toBe("prd-1");
    expect(result?.content).toBe("PRD body");
    expect(result?.targetRepo).toBe("owner/repo");
  });
});

describe("documentWorkstreamService.findOrCreateWorkstream", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the existing workstream when the document already has one", async () => {
    const artifact = makePlanArtifact({
      workstreamId: "ws-existing",
      workstream: {
        id: "ws-existing",
        title: "Existing",
        state: "OPEN",
      },
    });
    mockFindSourceLinks.mockResolvedValue([]);

    const result = await documentWorkstreamService.findOrCreateWorkstream(
      "org-1",
      artifact,
      "user-1"
    );
    expect(result.workstream).toEqual(artifact.workstream);
  });

  it("returns null/null when the document has no projectId and no workstream", async () => {
    const artifact = makePlanArtifact({
      projectId: null,
      workstream: null,
    });
    mockFindSourceLinks.mockResolvedValue([]);

    const result = await documentWorkstreamService.findOrCreateWorkstream(
      "org-1",
      artifact,
      "user-1"
    );
    expect(result).toEqual({ workstream: null, source: null });
  });

  it("attaches the document to the source PRD's workstream when source has one", async () => {
    const artifact = makePlanArtifact();
    mockFindSourceLinks.mockResolvedValue([{ sourceId: "prd-1" }]);
    mockDb({
      artifact: { findMany: vi.fn().mockResolvedValue([PRD_ARTIFACT]) },
    });
    mockGetLatest.mockResolvedValue({ content: "PRD body" });

    const txArtifactUpdate = vi.fn();
    const txWorkstreamFindUnique = vi.fn().mockResolvedValue({
      id: "ws-prd",
      title: "PRD ws",
      state: "OPEN",
      project: null,
      artifacts: [],
    });
    mockTx({
      artifact: { update: txArtifactUpdate },
      workstream: { findUnique: txWorkstreamFindUnique },
    });

    const result = await documentWorkstreamService.findOrCreateWorkstream(
      "org-1",
      artifact,
      "user-1"
    );

    expect(txArtifactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "plan-1", organizationId: "org-1" },
        data: { workstreamId: "ws-prd" },
      })
    );
    expect(result.workstream?.id).toBe("ws-prd");
    expect(result.source?.id).toBe("prd-1");
  });

  it("auto-creates a workstream when the source has no workstreamId, attaching both", async () => {
    const artifact = makePlanArtifact();
    const sourcePrd = {
      ...PRD_ARTIFACT,
      workstreamId: null,
      document: { ...PRD_ARTIFACT.document, targetRepo: "owner/repo" },
    };
    mockFindSourceLinks.mockResolvedValue([{ sourceId: "prd-1" }]);
    mockDb({
      artifact: { findMany: vi.fn().mockResolvedValue([sourcePrd]) },
    });
    mockGetLatest.mockResolvedValue({ content: "PRD body" });

    const txWorkstreamCreate = vi.fn().mockResolvedValue({ id: "ws-new" });
    const txArtifactUpdateMany = vi.fn();
    const txWorkstreamFindUnique = vi.fn().mockResolvedValue({
      id: "ws-new",
      title: "New ws",
      state: "OPEN",
      project: null,
      artifacts: [],
    });
    mockTx({
      workstream: {
        create: txWorkstreamCreate,
        findUnique: txWorkstreamFindUnique,
      },
      artifact: { updateMany: txArtifactUpdateMany },
    });

    const result = await documentWorkstreamService.findOrCreateWorkstream(
      "org-1",
      artifact,
      "user-1"
    );

    expect(txWorkstreamCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          projectId: "proj-1",
          createdById: "user-1",
          type: "FEATURE_DELIVERY",
        }),
      })
    );
    expect(txArtifactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["prd-1", "plan-1"] },
        }),
        data: { workstreamId: "ws-new" },
      })
    );
    expect(result.workstream?.id).toBe("ws-new");
  });

  it("falls back to title-based lookup when no source link exists, then creates a PRODUCES link", async () => {
    const artifact = makePlanArtifact({ title: "Plan: my feature" });
    // No source links found.
    mockFindSourceLinks.mockResolvedValue([]);

    // Sequence of withDb calls inside findOrCreateWorkstream:
    //   1. findSourceWithContent → no links, never reaches db
    //   2. findFirst (title fallback) → matched PRD
    mockDb({
      artifact: {
        findFirst: vi.fn().mockResolvedValue({
          ...PRD_ARTIFACT,
          name: "my feature",
          workstreamId: "ws-prd",
        }),
      },
    });
    mockGetLatest.mockResolvedValue({ content: "fallback PRD body" });

    const txArtifactUpdate = vi.fn();
    const txWorkstreamFindUnique = vi.fn().mockResolvedValue({
      id: "ws-prd",
      title: "PRD ws",
      state: "OPEN",
      project: null,
      artifacts: [],
    });
    mockTx({
      artifact: { update: txArtifactUpdate },
      workstream: { findUnique: txWorkstreamFindUnique },
    });

    const result = await documentWorkstreamService.findOrCreateWorkstream(
      "org-1",
      artifact,
      "user-1"
    );

    // Title-based PRODUCES link is created so subsequent calls use the link path.
    expect(mockCreateLink).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        sourceId: "prd-1",
        targetId: "plan-1",
        linkType: expect.any(String),
      })
    );
    expect(result.workstream?.id).toBe("ws-prd");
  });

  it("returns workstream:null when no source can be resolved (no links + no title match)", async () => {
    const artifact = makePlanArtifact({ title: "Plan: orphan" });
    mockFindSourceLinks.mockResolvedValue([]);
    mockDb({ artifact: { findFirst: vi.fn().mockResolvedValue(null) } });

    const result = await documentWorkstreamService.findOrCreateWorkstream(
      "org-1",
      artifact,
      "user-1"
    );
    expect(result.workstream).toBeNull();
    expect(result.source).toBeNull();
  });
});

describe("documentWorkstreamService.getDocumentPullRequest", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns null when the document is not a DOCUMENT artifact", async () => {
    mockDb({
      artifact: {
        findUnique: vi.fn().mockResolvedValue({ type: "PULL_REQUEST" }),
      },
    });

    const result = await documentWorkstreamService.getDocumentPullRequest(
      "doc-1",
      "org-1"
    );
    expect(result).toBeNull();
    expect(mockFindTargetLinks).not.toHaveBeenCalled();
  });

  it("returns null when the document does not produce any artifacts", async () => {
    mockDb({
      artifact: {
        findUnique: vi.fn().mockResolvedValue({ type: "DOCUMENT" }),
      },
    });
    mockFindTargetLinks.mockResolvedValue([]);

    const result = await documentWorkstreamService.getDocumentPullRequest(
      "doc-1",
      "org-1"
    );
    expect(result).toBeNull();
    expect(mockFindTargetLinks).toHaveBeenCalledWith(
      "org-1",
      "doc-1",
      LinkType.Produces
    );
  });

  it("returns the most recent PR among the document's PRODUCES links", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "pr-art-1",
        type: "PULL_REQUEST",
        pullRequest: { number: 42, repository: { fullName: "owner/repo" } },
      },
    ]);
    mockWithDb
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          artifact: {
            findUnique: vi.fn().mockResolvedValue({
              type: "DOCUMENT",
              document: { targetRepo: null },
            }),
          },
        })
      )
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({ artifact: { findMany } })
      );
    mockFindTargetLinks.mockResolvedValue([
      { id: "link-1", sourceId: "doc-1", targetId: "pr-art-1" },
      { id: "link-2", sourceId: "doc-1", targetId: "other-art-1" },
    ]);
    mockPrToInfo.mockReturnValue({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
    });

    const result = await documentWorkstreamService.getDocumentPullRequest(
      "doc-1",
      "org-1"
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          id: { in: ["pr-art-1", "other-art-1"] },
        }),
        orderBy: { createdAt: "desc" },
      })
    );
    expect(result?.number).toBe(42);
    expect(mockPrToInfo).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pr-art-1" }),
      { externalLinkId: "pr-art-1" }
    );
  });

  it("returns null when produced artifacts contain no PR", async () => {
    mockWithDb
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          artifact: {
            findUnique: vi.fn().mockResolvedValue({
              type: "DOCUMENT",
              document: { targetRepo: null },
            }),
          },
        })
      )
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({ artifact: { findMany: vi.fn().mockResolvedValue([]) } })
      );
    mockFindTargetLinks.mockResolvedValue([
      { id: "link-1", sourceId: "doc-1", targetId: "deploy-art-1" },
    ]);

    const result = await documentWorkstreamService.getDocumentPullRequest(
      "doc-1",
      "org-1"
    );
    expect(result).toBeNull();
  });
});
