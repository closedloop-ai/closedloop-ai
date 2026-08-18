/**
 * Injection-path inclusion tests for FEA-4096: when an artifact is serialized
 * into the loop context pack, its comment threads are rolled up into the
 * artifact `content` (the "## Discussion & Decisions" appendix), not dropped.
 *
 * These drive the real `buildContextPackInMemory` path and assert on the built
 * pack's artifact content — that it CONTAINS the rolled-up discussion — rather
 * than that the rollup function was called. Empty-threads produces no appendix.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PRD: "PRD",
    FEATURE: "FEATURE",
    BRANCH: "BRANCH",
    TEMPLATE: "TEMPLATE",
  },
  withDb: Object.assign(vi.fn(), {
    tx: vi.fn((fn: () => Promise<unknown>) => fn()),
  }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    getLatest: vi.fn(),
    getByVersion: vi.fn(),
  },
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    findByIdSimple: vi.fn(),
  },
}));

vi.mock("@/app/documents/document-pull-request-service", () => ({
  documentPullRequestService: {
    getDocumentPullRequest: vi.fn(),
  },
}));

vi.mock("@/app/templates/service", () => ({
  documentTemplatesService: {
    findOrgTemplate: vi.fn(),
    ensureDefaultTemplates: vi.fn(),
  },
}));

vi.mock("@/app/documents/attachments-service", () => ({
  attachmentsService: {
    listWithSignedUrlsByDocument: vi.fn().mockResolvedValue([]),
  },
  ATTACHMENT_SIGNED_URL_MAX_FILES: 20,
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    findById: vi.fn(),
  },
}));

vi.mock("@/app/catalog/service", () => ({
  listAgentsForContextPack: vi
    .fn()
    .mockResolvedValue({ agents: [], repoConfigs: [] }),
}));

vi.mock("@/app/comments/service", () => ({
  commentsService: {
    findThreadsByDocument: vi.fn(),
  },
}));

vi.mock("@/lib/loops/loop-commands", () => ({
  getCommandHandler: vi.fn(),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadMetadata: vi.fn(),
  uploadContextPack: vi.fn(),
}));

// --- Imports (after mocks) ---

import type { CommentThreadWithComments } from "@repo/api/src/types/comment";
import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { DocumentType } from "@repo/api/src/types/document";
import { LoopCommand } from "@repo/api/src/types/loop";
import type { BasicUser } from "@repo/api/src/types/user";
import { commentsService } from "@/app/comments/service";
import { documentService } from "@/app/documents/document-service";
import { documentVersionService } from "@/app/documents/document-version-service";
import { loopsService } from "@/app/loops/service";
import { getCommandHandler } from "@/lib/loops/loop-commands";
import { buildContextPackInMemory } from "@/lib/loops/loop-context-pack";

type MockFn = ReturnType<typeof vi.fn>;
const mockFindByIdSimple = documentService.findByIdSimple as MockFn;
const mockGetLatest = documentVersionService.getLatest as MockFn;
const mockGetCommandHandler = getCommandHandler as MockFn;
const mockFindThreadsByDocument =
  commentsService.findThreadsByDocument as MockFn;
const mockLoopsFindById = loopsService.findById as MockFn;

const reviewer: BasicUser = {
  id: "u-reviewer",
  email: "reviewer@example.com",
  firstName: "Rhea",
  lastName: "Viewer",
  avatarUrl: null,
};

function resolvedDecisionThread(): CommentThreadWithComments {
  return {
    id: "thread-1",
    organizationId: "org-1",
    source: ThreadSource.Liveblocks,
    externalId: "ext-1",
    roomId: "room-1",
    artifactId: "feat-1",
    status: ThreadStatus.Resolved,
    metadata: null,
    createdAtVersion: 2,
    resolvedAt: new Date("2026-02-01T00:00:00Z"),
    resolvedById: reviewer.id,
    createdById: reviewer.id,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-02-01T00:00:00Z"),
    resolvedBy: reviewer,
    createdBy: null,
    comments: [
      {
        id: "c-1",
        threadId: "thread-1",
        authorId: reviewer.id,
        body: {},
        plainText: "Ship the batch endpoint, not the per-item loop.",
        externalId: null,
        editedAt: null,
        deletedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        author: reviewer,
        reactions: [],
        attachments: [],
      },
    ],
  };
}

function includePrimaryLoop() {
  mockGetCommandHandler.mockReturnValue({
    requiresRepo: true,
    requiresParent: false,
    includePrimaryArtifact: true,
  });
  return {
    id: "loop-1",
    userId: "user-1",
    command: LoopCommand.Execute,
    prompt: "Implement it",
    documentId: "feat-1",
    documentVersion: null,
    parentLoopId: null,
    repo: null,
    contextRefs: null,
  };
}

describe("context pack — artifact comment rollup (FEA-4096)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("folds the resolved-decision thread into the primary artifact content", async () => {
    mockFindByIdSimple.mockResolvedValue({
      id: "feat-1",
      type: DocumentType.Feature,
      title: "Retry queue",
    });
    mockGetLatest.mockResolvedValue({ content: "# Retry queue\n\nBody here." });
    mockFindThreadsByDocument.mockResolvedValue([resolvedDecisionThread()]);

    const pack = await buildContextPackInMemory(includePrimaryLoop(), "org-1");

    // Org-scoped, artifact-scoped fetch (permission follows the artifact):
    // service signature is findThreadsByDocument(organizationId, entityId).
    expect(mockFindThreadsByDocument).toHaveBeenCalledWith("org-1", "feat-1");

    const primary = pack.artifacts.find((a) => a.id === "feat-1");
    expect(primary).toBeDefined();
    // The built content CONTAINS the rolled-up discussion, not just the body.
    expect(primary?.content).toContain("# Retry queue");
    expect(primary?.content).toContain("## Discussion & Decisions");
    expect(primary?.content).toContain("Resolved decision");
    expect(primary?.content).toContain(
      "Ship the batch endpoint, not the per-item loop."
    );
    expect(primary?.content).toContain("Resolved by: Rhea Viewer");
  });

  it("adds no discussion appendix when the artifact has no threads", async () => {
    mockFindByIdSimple.mockResolvedValue({
      id: "feat-1",
      type: DocumentType.Feature,
      title: "Retry queue",
    });
    mockGetLatest.mockResolvedValue({ content: "# Retry queue\n\nBody here." });
    mockFindThreadsByDocument.mockResolvedValue([]);

    const pack = await buildContextPackInMemory(includePrimaryLoop(), "org-1");

    const primary = pack.artifacts.find((a) => a.id === "feat-1");
    expect(primary?.content).toContain("# Retry queue");
    expect(primary?.content).not.toContain("## Discussion & Decisions");
  });

  it("folds threads of a context-ref artifact into its content too", async () => {
    // No primary artifact for this command; the PRD comes via contextRefs.
    mockGetCommandHandler.mockReturnValue({
      requiresRepo: true,
      requiresParent: false,
      includePrimaryArtifact: false,
    });
    mockFindByIdSimple.mockResolvedValue({
      id: "prd-1",
      type: DocumentType.Prd,
      title: "Search PRD",
    });
    mockGetLatest.mockResolvedValue({ content: "# Search PRD\n\nGoals." });
    mockFindThreadsByDocument.mockResolvedValue([resolvedDecisionThread()]);

    const loop = {
      id: "loop-1",
      userId: "user-1",
      command: LoopCommand.Plan,
      prompt: null,
      documentId: "plan-1",
      documentVersion: null,
      parentLoopId: null,
      repo: null,
      contextRefs: [{ sourceId: "prd-1", include: "full" as const }],
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(mockFindThreadsByDocument).toHaveBeenCalledWith("org-1", "prd-1");
    const ref = pack.artifacts.find((a) => a.id === "prd-1");
    expect(ref?.content).toContain("## Discussion & Decisions");
    expect(ref?.content).toContain(
      "Ship the batch endpoint, not the per-item loop."
    );
  });

  it("wraps the discussion in its own untrusted boundary for a non-PRD/Feature artifact", async () => {
    // Implementation-plan body is not wrapped by shouldWrapLoopArtifactContent,
    // so the rollup must carry its own untrusted boundary (wongk review).
    mockFindByIdSimple.mockResolvedValue({
      id: "feat-1",
      type: DocumentType.ImplementationPlan,
      title: "Retry plan",
    });
    mockGetLatest.mockResolvedValue({ content: "# Retry plan\n\nSteps." });
    mockFindThreadsByDocument.mockResolvedValue([resolvedDecisionThread()]);
    // No parent loop → no raw plan attached, so the rollup is appended.
    mockLoopsFindById.mockResolvedValue(null);

    const pack = await buildContextPackInMemory(includePrimaryLoop(), "org-1");

    const primary = pack.artifacts.find((a) => a.id === "feat-1");
    expect(primary?.content).toContain("# Retry plan");
    expect(primary?.content).toContain("BEGIN UNTRUSTED DISCUSSION");
    expect(primary?.content).toContain("END UNTRUSTED DISCUSSION");
    expect(primary?.content).toContain("## Discussion & Decisions");
    expect(primary?.content).toContain(
      "Ship the batch endpoint, not the per-item loop."
    );
  });

  it("drops the rollup from primary content when a Desktop EXECUTE raw plan is attached", async () => {
    // Implementation plan under Desktop EXECUTE with a parent that carries an
    // uploaded raw plan. Appending the rollup would desync raw.content ===
    // content and break Desktop's structured-plan restoration (codex + wongk).
    const planBody = "# Retry plan\n\nSteps.";
    mockFindByIdSimple.mockResolvedValue({
      id: "feat-1",
      type: DocumentType.ImplementationPlan,
      title: "Retry plan",
    });
    mockGetLatest.mockResolvedValue({ content: planBody });
    mockFindThreadsByDocument.mockResolvedValue([resolvedDecisionThread()]);
    mockLoopsFindById.mockResolvedValue({
      id: "parent-1",
      command: LoopCommand.Execute,
      status: "COMPLETED",
      computeTargetId: "ct-1",
      uploadedArtifacts: { plan: { raw: { content: planBody } } },
      s3StateKey: null,
    });

    const loop = {
      ...includePrimaryLoop(),
      command: LoopCommand.Execute,
      parentLoopId: "parent-1",
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    const primary = pack.artifacts.find((a) => a.id === "feat-1");
    // Content stays byte-aligned with the raw plan: no discussion appended.
    expect(primary?.content).toBe(planBody);
    expect(primary?.content).not.toContain("## Discussion & Decisions");
    // The raw plan is still attached and matches content byte-for-byte.
    const raw = primary?.raw as { content?: string } | undefined;
    expect(raw?.content).toBe(primary?.content);
  });
});
