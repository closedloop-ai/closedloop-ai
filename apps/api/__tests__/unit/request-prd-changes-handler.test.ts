/**
 * Unit tests for the REQUEST_PRD_CHANGES command handler.
 *
 * Tests: downloading prd.md and creating an artifact version,
 * updating artifact status to DRAFT, resetting Liveblocks rooms,
 * and the guard clause that rejects non-PRD artifact types.
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => Promise<unknown>) =>
      fn({
        artifact: { update: vi.fn(), findUnique: vi.fn() },
        workstreamEvent: { findFirst: vi.fn(), create: vi.fn() },
      })
    ),
    {
      tx: vi.fn((fn: () => Promise<unknown>) => fn()),
    }
  ),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/artifacts/artifact-version-service", () => ({
  artifactVersionService: {
    createVersion: vi.fn(),
  },
}));

vi.mock("@/app/artifacts/room-utils", () => ({
  resetArtifactRoom: vi.fn(),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadArtifactFile: vi.fn(),
}));

// --- Imports (after mocks) ---

import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import { LoopCommand } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it } from "vitest";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { resetArtifactRoom } from "@/app/artifacts/room-utils";
import { requestPrdChangesHandler } from "@/lib/loops/loop-commands/generate-prd-handler";
import { downloadArtifactFile } from "@/lib/loops/loop-state";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;
const mockCreateVersion = artifactVersionService.createVersion as MockFn;
const mockResetArtifactRoom = resetArtifactRoom as MockFn;
const mockDownloadArtifactFile = downloadArtifactFile as MockFn;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequestPrdChangesLoop() {
  return buildLoop({
    command: LoopCommand.RequestPrdChanges,
    artifactId: "artifact-123",
    s3StateKey: "org/loops/loop-1/run-1",
  });
}

function mockDbCalls(
  artifactType: string | null = ArtifactType.Prd,
  slug: string | null = "test-slug"
) {
  const mockFindUnique = vi
    .fn()
    .mockResolvedValue(artifactType !== null ? { type: artifactType } : null);
  const mockUpdate = vi.fn().mockResolvedValue({
    id: "artifact-123",
    organizationId: "org-1",
    slug,
    type: ArtifactType.Prd,
    latestVersion: 2,
  });
  const mockFindFirst = vi.fn().mockResolvedValue(null);
  const mockCreate = vi.fn().mockResolvedValue({ id: "event-1" });

  (withDb as unknown as MockFn).mockImplementation(
    (fn: (db: unknown) => Promise<unknown>) =>
      fn({
        artifact: { update: mockUpdate, findUnique: mockFindUnique },
        workstreamEvent: { findFirst: mockFindFirst, create: mockCreate },
      })
  );

  return { mockFindUnique, mockUpdate, mockFindFirst, mockCreate };
}

// ---------------------------------------------------------------------------
// Handler shape
// ---------------------------------------------------------------------------

describe("requestPrdChangesHandler", () => {
  it("has correct handler configuration", () => {
    expect(requestPrdChangesHandler.requiresRepo).toBe(true);
    expect(requestPrdChangesHandler.requiresParent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ingestion logic
// ---------------------------------------------------------------------------

describe("requestPrdChangesHandler ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("downloads prd.md and creates an artifact version", async () => {
    const loop = buildRequestPrdChangesLoop();
    const prdContent = "# PRD\n\n## Overview\n\nThis is a test PRD.";
    mockDownloadArtifactFile.mockResolvedValue(Buffer.from(prdContent));
    const { mockUpdate } = mockDbCalls();
    mockCreateVersion.mockResolvedValue({ id: "version-1" });

    await requestPrdChangesHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockDownloadArtifactFile).toHaveBeenCalledWith(
      loop.s3StateKey,
      "prd.md"
    );
    expect(mockCreateVersion).toHaveBeenCalledWith(
      "artifact-123",
      null,
      prdContent
    );
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "artifact-123", organizationId: "org-1" },
      data: { status: ArtifactStatus.Draft },
      select: {
        id: true,
        organizationId: true,
        slug: true,
        type: true,
        latestVersion: true,
      },
    });
  });

  it("updates artifact status to DRAFT and resets room when slug is present", async () => {
    const loop = buildRequestPrdChangesLoop();
    mockDownloadArtifactFile.mockResolvedValue(Buffer.from("# PRD content"));
    const { mockUpdate } = mockDbCalls(ArtifactType.Prd, "my-prd-slug");
    mockCreateVersion.mockResolvedValue({ id: "version-1" });

    await requestPrdChangesHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: ArtifactStatus.Draft },
      })
    );
    expect(mockResetArtifactRoom).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "my-prd-slug" })
    );
  });

  it("does not reset room when artifact has no slug", async () => {
    const loop = buildRequestPrdChangesLoop();
    mockDownloadArtifactFile.mockResolvedValue(Buffer.from("# PRD content"));
    mockDbCalls(ArtifactType.Prd, null);
    mockCreateVersion.mockResolvedValue({ id: "version-1" });

    await requestPrdChangesHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockResetArtifactRoom).not.toHaveBeenCalled();
  });

  it("throws when invoked with a non-PRD artifact type", async () => {
    const loop = buildRequestPrdChangesLoop();
    mockDownloadArtifactFile.mockResolvedValue(Buffer.from("# PRD content"));
    mockDbCalls(ArtifactType.ImplementationPlan);
    mockCreateVersion.mockResolvedValue({ id: "version-1" });

    await expect(
      requestPrdChangesHandler.downloadAndIngest(
        loop.s3StateKey!,
        loop,
        "org-1"
      )
    ).rejects.toThrow(
      `[request-prd-changes] Expected artifact type ${ArtifactType.Prd}`
    );
  });
});
