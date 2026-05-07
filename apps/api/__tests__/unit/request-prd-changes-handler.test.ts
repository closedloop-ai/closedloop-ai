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
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PULL_REQUEST: "PULL_REQUEST",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    createVersion: vi.fn(),
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/app/documents/room-utils", () => ({
  resetDocumentRoom: vi.fn(),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadArtifactFile: vi.fn(),
}));

// --- Imports (after mocks) ---

import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { LoopCommand } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it } from "vitest";
import { documentVersionService } from "@/app/documents/document-version-service";
import { resetDocumentRoom } from "@/app/documents/room-utils";
import { requestPrdChangesHandler } from "@/lib/loops/loop-commands/generate-prd-handler";
import { downloadArtifactFile } from "@/lib/loops/loop-state";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;
const mockCreateVersion = documentVersionService.createVersion as MockFn;
const mockResetArtifactRoom = resetDocumentRoom as MockFn;
const mockDownloadArtifactFile = downloadArtifactFile as MockFn;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequestPrdChangesLoop() {
  return buildLoop({
    command: LoopCommand.RequestPrdChanges,
    documentId: "artifact-123",
    s3StateKey: "org/loops/loop-1/run-1",
  });
}

function mockDbCalls(
  artifactSubtype: string | null = DocumentType.Prd,
  slug: string | null = "test-slug"
) {
  const mockFindUnique = vi
    .fn()
    .mockResolvedValue(
      artifactSubtype === null ? null : { subtype: artifactSubtype }
    );
  const mockUpdate = vi.fn().mockResolvedValue({
    id: "artifact-123",
    organizationId: "org-1",
    slug,
    subtype: DocumentType.Prd,
    document: { latestVersion: 2 },
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
      "org-1",
      null,
      prdContent
    );
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "artifact-123", organizationId: "org-1", type: "DOCUMENT" },
      data: { status: DocumentStatus.Draft },
      select: {
        id: true,
        organizationId: true,
        slug: true,
        subtype: true,
        document: { select: { latestVersion: true } },
      },
    });
  });

  it("updates artifact status to DRAFT and resets room when slug is present", async () => {
    const loop = buildRequestPrdChangesLoop();
    mockDownloadArtifactFile.mockResolvedValue(Buffer.from("# PRD content"));
    const { mockUpdate } = mockDbCalls(DocumentType.Prd, "my-prd-slug");
    mockCreateVersion.mockResolvedValue({ id: "version-1" });

    await requestPrdChangesHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: DocumentStatus.Draft },
      })
    );
    expect(mockResetArtifactRoom).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "my-prd-slug" })
    );
  });

  it("does not reset room when artifact has no slug", async () => {
    const loop = buildRequestPrdChangesLoop();
    mockDownloadArtifactFile.mockResolvedValue(Buffer.from("# PRD content"));
    mockDbCalls(DocumentType.Prd, null);
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
    mockDbCalls(DocumentType.ImplementationPlan);
    mockCreateVersion.mockResolvedValue({ id: "version-1" });

    await expect(
      requestPrdChangesHandler.downloadAndIngest(
        loop.s3StateKey!,
        loop,
        "org-1"
      )
    ).rejects.toThrow(
      `[request-prd-changes] Expected artifact type ${DocumentType.Prd}`
    );
  });
});
