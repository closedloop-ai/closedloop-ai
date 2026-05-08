import { ArtifactType } from "@repo/api/src/types/artifact";
import { vi } from "vitest";
import { mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { DbNull: "DbNull" },
}));

import { artifactLinksService } from "@/app/artifact-links/service";

const ORG_ID = "org-1";
const TARGET_PROJECT_ID = "project-target";

// findDownstreamArtifactIds is covered in artifact-links-service.test.ts.
// Here we only exercise batchMoveArtifacts and stub the downstream call.

describe("artifactLinksService.batchMoveArtifacts", () => {
  let findDownstreamSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    findDownstreamSpy = vi.spyOn(
      artifactLinksService,
      "findDownstreamArtifactIds"
    );
  });

  afterEach(() => {
    findDownstreamSpy.mockRestore();
  });

  /**
   * Compose a single tx mock covering both the validation reads (artifact +
   * project findFirst/findUnique) and the move writes (findMany/updateMany).
   * The service now runs all of these inside a single withDb.tx so the
   * snapshot stays consistent across validation and mutation.
   */
  function setupTx(options: {
    sourceFound: boolean;
    sourceType?: ArtifactType;
    projectFound: boolean;
    rows?: { id: string; type: ArtifactType }[];
  }) {
    const rows = options.rows ?? [];
    const mockTx = {
      artifact: {
        findFirst: vi.fn().mockResolvedValue(
          options.sourceFound
            ? {
                id: "root-artifact",
                type: options.sourceType ?? ArtifactType.Document,
              }
            : null
        ),
        findMany: vi.fn().mockResolvedValue(rows),
        updateMany: vi.fn().mockResolvedValue({ count: rows.length }),
      },
      project: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            options.projectFound ? { id: TARGET_PROJECT_ID } : null
          ),
      },
    };
    mockWithDbTx(mockTx);
    return mockTx;
  }

  it("moves a single artifact without downstream", async () => {
    setupTx({
      sourceFound: true,
      projectFound: true,
      rows: [{ id: "root-artifact", type: ArtifactType.Document }],
    });

    const result = await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "root-artifact",
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: false,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        movedArtifacts: [{ id: "root-artifact", type: ArtifactType.Document }],
      },
    });
    expect(findDownstreamSpy).not.toHaveBeenCalled();
  });

  it("moves downstream when includeDownstream is true", async () => {
    setupTx({
      sourceFound: true,
      projectFound: true,
      rows: [
        { id: "root-artifact", type: ArtifactType.Document },
        { id: "child-1", type: ArtifactType.Document },
        { id: "child-2", type: ArtifactType.PullRequest },
      ],
    });
    findDownstreamSpy.mockResolvedValueOnce(["child-1", "child-2"]);

    const result = await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "root-artifact",
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: true,
    });

    expect(findDownstreamSpy).toHaveBeenCalledWith(ORG_ID, "root-artifact");
    expect(result).toEqual({
      ok: true,
      value: {
        movedArtifacts: [
          { id: "root-artifact", type: ArtifactType.Document },
          { id: "child-1", type: ArtifactType.Document },
          { id: "child-2", type: ArtifactType.PullRequest },
        ],
      },
    });
  });

  it("returns NotFound when source artifact does not exist in org", async () => {
    setupTx({ sourceFound: false, projectFound: true });

    const result = await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "missing-artifact",
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: false,
    });

    expect(result).toEqual({ ok: false, error: 404 });
  });

  it("returns BadRequest when target project does not exist", async () => {
    setupTx({ sourceFound: true, projectFound: false });

    const result = await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "root-artifact",
      targetProjectId: "nonexistent-project",
      includeDownstream: false,
    });

    expect(result).toEqual({ ok: false, error: 400 });
  });

  it("returns NotFound when zero rows are actually updated", async () => {
    setupTx({ sourceFound: true, projectFound: true, rows: [] });
    findDownstreamSpy.mockResolvedValueOnce([]);

    const result = await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "root-artifact",
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: false,
    });

    expect(result).toEqual({ ok: false, error: 404 });
  });

  it("issues a single updateMany covering all artifact ids", async () => {
    const mockTx = setupTx({
      sourceFound: true,
      projectFound: true,
      rows: [
        { id: "root-artifact", type: ArtifactType.Document },
        { id: "child-1", type: ArtifactType.Document },
        { id: "child-2", type: ArtifactType.PullRequest },
      ],
    });
    findDownstreamSpy.mockResolvedValueOnce(["child-1", "child-2"]);

    await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "root-artifact",
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: true,
    });

    // All artifacts move in a single updateMany call on the unified table.
    expect(mockTx.artifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["root-artifact", "child-1", "child-2"] },
        organizationId: ORG_ID,
      },
      data: { projectId: TARGET_PROJECT_ID },
    });
  });
});
