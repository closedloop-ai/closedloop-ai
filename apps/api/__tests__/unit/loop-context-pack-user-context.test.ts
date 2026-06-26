/**
 * Unit tests for userContext behavior in buildContextPackInMemory().
 *
 * Verifies that PLAN commands populate userContext from ArtifactVersion v1,
 * non-PLAN commands do not, and edge cases (null/empty/oversized content)
 * are handled correctly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PRD: "PRD",
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
    findSlugById: vi.fn(),
  },
}));

vi.mock("@/app/documents/document-pull-request-service", () => ({
  documentPullRequestService: {
    getDocumentPullRequest: vi.fn(),
    getPullRequestHeadContext: vi.fn(),
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

vi.mock("@/lib/loops/loop-commands", () => ({
  getCommandHandler: vi.fn(),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadMetadata: vi.fn(),
  uploadContextPack: vi.fn(),
}));

// --- Imports (after mocks) ---

import { DocumentType } from "@repo/api/src/types/document";
import { LoopCommand } from "@repo/api/src/types/loop";
import { documentPullRequestService } from "@/app/documents/document-pull-request-service";
import { documentService } from "@/app/documents/document-service";
import { documentVersionService } from "@/app/documents/document-version-service";
import { loopsService } from "@/app/loops/service";
import { getCommandHandler } from "@/lib/loops/loop-commands";
import { buildContextPackInMemory } from "@/lib/loops/loop-context-pack";

type MockFn = ReturnType<typeof vi.fn>;
const mockGetByVersion = documentVersionService.getByVersion as MockFn;
const mockGetLatest = documentVersionService.getLatest as MockFn;
const mockFindByIdSimple = documentService.findByIdSimple as MockFn;
const mockFindSlugById = documentService.findSlugById as MockFn;
const mockFindLoopById = loopsService.findById as MockFn;
const mockGetDocumentPullRequest =
  documentPullRequestService.getDocumentPullRequest as MockFn;
const mockGetPullRequestHeadContext =
  documentPullRequestService.getPullRequestHeadContext as MockFn;
const mockGetCommandHandler = getCommandHandler as MockFn;
// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const BASE_LOOP = {
  id: "loop-1",
  userId: "user-1",
  prompt: null,
  parentLoopId: null,
  repo: null,
  contextRefs: null,
  documentVersion: null,
};

// ---------------------------------------------------------------------------
// userContext behavior
// ---------------------------------------------------------------------------

describe("buildContextPackInMemory — userContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no command handler (no primary artifact)
    mockGetCommandHandler.mockReturnValue(undefined);
    // Default: no primary artifact found
    mockGetLatest.mockResolvedValue(null);
    mockFindByIdSimple.mockResolvedValue(null);
    mockFindSlugById.mockResolvedValue(null);
    mockFindLoopById.mockResolvedValue(null);
    mockGetDocumentPullRequest.mockResolvedValue(null);
    mockGetPullRequestHeadContext.mockResolvedValue({
      headSha: null,
      repositoryFullName: null,
    });
  });

  it("returns userContext from ArtifactVersion v1 for PLAN command", async () => {
    const userContent = "Please focus on the authentication module.";
    mockGetByVersion.mockResolvedValue({ content: userContent });

    const loop = {
      ...BASE_LOOP,
      command: LoopCommand.Plan,
      documentId: "artifact-1",
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(mockGetByVersion).toHaveBeenCalledWith("artifact-1", 1);
    expect(pack.userContext).toBe(userContent);
  });

  it("returns no userContext for non-PLAN commands", async () => {
    const loop = {
      ...BASE_LOOP,
      command: LoopCommand.Execute,
      documentId: "artifact-1",
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(mockGetByVersion).not.toHaveBeenCalled();
    expect(pack.userContext).toBeUndefined();
  });

  it("returns no userContext when ArtifactVersion v1 content is null", async () => {
    mockGetByVersion.mockResolvedValue({ content: null });

    const loop = {
      ...BASE_LOOP,
      command: LoopCommand.Plan,
      documentId: "artifact-1",
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(pack.userContext).toBeUndefined();
  });

  it("returns no userContext when content is empty string", async () => {
    mockGetByVersion.mockResolvedValue({ content: "" });

    const loop = {
      ...BASE_LOOP,
      command: LoopCommand.Plan,
      documentId: "artifact-1",
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(pack.userContext).toBeUndefined();
  });

  it("returns no userContext when content is whitespace-only", async () => {
    mockGetByVersion.mockResolvedValue({ content: "   \n\t  " });

    const loop = {
      ...BASE_LOOP,
      command: LoopCommand.Plan,
      documentId: "artifact-1",
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(pack.userContext).toBeUndefined();
  });

  it("truncates and logs a warning when content exceeds 16,000 characters", async () => {
    const oversizedContent = "x".repeat(20_000);
    mockGetByVersion.mockResolvedValue({ content: oversizedContent });

    const loop = {
      ...BASE_LOOP,
      command: LoopCommand.Plan,
      documentId: "artifact-1",
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(pack.userContext).toHaveLength(16_000);
    expect(pack.userContext).toBe(oversizedContent.slice(0, 16_000));
  });

  it("separates direct context refs into supportingArtifacts while preserving artifacts", async () => {
    mockGetCommandHandler.mockReturnValue({
      requiresRepo: false,
      requiresParent: false,
      includePrimaryArtifact: true,
    });
    mockFindByIdSimple.mockImplementation(async (id: string) => ({
      id,
      type: id === "feature-1" ? DocumentType.Feature : DocumentType.Prd,
      title: `Title ${id}`,
    }));
    mockGetLatest.mockImplementation(async (id: string) => ({
      content: `Content ${id}`,
    }));

    const pack = await buildContextPackInMemory(
      {
        ...BASE_LOOP,
        command: LoopCommand.EvaluatePrd,
        documentId: "primary-prd",
        contextRefs: [
          { sourceId: "ref-prd", include: "full" },
          { sourceId: "primary-prd", include: "full" },
          { sourceId: "feature-1", include: "summary" },
        ],
      },
      "org-1"
    );

    expect(pack.supportingArtifacts?.map((artifact) => artifact.id)).toEqual([
      "ref-prd",
      "feature-1",
    ]);
    expect(pack.artifacts.map((artifact) => artifact.id)).toEqual([
      "ref-prd",
      "feature-1",
      "primary-prd",
    ]);
  });

  it("builds codeEvaluationContext for EVALUATE_CODE from Symphony metadata", async () => {
    mockGetCommandHandler.mockReturnValue({
      requiresRepo: true,
      requiresParent: false,
      includePrimaryArtifact: true,
    });
    mockFindByIdSimple.mockResolvedValue({
      id: "plan-1",
      type: DocumentType.ImplementationPlan,
      title: "Plan",
    });
    mockGetLatest.mockResolvedValue({ content: "Plan content" });
    mockFindLoopById.mockResolvedValue({
      id: "parent-loop",
      command: LoopCommand.Execute,
      status: "COMPLETED",
      branchName: "feat/parent",
      sessionId: "019e1fbd-65eb-71ef-a7ac-59e2eba5b70d",
      s3StateKey: null,
    });
    mockGetDocumentPullRequest.mockResolvedValue({
      id: "pr-artifact-1",
      number: 42,
      htmlUrl: "https://github.com/closedloop/repo/pull/42",
      headBranch: "feat/context",
      baseBranch: "main",
      repoFullName: "closedloop/repo",
    });
    mockFindSlugById.mockResolvedValue("fea-585");
    mockGetPullRequestHeadContext.mockResolvedValue({
      headSha: "abc123",
      repositoryFullName: "closedloop/repo",
    });

    const pack = await buildContextPackInMemory(
      {
        ...BASE_LOOP,
        command: LoopCommand.EvaluateCode,
        documentId: "plan-1",
        parentLoopId: "parent-loop",
        repo: { fullName: "closedloop/repo", branch: "main" },
        metadata: { localRepoPath: "/workspace/repo" },
      },
      "org-1"
    );

    expect(pack.codeEvaluationContext).toEqual({
      schemaVersion: 1,
      repo: { fullName: "closedloop/repo", branch: "main" },
      localRepoPath: "/workspace/repo",
      parentBranchName: "feat/parent",
      parentSessionId: "019e1fbd-65eb-71ef-a7ac-59e2eba5b70d",
      artifactSlug: "fea-585",
      pullRequest: {
        number: 42,
        url: "https://github.com/closedloop/repo/pull/42",
        headBranch: "feat/context",
        baseBranch: "main",
        headSha: "abc123",
        repositoryFullName: "closedloop/repo",
      },
      detected: null,
    });
  });
});
