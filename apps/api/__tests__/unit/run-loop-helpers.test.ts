/**
 * Unit tests for resolveLoopContext in run-loop-helpers.ts.
 *
 * Covers the targetRepo and targetBranch fallback chains added in this session:
 *   body.repo → artifact → source → projectSettings.defaultRepository
 *
 * Also verifies contextRefs construction, workstream resolution, and
 * parentLoopId lookup gating on handler.requiresParent.
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import { vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/artifacts/service", () => ({
  artifactsService: {
    findOrCreateWorkstream: vi.fn(),
  },
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    findLatestCompletedForArtifact: vi.fn(),
  },
}));

// --- Imports (after mocks) ---

import { beforeEach, describe, expect, it } from "vitest";
import { resolveLoopContext } from "@/app/artifacts/[id]/run-loop/run-loop-helpers";
import { artifactsService } from "@/app/artifacts/service";
import { loopsService } from "@/app/loops/service";

type MockFn = ReturnType<typeof vi.fn>;

const mockArtifactsService = artifactsService as unknown as {
  findOrCreateWorkstream: MockFn;
};
const mockLoopsService = loopsService as unknown as {
  findLatestCompletedForArtifact: MockFn;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildArtifact(
  overrides: Partial<{
    targetRepo: string | null;
    targetBranch: string | null;
    workstream: unknown;
  }> = {}
) {
  return {
    id: "artifact-1",
    organizationId: "org-1",
    targetRepo: null,
    targetBranch: null,
    workstream: null,
    ...overrides,
  };
}

function buildWorkstream(
  projectSettings: Record<string, unknown> = {}
): NonNullable<ReturnType<typeof buildArtifact>["workstream"]> {
  return {
    id: "ws-1",
    project: {
      id: "project-1",
      settings: projectSettings,
    },
  };
}

function buildSource(
  overrides: Partial<{ targetRepo: string; targetBranch: string }> = {}
) {
  return {
    id: "source-1",
    type: ArtifactType.Prd,
    targetRepo: undefined as string | undefined,
    targetBranch: undefined as string | undefined,
    ...overrides,
  };
}

/** A handler that does NOT require a parent loop. */
const noParentHandler = {
  requiresRepo: false,
  requiresParent: false,
  includePrimaryArtifact: false,
  downloadAndIngest: vi.fn(),
  uploadAndIngest: vi.fn(),
};

/** A handler that DOES require a parent loop. */
const requiresParentHandler = {
  requiresRepo: true,
  requiresParent: true,
  includePrimaryArtifact: true,
  downloadAndIngest: vi.fn(),
  uploadAndIngest: vi.fn(),
};

// ---------------------------------------------------------------------------
// targetRepo fallback chain
// ---------------------------------------------------------------------------

