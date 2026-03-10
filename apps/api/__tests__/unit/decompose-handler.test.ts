/**
 * Unit tests for the DECOMPOSE command handler.
 *
 * Tests the ingestion logic: creating Issues from features.json,
 * linking them to the source PRD, priority mapping, and guard clauses.
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), {
    tx: vi.fn((fn: () => Promise<unknown>) => fn()),
  }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/artifacts/service", () => ({
  artifactsService: {
    findByIdSimple: vi.fn(),
  },
}));

vi.mock("@/app/issues/service", () => ({
  issuesService: {
    create: vi.fn(),
  },
}));

vi.mock("@/app/entity-links/service", () => ({
  entityLinksService: {
    createLink: vi.fn(),
  },
}));

vi.mock("@/lib/loops/loop-artifact-ingestion", () => ({
  parseJsonArtifact: vi.fn(),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadArtifactFile: vi.fn(),
}));

// --- Imports (after mocks) ---

import { Priority } from "@repo/api/src/types/common";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { IssueStatus } from "@repo/api/src/types/issue";
import type { DecomposeResult } from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/database/generated/client";
import { beforeEach, describe, expect, it } from "vitest";
import { artifactsService } from "@/app/artifacts/service";
import { entityLinksService } from "@/app/entity-links/service";
import { issuesService } from "@/app/issues/service";
import { parseJsonArtifact } from "@/lib/loops/loop-artifact-ingestion";
import { decomposeHandler } from "@/lib/loops/loop-commands/decompose-handler";
import { downloadArtifactFile } from "@/lib/loops/loop-state";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;
const mockArtifactsService = artifactsService as unknown as {
  findByIdSimple: MockFn;
};
const mockIssuesService = issuesService as unknown as { create: MockFn };
const mockEntityLinksService = entityLinksService as unknown as {
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
    artifactId: "prd-artifact-1",
  });
}

// ---------------------------------------------------------------------------
// Ingestion logic
// ---------------------------------------------------------------------------

describe("decomposeHandler ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates Issues and EntityLinks for each feature", async () => {
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
    mockArtifactsService.findByIdSimple.mockResolvedValue({
      id: "prd-artifact-1",
      projectId: "project-1",
    });
    mockIssuesService.create
      .mockResolvedValueOnce({ id: "issue-1" })
      .mockResolvedValueOnce({ id: "issue-2" });
    mockEntityLinksService.createLink.mockResolvedValue({ id: "link-1" });

    await decomposeHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    // Creates one issue per feature with correct priority mapping
    expect(mockIssuesService.create).toHaveBeenCalledTimes(2);
    expect(mockIssuesService.create).toHaveBeenCalledWith("org-1", "user-1", {
      projectId: "project-1",
      title: "User Registration Flow",
      description:
        "Users can register with email and password.\n\n## User Stories\n\n### US-001: As a user, I want to register with my email so that I can access the platform\n\n- **AC-001.1:** User can register with valid email",
      priority: Priority.High,
      status: IssueStatus.NotStarted,
    });

    // Links each issue to the PRD via PRODUCES
    expect(mockEntityLinksService.createLink).toHaveBeenCalledTimes(2);
    expect(mockEntityLinksService.createLink).toHaveBeenCalledWith("org-1", {
      sourceId: "prd-artifact-1",
      sourceType: EntityType.Artifact,
      targetId: "issue-1",
      targetType: EntityType.Issue,
      linkType: LinkType.Produces,
    });
  });

  it("skips ingestion when features array is empty", async () => {
    const loop = buildDecomposeLoop();
    setupDownload({ features: [] });

    await decomposeHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    expect(mockArtifactsService.findByIdSimple).not.toHaveBeenCalled();
    expect(mockIssuesService.create).not.toHaveBeenCalled();
  });

  it("skips ingestion when PRD has no projectId", async () => {
    const loop = buildDecomposeLoop();
    setupDownload({
      features: [{ title: "F1", description: "desc" }],
    });
    mockArtifactsService.findByIdSimple.mockResolvedValue({
      id: "prd-artifact-1",
      projectId: null,
    });

    await decomposeHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    expect(mockIssuesService.create).not.toHaveBeenCalled();
  });

  it("defaults priority to MEDIUM when not specified", async () => {
    const loop = buildDecomposeLoop();
    setupDownload({
      features: [{ title: "No Priority", description: "desc" }],
    });
    mockArtifactsService.findByIdSimple.mockResolvedValue({
      id: "prd-artifact-1",
      projectId: "project-1",
    });
    mockIssuesService.create.mockResolvedValue({ id: "issue-1" });
    mockEntityLinksService.createLink.mockResolvedValue({ id: "link-1" });

    await decomposeHandler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

    expect(mockIssuesService.create).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({ priority: Priority.Medium })
    );
  });
});
