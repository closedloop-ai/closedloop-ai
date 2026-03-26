import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock all external dependencies before imports
vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@/app/artifacts/artifact-version-service", () => ({
  artifactVersionService: {
    getByVersion: vi.fn().mockResolvedValue(null),
    getLatest: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/app/artifacts/service", () => ({
  artifactsService: {
    findByIdSimple: vi.fn().mockResolvedValue(null),
  },
  getCommitterInfo: vi.fn(),
}));

vi.mock("@/app/features/service", () => ({
  featuresService: {
    findById: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    findById: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn(),
  },
  isInvalidStatusTransitionError: vi.fn(),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  uploadContextPack: vi.fn().mockResolvedValue("s3://mock-key"),
  downloadMetadata: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/loops/loop-event-bus", () => ({
  loopEventBus: { publish: vi.fn() },
}));

import { ArtifactType } from "@repo/api/src/types/artifact";
import { EntityType } from "@repo/api/src/types/entity-link";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { artifactsService } from "@/app/artifacts/service";
import { featuresService } from "@/app/features/service";
import { buildContextPack } from "@/lib/loops/loop-context-pack";
import { uploadContextPack } from "@/lib/loops/loop-state";

const mockFeaturesService = featuresService as unknown as {
  findById: ReturnType<typeof vi.fn>;
};
const mockArtifactsService = artifactsService as unknown as {
  findByIdSimple: ReturnType<typeof vi.fn>;
};
const mockArtifactVersionService = artifactVersionService as unknown as {
  getByVersion: ReturnType<typeof vi.fn>;
  getLatest: ReturnType<typeof vi.fn>;
};
const mockUploadContextPack = uploadContextPack as unknown as ReturnType<
  typeof vi.fn
>;

describe("buildContextPack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUploadContextPack.mockResolvedValue("s3://mock-key");
  });

  it("includes issue as FEATURE artifact via contextRef with sourceType ISSUE", async () => {
    mockFeaturesService.findById.mockResolvedValue({
      id: "issue-1",
      title: "User login flow",
      description: "Implement the user login flow with OAuth",
      workstreamId: "ws-1",
    });

    await buildContextPack(
      {
        id: "loop-1",
        userId: "user-1",
        command: "PLAN",
        prompt: null,
        artifactId: "artifact-1",
        artifactVersion: null,
        parentLoopId: null,
        repo: { fullName: "org/repo", branch: "main" },
        contextRefs: [
          {
            sourceId: "issue-1",
            sourceType: EntityType.Feature,
            include: "full" as const,
          },
        ],
      },
      "org-1",
      "state-prefix"
    );

    expect(mockFeaturesService.findById).toHaveBeenCalledWith(
      "issue-1",
      "org-1"
    );

    const uploadCall = mockUploadContextPack.mock.calls[0];
    const contextPack = uploadCall[1];

    // Feature artifact should be first in the array
    expect(contextPack.artifacts[0]).toEqual({
      id: "issue-1",
      type: "FEATURE",
      title: "User login flow",
      content: "Implement the user login flow with OAuth",
    });
  });

  it("does not include issue artifact when contextRefs is empty", async () => {
    await buildContextPack(
      {
        id: "loop-1",
        userId: "user-1",
        command: "PLAN",
        prompt: null,
        artifactId: null,
        artifactVersion: null,
        parentLoopId: null,
        repo: { fullName: "org/repo", branch: "main" },
        contextRefs: [],
      },
      "org-1",
      "state-prefix"
    );

    expect(mockFeaturesService.findById).not.toHaveBeenCalled();

    const uploadCall = mockUploadContextPack.mock.calls[0];
    const contextPack = uploadCall[1];
    expect(contextPack.artifacts).toEqual([]);
  });

  it("does not include issue artifact when contextRefs is null", async () => {
    await buildContextPack(
      {
        id: "loop-1",
        userId: "user-1",
        command: "PLAN",
        prompt: null,
        artifactId: null,
        artifactVersion: null,
        parentLoopId: null,
        repo: { fullName: "org/repo", branch: "main" },
        contextRefs: null,
      },
      "org-1",
      "state-prefix"
    );

    expect(mockFeaturesService.findById).not.toHaveBeenCalled();
  });

  it("gracefully handles issue not found", async () => {
    mockFeaturesService.findById.mockResolvedValue(null);

    await buildContextPack(
      {
        id: "loop-1",
        userId: "user-1",
        command: "PLAN",
        prompt: null,
        artifactId: null,
        artifactVersion: null,
        parentLoopId: null,
        repo: { fullName: "org/repo", branch: "main" },
        contextRefs: [
          {
            sourceId: "nonexistent-issue",
            sourceType: EntityType.Feature,
            include: "full" as const,
          },
        ],
      },
      "org-1",
      "state-prefix"
    );

    const uploadCall = mockUploadContextPack.mock.calls[0];
    const contextPack = uploadCall[1];
    expect(contextPack.artifacts).toEqual([]);
  });

  it("includes PRD from contextRefs alongside issue artifact", async () => {
    mockFeaturesService.findById.mockResolvedValue({
      id: "issue-1",
      title: "User login flow",
      description: "Implement the user login flow",
      workstreamId: "ws-1",
    });

    mockArtifactsService.findByIdSimple.mockResolvedValue({
      id: "prd-1",
      type: ArtifactType.Prd,
      title: "Auth PRD",
    });

    mockArtifactVersionService.getLatest.mockResolvedValue({
      content: "# Authentication PRD\n\nFull PRD content here.",
    });

    await buildContextPack(
      {
        id: "loop-1",
        userId: "user-1",
        command: "PLAN",
        prompt: null,
        artifactId: "artifact-1",
        artifactVersion: null,
        parentLoopId: null,
        repo: { fullName: "org/repo", branch: "main" },
        contextRefs: [
          {
            sourceId: "issue-1",
            sourceType: EntityType.Feature,
            include: "full" as const,
          },
          { sourceId: "prd-1", include: "full" as const },
        ],
      },
      "org-1",
      "state-prefix"
    );

    const uploadCall = mockUploadContextPack.mock.calls[0];
    const contextPack = uploadCall[1];

    // Feature artifact should come first, then PRD from contextRefs
    expect(contextPack.artifacts).toHaveLength(2);
    expect(contextPack.artifacts[0].type).toBe("FEATURE");
    expect(contextPack.artifacts[0].id).toBe("issue-1");
    expect(contextPack.artifacts[1].type).toBe(ArtifactType.Prd);
    expect(contextPack.artifacts[1].id).toBe("prd-1");
  });

  it("existing PRD-only flow still works without issue refs", async () => {
    mockArtifactsService.findByIdSimple.mockResolvedValue({
      id: "prd-1",
      type: ArtifactType.Prd,
      title: "My PRD",
    });

    mockArtifactVersionService.getLatest.mockResolvedValue({
      content: "# PRD Content",
    });

    await buildContextPack(
      {
        id: "loop-1",
        userId: "user-1",
        command: "PLAN",
        prompt: null,
        artifactId: "artifact-1",
        artifactVersion: null,
        parentLoopId: null,
        repo: { fullName: "org/repo", branch: "main" },
        contextRefs: [{ sourceId: "prd-1", include: "full" as const }],
      },
      "org-1",
      "state-prefix"
    );

    const uploadCall = mockUploadContextPack.mock.calls[0];
    const contextPack = uploadCall[1];

    expect(contextPack.artifacts).toHaveLength(1);
    expect(contextPack.artifacts[0].type).toBe(ArtifactType.Prd);
    expect(contextPack.artifacts[0].content).toBe("# PRD Content");
  });
});