describe("resolveLoopContext — targetRepo fallback chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses body.repo.fullName when provided", async () => {
    const artifact = buildArtifact({ targetRepo: "artifact/repo" });
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream(),
      source: buildSource({ targetRepo: "source/repo" }),
    });

    const result = await resolveLoopContext(
      artifact as any,
      { repo: { fullName: "body/repo", branch: "main" }, command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.targetRepo).toBe("body/repo");
  });

  it("prefers artifact.targetRepo over source.targetRepo", async () => {
    const artifact = buildArtifact({ targetRepo: "artifact/repo" });
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream(),
      source: buildSource({ targetRepo: "source/repo" }),
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.targetRepo).toBe("artifact/repo");
  });

  it("falls back to source.targetRepo when artifact has no targetRepo", async () => {
    const artifact = buildArtifact({ targetRepo: null });
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream(),
      source: buildSource({ targetRepo: "source/repo" }),
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.targetRepo).toBe("source/repo");
  });

  it("falls back to projectSettings.defaultRepository.repoFullName when source and artifact have no targetRepo", async () => {
    const artifact = buildArtifact({ targetRepo: null });
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream({
        defaultRepository: {
          repoId: "repo-id-1",
          repoFullName: "project/default-repo",
          branch: "develop",
        },
      }),
      source: buildSource(), // no targetRepo
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.targetRepo).toBe("project/default-repo");
  });

  it("returns undefined targetRepo when all fallbacks are exhausted", async () => {
    const artifact = buildArtifact({ targetRepo: null });
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream(), // empty settings — no defaultRepository
      source: null,
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.targetRepo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// targetBranch fallback chain
// ---------------------------------------------------------------------------

describe("resolveLoopContext — targetBranch fallback chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses body.repo.branch when provided", async () => {
    const artifact = buildArtifact({ targetBranch: "artifact-branch" });
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream(),
      source: buildSource({ targetBranch: "source-branch" }),
    });

    const result = await resolveLoopContext(
      artifact as any,
      {
        repo: { fullName: "org/repo", branch: "body-branch" },
        command: "plan",
      },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.targetBranch).toBe("body-branch");
  });

  it("prefers artifact.targetBranch over source.targetBranch", async () => {
    const artifact = buildArtifact({ targetBranch: "artifact-branch" });
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream(),
      source: buildSource({ targetBranch: "source-branch" }),
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.targetBranch).toBe("artifact-branch");
  });

  it("falls back to source.targetBranch when artifact has no targetBranch", async () => {
    const artifact = buildArtifact({ targetBranch: null });
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream(),
      source: buildSource({ targetBranch: "source-branch" }),
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.targetBranch).toBe("source-branch");
  });

  it("falls back to projectSettings.defaultRepository.branch when source and artifact have no targetBranch", async () => {
    const artifact = buildArtifact({ targetBranch: null });
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream({
        defaultRepository: {
          repoId: "repo-id-1",
          repoFullName: "project/default-repo",
          branch: "develop",
        },
      }),
      source: buildSource(), // no targetBranch
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.targetBranch).toBe("develop");
  });

  it("defaults to 'main' when all fallbacks are exhausted", async () => {
    const artifact = buildArtifact({ targetBranch: null });
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream(), // empty settings
      source: null,
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.targetBranch).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// contextRefs
// ---------------------------------------------------------------------------

describe("resolveLoopContext — contextRefs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes source contextRef when source is present", async () => {
    const artifact = buildArtifact();
    const source = buildSource({ targetRepo: "org/repo" });
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream(),
      source,
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.contextRefs).toEqual([
      {
        sourceId: "source-1",
        sourceType: ArtifactType.Prd,
        include: "full",
      },
    ]);
  });

  it("returns empty contextRefs when source is null", async () => {
    const artifact = buildArtifact();
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: null,
      source: null,
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.contextRefs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parentLoopId gating on handler.requiresParent
// ---------------------------------------------------------------------------

describe("resolveLoopContext — parentLoopId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("looks up parentLoopId when handler.requiresParent is true", async () => {
    const artifact = buildArtifact();
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream(),
      source: null,
    });
    mockLoopsService.findLatestCompletedForArtifact.mockResolvedValue({
      id: "parent-loop-1",
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "request_changes" },
      requiresParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(
      mockLoopsService.findLatestCompletedForArtifact
    ).toHaveBeenCalledWith("artifact-1", "org-1");
    expect(result.parentLoopId).toBe("parent-loop-1");
  });

  it("skips parentLoopId lookup when handler.requiresParent is false", async () => {
    const artifact = buildArtifact();
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream(),
      source: null,
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(
      mockLoopsService.findLatestCompletedForArtifact
    ).not.toHaveBeenCalled();
    expect(result.parentLoopId).toBeUndefined();
  });

  it("returns undefined parentLoopId when no completed loop exists", async () => {
    const artifact = buildArtifact();
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: buildWorkstream(),
      source: null,
    });
    mockLoopsService.findLatestCompletedForArtifact.mockResolvedValue(null);

    const result = await resolveLoopContext(
      artifact as any,
      { command: "request_changes" },
      requiresParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.parentLoopId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// workstream resolution
// ---------------------------------------------------------------------------

describe("resolveLoopContext — workstream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns resolved workstream from findOrCreateWorkstream when present", async () => {
    const artifact = buildArtifact();
    const workstream = buildWorkstream();
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream,
      source: null,
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.workstream).toBe(workstream);
  });

  it("falls back to artifact.workstream when findOrCreateWorkstream returns null workstream", async () => {
    const artifactWorkstream = buildWorkstream();
    const artifact = buildArtifact({ workstream: artifactWorkstream });
    mockArtifactsService.findOrCreateWorkstream.mockResolvedValue({
      workstream: null,
      source: null,
    });

    const result = await resolveLoopContext(
      artifact as any,
      { command: "plan" },
      noParentHandler,
      "org-1",
      "user-1",
      "artifact-1"
    );

    expect(result.workstream).toBe(artifactWorkstream);
  });
});
