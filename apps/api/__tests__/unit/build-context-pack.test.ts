import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock all external dependencies before imports
vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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

vi.mock("@/app/artifacts/attachments-service", () => ({
  ATTACHMENT_SIGNED_URL_MAX_FILES: 20,
  attachmentsService: {
    findByIdSimple: vi.fn().mockResolvedValue(null),
    listWithSignedUrlsByArtifact: vi.fn().mockResolvedValue([]),
    listWithSignedUrlsByFeature: vi.fn().mockResolvedValue([]),
  },
}));

import { ArtifactType } from "@repo/api/src/types/artifact";
import { EntityType } from "@repo/api/src/types/entity-link";
import { LoopCommand } from "@repo/api/src/types/loop";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { attachmentsService } from "@/app/artifacts/attachments-service";
import { artifactsService } from "@/app/artifacts/service";
import { featuresService } from "@/app/features/service";
import {
  buildContextPack,
  fetchAttachmentsForContextPack,
} from "@/lib/loops/loop-context-pack";
import { uploadContextPack } from "@/lib/loops/loop-state";

const mockAttachmentsService = attachmentsService as unknown as {
  findByIdSimple: ReturnType<typeof vi.fn>;
  listWithSignedUrlsByArtifact: ReturnType<typeof vi.fn>;
  listWithSignedUrlsByFeature: ReturnType<typeof vi.fn>;
};
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

