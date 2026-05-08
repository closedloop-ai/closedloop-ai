/**
 * Unit tests for the DECOMPOSE command handler.
 *
 * Tests the ingestion logic: creating Features from features.json,
 * linking them to the source PRD, priority mapping, and guard clauses.
 */

import { vi } from "vitest";
import { documentService } from "@/app/documents/document-service";

// --- Mocks (must come before imports) ---

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), {
    tx: vi.fn((fn: () => Promise<unknown>) => fn()),
  }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    findByIdSimple: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("@/app/artifact-links/service", () => ({
  artifactLinksService: {
    createLink: vi.fn(),
  },
}));

vi.mock("@/lib/loops/loop-document-ingestion", () => ({
  parseJsonArtifact: vi.fn(),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadArtifactFile: vi.fn(),
}));

// --- Imports (after mocks) ---

import { LinkType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type { DecomposeResult } from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/database/generated/client";
import { beforeEach, describe, expect, it } from "vitest";
import { artifactLinksService } from "@/app/artifact-links/service";

import { decomposeHandler } from "@/lib/loops/loop-commands/decompose-handler";
import { parseJsonArtifact } from "@/lib/loops/loop-document-ingestion";
import { downloadArtifactFile } from "@/lib/loops/loop-state";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;
const mockDocumentsService = documentService as unknown as {
  findByIdSimple: MockFn;
  create: MockFn;
};
const mockEntityLinksService = artifactLinksService as unknown as {
  createLink: MockFn;
};
const mockParseJsonArtifact = parseJsonArtifact as MockFn;
const mockDownloadArtifactFile = downloadArtifactFile as MockFn;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDownload(result: DecomposeResult | null) {
  mockDownloadArtifactFile.mockResolvedValue(result ? Buffer.from("{}") : null);
  mockParseJsonArtifact.mockReturnValue(result);
}

function buildDecomposeLoop() {
  return buildLoop({
    command: LoopCommand.DECOMPOSE,
    s3StateKey: "org/loops/loop-1/run-1",
    documentId: "prd-artifact-1",
  });
}

// ---------------------------------------------------------------------------
// Ingestion logic
// ---------------------------------------------------------------------------

describe("decomposeHandler ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates Features and EntityLinks for each feature", async () => {
    const loop = buildDecomposeLoop();
    const result: DecomposeResult = {
      features: [
        {
          title: "User Registration Flow",
          description: "Users can register with email and password.",
          priority: "HIGH",
          userStories: [
            {
              id: "US-001",
              story:
                "As a user, I want to register with my email so that I can access the platform",
              acceptanceCriteria: [
                {
                  id: "AC-001.1",
                  criterion: "User can register with valid email",
                },
              ],
            },
          ],
        },
        {
          title: "Dashboard View",
          description: "Managers can view team metrics.",
          priority: "LOW",
          userStories: [
            {
              id: "US-002",
              story:
                "As a manager, I want to view team metrics so that I can track performance",
              acceptanceCriteria: [
                {
                  id: "AC-002.1",
                  criterion: "Dashboard loads within 2 seconds",
                },
              ],
            },
          ],
        },
      ],
    };

    setupDownload(result);
    mockDocumentsService.findByIdSimple.mockResolvedValue({
      id: "prd-artifact-1",
      projectId: "project-1",
    });
    mockDocumentsService.create
      .mockResolvedValueOnce({ id: "feature-1" })
      .mockResolvedValueOnce({ id: "feature-2" });
    mockEntityLinksService.createLink.mockResolvedValue({ id: "link-1" });

    await decomposeHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    // Creates one feature per decompose entry with correct priority mapping
    expect(mockDocumentsService.create).toHaveBeenCalledTimes(2);
    expect(mockDocumentsService.create).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      {
        projectId: "project-1",
        type: DocumentType.Feature,
        title: "User Registration Flow",
        content:
          "Users can register with email and password.\n\n## User Stories\n\n### US-001: As a user, I want to register with my email so that I can access the platform\n\n- **AC-001.1:** User can register with valid email",
        priority: Priority.High,
        status: DocumentStatus.Draft,
      }
    );

    // Links each feature to the PRD via PRODUCES
    expect(mockEntityLinksService.createLink).toHaveBeenCalledTimes(2);
    expect(mockEntityLinksService.createLink).toHaveBeenCalledWith("org-1", {
      sourceId: "prd-artifact-1",
      targetId: "feature-1",
      linkType: LinkType.Produces,
    });
  });

  it("skips ingestion when features array is empty", async () => {
    const loop = buildDecomposeLoop();
    setupDownload({ features: [] });

    await decomposeHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    expect(mockDocumentsService.findByIdSimple).not.toHaveBeenCalled();
    expect(mockDocumentsService.create).not.toHaveBeenCalled();
  });

  it("skips ingestion when PRD has no projectId", async () => {
    const loop = buildDecomposeLoop();
    setupDownload({
      features: [{ title: "F1", description: "desc" }],
    });
    mockDocumentsService.findByIdSimple.mockResolvedValue({
      id: "prd-artifact-1",
      projectId: null,
    });

    await decomposeHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    expect(mockDocumentsService.create).not.toHaveBeenCalled();
  });

  it("defaults priority to MEDIUM when not specified", async () => {
    const loop = buildDecomposeLoop();
    setupDownload({
      features: [{ title: "No Priority", description: "desc" }],
    });
    mockDocumentsService.findByIdSimple.mockResolvedValue({
      id: "prd-artifact-1",
      projectId: "project-1",
    });
    mockDocumentsService.create.mockResolvedValue({ id: "feature-1" });
    mockEntityLinksService.createLink.mockResolvedValue({ id: "link-1" });

    await decomposeHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    expect(mockDocumentsService.create).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({ priority: Priority.Medium })
    );
  });
});

// ---------------------------------------------------------------------------
// Upload-based ingestion (desktop path)
// ---------------------------------------------------------------------------

describe("decomposeHandler uploadAndIngest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ingests from uploaded artifacts (desktop path)", async () => {
    const loop = buildDecomposeLoop();
    const uploaded = {
      features: {
        features: [
          { title: "Feature A", description: "desc A", priority: "HIGH" },
        ],
      },
    };
    mockDocumentsService.findByIdSimple.mockResolvedValue({
      id: "prd-artifact-1",
      projectId: "project-1",
    });
    mockDocumentsService.create.mockResolvedValue({ id: "feature-1" });
    mockEntityLinksService.createLink.mockResolvedValue({ id: "link-1" });

    await decomposeHandler.uploadAndIngest(uploaded, loop, "org-1");

    expect(mockDocumentsService.create).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      {
        projectId: "project-1",
        title: "Feature A",
        type: DocumentType.Feature,
        content: "desc A",
        priority: Priority.High,
        status: DocumentStatus.Draft,
      }
    );
    expect(mockEntityLinksService.createLink).toHaveBeenCalledWith("org-1", {
      sourceId: "prd-artifact-1",
      targetId: "feature-1",
      linkType: LinkType.Produces,
    });
  });

  it("handles upload with missing features field gracefully", async () => {
    const loop = buildDecomposeLoop();

    await decomposeHandler.uploadAndIngest({}, loop, "org-1");

    expect(mockDocumentsService.create).not.toHaveBeenCalled();
  });

  it("handles upload with invalid schema gracefully", async () => {
    const loop = buildDecomposeLoop();
    const uploaded = { features: { features: "not-an-array" } };

    await decomposeHandler.uploadAndIngest(uploaded, loop, "org-1");

    expect(mockDocumentsService.create).not.toHaveBeenCalled();
  });
});
