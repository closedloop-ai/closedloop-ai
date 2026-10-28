import {
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import {
  type ProjectHierarchyMoveRequest,
  ProjectHierarchyOperation,
  ProjectHierarchyPlacement,
  ProjectHierarchySource,
} from "@repo/api/src/types/project-hierarchy-transaction";
import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProjectPlacementState: vi.fn(),
  getProjectPlacementStateInCurrentTransaction: vi.fn(),
  placeProjectArtifacts: vi.fn(),
}));
vi.mock("@/app/documents/project-artifact-placement-service", () => ({
  projectArtifactPlacementService: mocks,
}));

import { projectHierarchyCompatibilityService } from "../project-hierarchy-compatibility-service";

const organizationId = "00000000-0000-4000-8000-000000000001";
const sourceProjectId = "00000000-0000-4000-8000-000000000002";
const destinationProjectId = "00000000-0000-4000-8000-000000000003";
const firstId = "00000000-0000-4000-8000-000000000004";
const secondId = "00000000-0000-4000-8000-000000000005";
const actor = {
  userId: "00000000-0000-4000-8000-000000000006",
  authMethod: "session" as const,
};

function request(
  overrides: Partial<ProjectHierarchyMoveRequest> = {}
): ProjectHierarchyMoveRequest {
  return {
    operation: ProjectHierarchyOperation.Move,
    artifactIds: [firstId, secondId],
    targetProjectId: destinationProjectId,
    placement: ProjectHierarchyPlacement.Start,
    rootUpdates: { tagIds: [] },
    expectedRevisions: [
      { projectId: sourceProjectId, revision: "source-version" },
      { projectId: destinationProjectId, revision: "destination-version" },
    ],
    idempotencyKey: "00000000-0000-4000-8000-000000000007",
    source: ProjectHierarchySource.Drag,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProjectPlacementState.mockResolvedValue({
    projectVersion: "all-artifact-version",
    canPlaceArtifacts: true,
  });
  mocks.getProjectPlacementStateInCurrentTransaction.mockResolvedValue({
    projectVersion: "snapshot-version",
    canPlaceArtifacts: true,
  });
  mocks.placeProjectArtifacts.mockResolvedValue(
    Result.ok({
      placed: true,
      transactionId: "00000000-0000-4000-8000-000000000008",
      affectedArtifactIds: [firstId, secondId],
      affectedProjectIds: [sourceProjectId, destinationProjectId],
      descendantCount: 1,
      projectVersions: {
        [sourceProjectId]: "next-source",
        [destinationProjectId]: "next-destination",
      },
      placement: {
        sourceArtifactIds: [firstId, secondId],
        destinationProjectId,
        position: ProjectArtifactPlacementPosition.Root,
      },
      replayed: false,
      undoAvailable: true,
    })
  );
});

describe("flag-off hierarchy compatibility transaction", () => {
  it("reads an all-type revision without the manual placement route", async () => {
    const result = await projectHierarchyCompatibilityService.getRevision(
      sourceProjectId,
      organizationId,
      actor
    );
    expect(result).toEqual({
      projectId: sourceProjectId,
      revision: "all-artifact-version",
    });
    expect(mocks.getProjectPlacementState).toHaveBeenCalledWith(
      sourceProjectId,
      organizationId,
      actor,
      true
    );
  });

  it("reads the revision from the caller's current snapshot when requested", async () => {
    const result = await projectHierarchyCompatibilityService.getRevision(
      sourceProjectId,
      organizationId,
      actor,
      "current"
    );
    expect(result).toEqual({
      projectId: sourceProjectId,
      revision: "snapshot-version",
    });
    expect(
      mocks.getProjectPlacementStateInCurrentTransaction
    ).toHaveBeenCalledWith(sourceProjectId, organizationId, actor, true);
    expect(mocks.getProjectPlacementState).not.toHaveBeenCalled();
  });

  it("submits both selected roots, group updates and start edge through one core call", async () => {
    const result = await projectHierarchyCompatibilityService.transact(
      sourceProjectId,
      organizationId,
      actor,
      request()
    );
    expect(result.ok).toBe(true);
    expect(mocks.placeProjectArtifacts).toHaveBeenCalledTimes(1);
    expect(mocks.placeProjectArtifacts).toHaveBeenCalledWith(
      sourceProjectId,
      organizationId,
      expect.objectContaining({
        kind: ProjectArtifactPlacementKind.Place,
        sourceArtifactIds: [firstId, secondId],
        destinationProjectId,
        position: ProjectArtifactPlacementPosition.Root,
        rootUpdates: { tagIds: [] },
        expectedProjectVersions: {
          [sourceProjectId]: "source-version",
          [destinationProjectId]: "destination-version",
        },
        source: ProjectArtifactPlacementSource.Pointer,
      }),
      actor,
      expect.objectContaining({
        includeAllTypes: true,
        rootInsertion: "start",
        rootParentArtifactId: null,
        requestHash: expect.any(String),
      })
    );
    if (!result.ok) {
      throw new Error("Expected a committed selected-set move");
    }
    expect(result.value.descendantCount).toBe(1);
  });

  it("rejects a missing destination revision before any member can commit", async () => {
    const result = await projectHierarchyCompatibilityService.transact(
      sourceProjectId,
      organizationId,
      actor,
      request({
        expectedRevisions: [
          { projectId: sourceProjectId, revision: "source-version" },
        ],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected missing-revision rejection");
    }
    expect(result.error.status).toBe(Status.BadRequest);
    expect(mocks.placeProjectArtifacts).not.toHaveBeenCalled();
  });

  it("rejects cross-project nesting instead of leaving an external parent edge", async () => {
    const result = await projectHierarchyCompatibilityService.transact(
      sourceProjectId,
      organizationId,
      actor,
      request({ parentArtifactId: firstId })
    );
    expect(result.ok).toBe(false);
    expect(mocks.placeProjectArtifacts).not.toHaveBeenCalled();
  });
});
