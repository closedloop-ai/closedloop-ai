import { BranchTagAvailability } from "@repo/api/src/types/branch";
import { TagColor } from "@repo/api/src/types/tag";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return {
    ...actual,
    getSinglePullRequestWithProviderResult: vi.fn(),
  };
});

import {
  branchId,
  createMockDb,
  makeBranchRow,
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

describe("branchReadService generic Artifact-tag projection", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);
  });

  it("projects canonical Artifact identity, scoped tags, availability, and permissions", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        tagArtifacts: [
          tagRelation("tag-1", "backend", organizationId),
          tagRelation("tag-2", "backend", organizationId),
          tagRelation("tag-foreign", "foreign", "org-2"),
        ],
      }),
    ]);

    const response = await branchReadService.listBranches(
      organizationId,
      { limit: 10, offset: 0 },
      { canApply: true, canRemove: false }
    );

    expect(response.items[0]).toMatchObject({
      id: branchId,
      artifactId: branchId,
      tagAvailability: BranchTagAvailability.Available,
      tagPermissions: { canApply: true, canRemove: false },
      tags: [
        { id: "tag-1", name: "backend", color: TagColor.Blue },
        { id: "tag-2", name: "backend", color: TagColor.Blue },
      ],
    });
    expect(mockDb.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId }),
        select: expect.objectContaining({
          id: true,
          organizationId: true,
          tagArtifacts: expect.objectContaining({
            orderBy: { tagId: "asc" },
            where: { tag: { organizationId } },
          }),
        }),
      })
    );
  });

  it("emits a loaded empty tag set and omits unknown permissions", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ tagArtifacts: [] }),
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    expect(response.items[0]).toMatchObject({
      artifactId: branchId,
      tagAvailability: BranchTagAvailability.Available,
      tags: [],
    });
    expect(response.items[0]?.tagPermissions).toBeUndefined();
  });

  it("filters tags against the caller organization when a malformed row claims another organization", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        organizationId: "org-foreign",
        tagArtifacts: [tagRelation("tag-foreign", "foreign", "org-foreign")],
      }),
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    expect(response.items[0]?.tags).toEqual([]);
  });

  it("carries the same canonical tag contract through Branch detail reads", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        tagArtifacts: [tagRelation("tag-1", "backend", organizationId)],
      })
    );

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId,
      { canApply: false, canRemove: true }
    );

    expect(detail).toMatchObject({
      id: branchId,
      artifactId: branchId,
      tagAvailability: BranchTagAvailability.Available,
      tagPermissions: { canApply: false, canRemove: true },
      tags: [{ id: "tag-1", name: "backend", color: TagColor.Blue }],
    });
    expect(mockDb.artifact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId }),
        select: expect.objectContaining({
          tagArtifacts: expect.objectContaining({
            where: { tag: { organizationId } },
          }),
        }),
      })
    );
  });

  it("preserves authenticated tag permissions on early refresh responses", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ currentPullRequestDetail: null })
    );

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      {
        userId: "user-1",
        authMethod: "session",
        tagPermissions: { canApply: true, canRemove: false },
      }
    );

    expect(response.branch?.tagPermissions).toEqual({
      canApply: true,
      canRemove: false,
    });
  });
});

function tagRelation(id: string, name: string, relationOrganizationId: string) {
  return {
    tag: {
      id,
      name,
      color: TagColor.Blue,
      organizationId: relationOrganizationId,
    },
  };
}
