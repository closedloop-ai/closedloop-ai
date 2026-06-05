/**
 * Unit tests for the GENERATE_PRD command handler.
 *
 * Tests the ingestion logic: creating artifact versions from prd.md,
 * updating artifact status to DRAFT, resetting Liveblocks rooms,
 * creating workstream events, and guard clauses.
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => Promise<unknown>) =>
      fn({
        artifact: { update: vi.fn() },
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

import type { Loop } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it } from "vitest";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { resetArtifactRoom } from "@/app/artifacts/room-utils";
import { generatePrdHandler } from "@/lib/loops/loop-commands/generate-prd-handler";
import { downloadArtifactFile } from "@/lib/loops/loop-state";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;
const mockCreateVersion = artifactVersionService.createVersion as MockFn;
const mockResetArtifactRoom = resetArtifactRoom as MockFn;
const mockDownloadArtifactFile = downloadArtifactFile as MockFn;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGeneratePrdLoop(overrides: Partial<Loop> = {}) {
  return buildLoop({
    command: "GENERATE_PRD",
    s3StateKey: "org/loops/loop-1/run-1",
    artifactId: "prd-artifact-1",
    ...overrides,
  });
}

function mockDbUpdate(slug: string | null = "test-slug") {
  const mockUpdate = vi.fn().mockResolvedValue({
    id: "prd-artifact-1",
    organizationId: "org-1",
    slug,
    type: "PRD",
    latestVersion: 2,
  });
  const mockFindFirst = vi.fn().mockResolvedValue(null);
  const mockCreate = vi.fn().mockResolvedValue({ id: "event-1" });

  (withDb as unknown as MockFn).mockImplementation(
    (fn: (db: unknown) => Promise<unknown>) =>
      fn({
        artifact: { update: mockUpdate },
        workstreamEvent: { findFirst: mockFindFirst, create: mockCreate },
      })
  );

  return { mockUpdate, mockFindFirst, mockCreate };
}

// ---------------------------------------------------------------------------
// Handler shape
// ---------------------------------------------------------------------------

describe("generatePrdHandler", () => {
  it("has correct handler configuration", () => {
    expect(generatePrdHandler.requiresRepo).toBe(true);
    expect(generatePrdHandler.requiresParent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ingestion logic
// ---------------------------------------------------------------------------

describe("generatePrdHandler ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates artifact version and updates status to DRAFT", async () => {
    const loop = buildGeneratePrdLoop();
    const prdContent = "# PRD\n\n## Overview\n\nThis is a test PRD.";
    mockDownloadArtifactFile.mockResolvedValue(Buffer.from(prdContent));
    const { mockUpdate } = mockDbUpdate();
    mockCreateVersion.mockResolvedValue({ id: "version-1" });

    await generatePrdHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    expect(mockCreateVersion).toHaveBeenCalledWith(
      "prd-artifact-1",
      null,
      prdContent
    );
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "prd-artifact-1", organizationId: "org-1" },
      data: { status: "DRAFT" },
      select: {
        id: true,
        organizationId: true,
        slug: true,
        type: true,
        latestVersion: true,
      },
    });
  });

  it("resets Liveblocks room when artifact has a slug", async () => {
    const loop = buildGeneratePrdLoop();
    mockDownloadArtifactFile.mockResolvedValue(Buffer.from("# PRD content"));
    mockDbUpdate("my-prd-slug");
    mockCreateVersion.mockResolvedValue({ id: "version-1" });

    await generatePrdHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    expect(mockResetArtifactRoom).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "my-prd-slug" })
    );
  });

  it("does not reset Liveblocks room when artifact has no slug", async () => {
    const loop = buildGeneratePrdLoop();
    mockDownloadArtifactFile.mockResolvedValue(Buffer.from("# PRD content"));
    mockDbUpdate(null);
    mockCreateVersion.mockResolvedValue({ id: "version-1" });

    await generatePrdHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    expect(mockResetArtifactRoom).not.toHaveBeenCalled();
  });

  it("creates workstream completion event when workstreamId exists", async () => {
    const loop = buildGeneratePrdLoop({ workstreamId: "ws-1" });
    mockDownloadArtifactFile.mockResolvedValue(Buffer.from("# PRD content"));
    const { mockCreate } = mockDbUpdate();
    mockCreateVersion.mockResolvedValue({ id: "version-1" });

    await generatePrdHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workstreamId: "ws-1",
        type: "LOOP_COMPLETED",
        actorType: "system",
        data: expect.objectContaining({
          loopId: loop.id,
          artifactId: "prd-artifact-1",
          command: "GENERATE_PRD",
          conclusion: "success",
        }),
      }),
    });
  });

  it("skips workstream event when no workstreamId", async () => {
    const loop = buildGeneratePrdLoop({ workstreamId: null });
    mockDownloadArtifactFile.mockResolvedValue(Buffer.from("# PRD content"));
    const { mockCreate } = mockDbUpdate();
    mockCreateVersion.mockResolvedValue({ id: "version-1" });

    await generatePrdHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("skips ingestion when no artifactId", async () => {
    const loop = buildGeneratePrdLoop({ artifactId: null });
    mockDownloadArtifactFile.mockResolvedValue(Buffer.from("# PRD content"));

    await generatePrdHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    expect(mockCreateVersion).not.toHaveBeenCalled();
  });

  it("skips ingestion when prd.md is not found", async () => {
    const loop = buildGeneratePrdLoop();
    mockDownloadArtifactFile.mockResolvedValue(null);

    await generatePrdHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    expect(mockCreateVersion).not.toHaveBeenCalled();
  });

  it("ingests from uploaded artifacts (desktop path)", async () => {
    const loop = buildGeneratePrdLoop();
    const uploaded = { prd: { content: "# Uploaded PRD" } };
    mockDbUpdate();
    mockCreateVersion.mockResolvedValue({ id: "version-1" });

    await generatePrdHandler.uploadAndIngest(uploaded, loop, "org-1");

    expect(mockCreateVersion).toHaveBeenCalledWith(
      "prd-artifact-1",
      null,
      "# Uploaded PRD"
    );
  });

  it("handles upload with missing prd field gracefully", async () => {
    const loop = buildGeneratePrdLoop();
    const uploaded = {};

    await generatePrdHandler.uploadAndIngest(uploaded, loop, "org-1");

    expect(mockCreateVersion).not.toHaveBeenCalled();
  });
});
