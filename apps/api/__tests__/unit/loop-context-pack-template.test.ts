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

vi.mock("@/app/artifacts/artifact-version-service", () => ({
  artifactVersionService: {
    getLatest: vi.fn(),
  },
}));

vi.mock("@/app/artifacts/service", () => ({
  artifactsService: {
    findByIdSimple: vi.fn(),
    findOrgTemplate: vi.fn(),
    ensureDefaultTemplates: vi.fn(),
  },
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

import { ArtifactType } from "@repo/api/src/types/artifact";
import { LoopCommand } from "@repo/api/src/types/loop";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { artifactsService } from "@/app/artifacts/service";
import { getCommandHandler } from "@/lib/loops/loop-commands";
import { buildContextPackInMemory } from "@/lib/loops/loop-context-pack";

type MockFn = ReturnType<typeof vi.fn>;
const mockFindOrgTemplate = artifactsService.findOrgTemplate as MockFn;
const mockEnsureDefaultTemplates =
  artifactsService.ensureDefaultTemplates as MockFn;
const mockGetLatest = artifactVersionService.getLatest as MockFn;
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
      type: ArtifactType.Template,
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
      artifactId: "prd-1",
      parentLoopId: null,
      repo: null,
      contextRefs: null,
      artifactVersion: null,
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    // Template should be the first artifact in the pack
    expect(pack.artifacts[0]).toEqual({
      id: "template-1",
      type: ArtifactType.Template,
      title: "PRD Template",
      content: "# PRD Template\n\n## Overview\n\n## Goals",
    });
  });

  it("lazy-seeds template when none exists", async () => {
    // First call returns null, second returns the seeded template
    mockFindOrgTemplate.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "template-1",
      title: "PRD Template",
      type: ArtifactType.Template,
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
      artifactId: "prd-1",
      parentLoopId: null,
      repo: null,
      contextRefs: null,
      artifactVersion: null,
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(mockEnsureDefaultTemplates).toHaveBeenCalledWith("org-1", "user-1");
    expect(pack.artifacts[0]).toEqual(
      expect.objectContaining({ type: ArtifactType.Template })
    );
  });

  it("does not include template for non-GENERATE_PRD commands", async () => {
    const loop = {
      id: "loop-1",
      userId: "user-1",
      command: LoopCommand.Plan,
      prompt: null,
      artifactId: null,
      parentLoopId: null,
      repo: null,
      contextRefs: null,
      artifactVersion: null,
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(mockFindOrgTemplate).not.toHaveBeenCalled();
    expect(
      pack.artifacts.find((a) => a.type === ArtifactType.Template)
    ).toBeUndefined();
  });
});
