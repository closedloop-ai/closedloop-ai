/**
 * Unit tests for PRD template injection in the context pack.
 *
 * Verifies that GENERATE_PRD loops include the org's PRD template
 * in the context pack artifacts, and other commands do not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/database", () => ({
  ArtifactType: { PRD: "PRD", TEMPLATE: "TEMPLATE" },
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
  },
}));

vi.mock("@/app/documents/service", () => ({
  documentsService: {
    findByIdSimple: vi.fn(),
    findOrgTemplate: vi.fn(),
    ensureDefaultTemplates: vi.fn(),
  },
}));

vi.mock("@/app/documents/attachments-service", () => ({
  attachmentsService: {
    listWithSignedUrlsByDocument: vi.fn().mockResolvedValue([]),
    listWithSignedUrlsByFeature: vi.fn().mockResolvedValue([]),
  },
  ATTACHMENT_SIGNED_URL_MAX_FILES: 20,
}));

vi.mock("@/app/features/service", () => ({
  featuresService: {
    findById: vi.fn(),
  },
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
import { documentVersionService } from "@/app/documents/document-version-service";
import { documentsService } from "@/app/documents/service";
import { getCommandHandler } from "@/lib/loops/loop-commands";
import { buildContextPackInMemory } from "@/lib/loops/loop-context-pack";

type MockFn = ReturnType<typeof vi.fn>;
const mockFindOrgTemplate = documentsService.findOrgTemplate as MockFn;
const mockEnsureDefaultTemplates =
  documentsService.ensureDefaultTemplates as MockFn;
const mockGetLatest = documentVersionService.getLatest as MockFn;
const mockGetCommandHandler = getCommandHandler as MockFn;

// ---------------------------------------------------------------------------
// Template injection
// ---------------------------------------------------------------------------

describe("context pack template injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: handler not found (no primary artifact inclusion)
    mockGetCommandHandler.mockReturnValue(undefined);
  });

  it("includes PRD template for GENERATE_PRD command", async () => {
    mockFindOrgTemplate.mockResolvedValue({
      id: "template-1",
      title: "PRD Template",
      type: DocumentType.Template,
    });
    mockGetLatest.mockResolvedValue({
      content: "# PRD Template\n\n## Overview\n\n## Goals",
    });
    // Return a handler that includes primary artifact
    mockGetCommandHandler.mockReturnValue({
      requiresRepo: true,
      requiresParent: false,
      includePrimaryArtifact: true,
    });

    const loop = {
      id: "loop-1",
      userId: "user-1",
      command: LoopCommand.GeneratePrd,
      prompt: "Build a search feature",
      documentId: "prd-1",
      parentLoopId: null,
      repo: null,
      contextRefs: null,
      documentVersion: null,
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    // Template should be the first artifact in the pack
    expect(pack.artifacts[0]).toEqual({
      id: "template-1",
      type: DocumentType.Template,
      title: "PRD Template",
      content: "# PRD Template\n\n## Overview\n\n## Goals",
    });
  });

  it("lazy-seeds template when none exists", async () => {
    // First call returns null, second returns the seeded template
    mockFindOrgTemplate.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "template-1",
      title: "PRD Template",
      type: DocumentType.Template,
    });
    mockEnsureDefaultTemplates.mockResolvedValue(undefined);
    mockGetLatest.mockResolvedValue({ content: "# Default Template" });
    mockGetCommandHandler.mockReturnValue({
      requiresRepo: true,
      requiresParent: false,
      includePrimaryArtifact: true,
    });

    const loop = {
      id: "loop-1",
      userId: "user-1",
      command: LoopCommand.GeneratePrd,
      prompt: null,
      documentId: "prd-1",
      parentLoopId: null,
      repo: null,
      contextRefs: null,
      documentVersion: null,
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(mockEnsureDefaultTemplates).toHaveBeenCalledWith("org-1", "user-1");
    expect(pack.artifacts[0]).toEqual(
      expect.objectContaining({ type: DocumentType.Template })
    );
  });

  it("does not include template for non-GENERATE_PRD commands", async () => {
    const loop = {
      id: "loop-1",
      userId: "user-1",
      command: LoopCommand.Plan,
      prompt: null,
      documentId: null,
      parentLoopId: null,
      repo: null,
      contextRefs: null,
      documentVersion: null,
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(mockFindOrgTemplate).not.toHaveBeenCalled();
    expect(
      pack.artifacts.find((a) => a.type === DocumentType.Template)
    ).toBeUndefined();
  });
});
