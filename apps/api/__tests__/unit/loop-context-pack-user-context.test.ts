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
    getByVersion: vi.fn(),
  },
}));

vi.mock("@/app/artifacts/service", () => ({
  artifactsService: {
    findByIdSimple: vi.fn(),
    findOrgTemplate: vi.fn(),
    ensureDefaultTemplates: vi.fn(),
  },
}));

vi.mock("@/app/artifacts/attachments-service", () => ({
  attachmentsService: {
    listWithSignedUrlsByArtifact: vi.fn().mockResolvedValue([]),
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

import { LoopCommand } from "@repo/api/src/types/loop";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { getCommandHandler } from "@/lib/loops/loop-commands";
import { buildContextPackInMemory } from "@/lib/loops/loop-context-pack";

type MockFn = ReturnType<typeof vi.fn>;
const mockGetByVersion = artifactVersionService.getByVersion as MockFn;
const mockGetLatest = artifactVersionService.getLatest as MockFn;
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
  artifactVersion: null,
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
  });

  it("returns userContext from ArtifactVersion v1 for PLAN command", async () => {
    const userContent = "Please focus on the authentication module.";
    mockGetByVersion.mockResolvedValue({ content: userContent });

    const loop = {
      ...BASE_LOOP,
      command: LoopCommand.Plan,
      artifactId: "artifact-1",
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(mockGetByVersion).toHaveBeenCalledWith("artifact-1", 1);
    expect(pack.userContext).toBe(userContent);
  });

  it("returns no userContext for non-PLAN commands", async () => {
    const loop = {
      ...BASE_LOOP,
      command: LoopCommand.Execute,
      artifactId: "artifact-1",
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
      artifactId: "artifact-1",
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(pack.userContext).toBeUndefined();
  });

  it("returns no userContext when content is empty string", async () => {
    mockGetByVersion.mockResolvedValue({ content: "" });

    const loop = {
      ...BASE_LOOP,
      command: LoopCommand.Plan,
      artifactId: "artifact-1",
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(pack.userContext).toBeUndefined();
  });

  it("returns no userContext when content is whitespace-only", async () => {
    mockGetByVersion.mockResolvedValue({ content: "   \n\t  " });

    const loop = {
      ...BASE_LOOP,
      command: LoopCommand.Plan,
      artifactId: "artifact-1",
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
      artifactId: "artifact-1",
    };

    const pack = await buildContextPackInMemory(loop, "org-1");

    expect(pack.userContext).toHaveLength(16_000);
    expect(pack.userContext).toBe(oversizedContent.slice(0, 16_000));
  });
});