describe("fetchAttachmentsForContextPack", () => {
  const mockAttachment = {
    id: "att-1",
    filename: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    signedUrl: "https://s3.example.com/att-1",
    signedUrlExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };

  const baseLoop = {
    id: "loop-1",
    userId: "user-1",
    prompt: null,
    artifactId: "artifact-1",
    artifactVersion: null,
    parentLoopId: null,
    repo: { fullName: "org/repo", branch: "main" },
    contextRefs: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENABLE_ATTACHMENT_CONTEXT_PACK = "true";
  });

  afterEach(() => {
    process.env.ENABLE_ATTACHMENT_CONTEXT_PACK = undefined;
  });

  it("calls listWithSignedUrlsByFeature for Feature contextRef with attachments", async () => {
    mockAttachmentsService.listWithSignedUrlsByFeature.mockResolvedValue([
      mockAttachment,
    ]);

    const result = await fetchAttachmentsForContextPack(
      {
        ...baseLoop,
        command: LoopCommand.Plan,
        contextRefs: [
          {
            sourceId: "feature-1",
            sourceType: EntityType.Feature,
            include: "full" as const,
          },
        ],
      },
      "org-1"
    );

    expect(
      mockAttachmentsService.listWithSignedUrlsByFeature
    ).toHaveBeenCalledWith("feature-1", "org-1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("att-1");
  });

  it("calls listWithSignedUrlsByArtifact for artifact contextRef with attachments", async () => {
    mockAttachmentsService.listWithSignedUrlsByArtifact.mockResolvedValue([
      mockAttachment,
    ]);

    const result = await fetchAttachmentsForContextPack(
      {
        ...baseLoop,
        command: LoopCommand.Plan,
        artifactId: null,
        contextRefs: [{ sourceId: "artifact-2", include: "full" as const }],
      },
      "org-1"
    );

    expect(
      mockAttachmentsService.listWithSignedUrlsByArtifact
    ).toHaveBeenCalledWith("artifact-2", "org-1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("att-1");
  });

  it("returns empty array when contextRefs is null", async () => {
    const result = await fetchAttachmentsForContextPack(
      {
        ...baseLoop,
        command: LoopCommand.Plan,
        artifactId: null,
        contextRefs: null,
      },
      "org-1"
    );

    expect(
      mockAttachmentsService.listWithSignedUrlsByFeature
    ).not.toHaveBeenCalled();
    expect(
      mockAttachmentsService.listWithSignedUrlsByArtifact
    ).not.toHaveBeenCalled();
    expect(result).toHaveLength(0);
  });

  it("fetches attachments from both Feature and Artifact contextRefs", async () => {
    const featureAtt = { ...mockAttachment, id: "att-feature" };
    const artifactAtt = { ...mockAttachment, id: "att-artifact" };

    mockAttachmentsService.listWithSignedUrlsByFeature.mockResolvedValue([
      featureAtt,
    ]);
    mockAttachmentsService.listWithSignedUrlsByArtifact.mockResolvedValue([
      artifactAtt,
    ]);

    const result = await fetchAttachmentsForContextPack(
      {
        ...baseLoop,
        command: LoopCommand.Plan,
        artifactId: null,
        contextRefs: [
          {
            sourceId: "feature-1",
            sourceType: EntityType.Feature,
            include: "full" as const,
          },
          { sourceId: "artifact-2", include: "full" as const },
        ],
      },
      "org-1"
    );

    expect(result).toHaveLength(2);
    const ids = result.map((a) => a.id);
    expect(ids).toContain("att-feature");
    expect(ids).toContain("att-artifact");
  });

  it("includes primary artifact attachments for EXECUTE command", async () => {
    mockAttachmentsService.listWithSignedUrlsByArtifact.mockResolvedValue([
      mockAttachment,
    ]);

    const result = await fetchAttachmentsForContextPack(
      {
        ...baseLoop,
        command: LoopCommand.Execute,
        contextRefs: null,
      },
      "org-1"
    );

    expect(
      mockAttachmentsService.listWithSignedUrlsByArtifact
    ).toHaveBeenCalledWith("artifact-1", "org-1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("att-1");
  });

  it("includes primary artifact attachments for REQUEST_CHANGES command", async () => {
    mockAttachmentsService.listWithSignedUrlsByArtifact.mockResolvedValue([
      mockAttachment,
    ]);

    const result = await fetchAttachmentsForContextPack(
      {
        ...baseLoop,
        command: LoopCommand.RequestChanges,
        contextRefs: null,
      },
      "org-1"
    );

    expect(
      mockAttachmentsService.listWithSignedUrlsByArtifact
    ).toHaveBeenCalledWith("artifact-1", "org-1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("att-1");
  });

  it("does NOT include primary artifact attachments for PLAN command", async () => {
    const result = await fetchAttachmentsForContextPack(
      {
        ...baseLoop,
        command: LoopCommand.Plan,
        contextRefs: null,
      },
      "org-1"
    );

    // listWithSignedUrlsByArtifact should not be called for primary artifact
    // (PLAN handler has includePrimaryArtifact: false)
    expect(
      mockAttachmentsService.listWithSignedUrlsByArtifact
    ).not.toHaveBeenCalled();
    expect(result).toHaveLength(0);
  });

  it("deduplicates same attachment.id from both primary and contextRef (primary takes precedence)", async () => {
    const primaryVersion = {
      ...mockAttachment,
      id: "att-1",
      signedUrl: "https://s3.example.com/primary",
    };
    const contextRefVersion = {
      ...mockAttachment,
      id: "att-1",
      signedUrl: "https://s3.example.com/contextref",
    };

    // Primary artifact call returns primaryVersion
    mockAttachmentsService.listWithSignedUrlsByArtifact
      .mockResolvedValueOnce([primaryVersion])
      // contextRef artifact call returns contextRefVersion
      .mockResolvedValueOnce([contextRefVersion]);

    const result = await fetchAttachmentsForContextPack(
      {
        ...baseLoop,
        command: LoopCommand.Execute,
        contextRefs: [{ sourceId: "artifact-2", include: "full" as const }],
      },
      "org-1"
    );

    // Should appear only once
    expect(result).toHaveLength(1);
    // Primary version takes precedence
    expect(result[0].signedUrl).toBe("https://s3.example.com/primary");
  });

  it("skips oversized file (>25 MB) with warn", async () => {
    const oversizedAttachment = {
      ...mockAttachment,
      id: "att-big",
      sizeBytes: 26 * 1024 * 1024,
    };
    mockAttachmentsService.listWithSignedUrlsByArtifact.mockResolvedValue([
      oversizedAttachment,
    ]);

    const { log } = await import("@repo/observability/log");
    const mockLog = log as unknown as { warn: ReturnType<typeof vi.fn> };

    const result = await fetchAttachmentsForContextPack(
      {
        ...baseLoop,
        command: LoopCommand.Execute,
        contextRefs: null,
      },
      "org-1"
    );

    expect(result).toHaveLength(0);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("per-file size limit"),
      expect.objectContaining({ attachmentId: "att-big" })
    );
  });

  it("skips 21st file when count limit of 20 is reached with warn", async () => {
    // Create 21 unique attachments each within size limits
    const attachments = Array.from({ length: 21 }, (_, i) => ({
      ...mockAttachment,
      id: `att-${i}`,
    }));
    mockAttachmentsService.listWithSignedUrlsByArtifact.mockResolvedValue(
      attachments
    );

    const { log } = await import("@repo/observability/log");
    const mockLog = log as unknown as { warn: ReturnType<typeof vi.fn> };

    const result = await fetchAttachmentsForContextPack(
      {
        ...baseLoop,
        command: LoopCommand.Execute,
        contextRefs: null,
      },
      "org-1"
    );

    expect(result).toHaveLength(20);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("count cap"),
      expect.objectContaining({ attachmentId: "att-20" })
    );
  });

  it("stops accumulation when total 50 MB cap is reached", async () => {
    // Each attachment is 20 MB (under the 25 MB per-file limit).
    // First fits (20 MB < 50 MB total), second would push total to 40 MB — still fits,
    // third would push total to 60 MB > 50 MB cap.
    const twentyMb = 20 * 1024 * 1024;
    const att1 = { ...mockAttachment, id: "att-1", sizeBytes: twentyMb };
    const att2 = { ...mockAttachment, id: "att-2", sizeBytes: twentyMb };
    const att3 = { ...mockAttachment, id: "att-3", sizeBytes: twentyMb };

    mockAttachmentsService.listWithSignedUrlsByArtifact.mockResolvedValue([
      att1,
      att2,
      att3,
    ]);

    const { log } = await import("@repo/observability/log");
    const mockLog = log as unknown as { warn: ReturnType<typeof vi.fn> };

    const result = await fetchAttachmentsForContextPack(
      {
        ...baseLoop,
        command: LoopCommand.Execute,
        contextRefs: null,
      },
      "org-1"
    );

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("att-1");
    expect(result[1].id).toBe("att-2");
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("total size cap"),
      expect.objectContaining({ attachmentId: "att-3" })
    );
  });

  it("returns empty array without propagating when service throws", async () => {
    mockAttachmentsService.listWithSignedUrlsByFeature.mockRejectedValue(
      new Error("DB connection failed")
    );

    const result = await fetchAttachmentsForContextPack(
      {
        ...baseLoop,
        command: LoopCommand.Plan,
        contextRefs: [
          {
            sourceId: "feature-1",
            sourceType: EntityType.Feature,
            include: "full" as const,
          },
        ],
      },
      "org-1"
    );

    expect(result).toHaveLength(0);
  });

  it("returns empty array when ENABLE_ATTACHMENT_CONTEXT_PACK is not set", async () => {
    process.env.ENABLE_ATTACHMENT_CONTEXT_PACK = undefined;

    mockAttachmentsService.listWithSignedUrlsByArtifact.mockResolvedValue([
      mockAttachment,
    ]);

    const result = await fetchAttachmentsForContextPack(
      {
        ...baseLoop,
        command: LoopCommand.Execute,
        contextRefs: null,
      },
      "org-1"
    );

    expect(
      mockAttachmentsService.listWithSignedUrlsByArtifact
    ).not.toHaveBeenCalled();
    expect(result).toHaveLength(0);
  });
});
