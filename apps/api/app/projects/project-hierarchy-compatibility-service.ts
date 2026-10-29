import { createHash } from "node:crypto";
import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import type { ArtifactStatus } from "@repo/api/src/types/document";
import {
  ProjectArtifactPlacementErrorReason,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  type ProjectArtifactPlacementRequest,
  type ProjectArtifactPlacementResponse,
  type ProjectArtifactPlacementRootUpdates,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectHierarchyOperation,
  ProjectHierarchyPlacement,
  ProjectHierarchySource,
  type ProjectHierarchyTransactionRequest,
  type ProjectHierarchyTransactionResponse,
} from "@repo/api/src/types/project-hierarchy-transaction";
import { Result, Status } from "@repo/api/src/types/result";
import {
  type PlacementActor,
  type PlacementError,
  projectArtifactPlacementService,
} from "@/app/documents/project-artifact-placement-service";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/** Keep the flag-off hierarchy wire contract on the consolidated placement writer. */
export const projectHierarchyCompatibilityService = {
  async getRevision(
    projectId: string,
    organizationId: string,
    actor: PlacementActor,
    snapshot: "new" | "current" = "new"
  ) {
    const state = await projectArtifactPlacementService[
      snapshot === "current"
        ? "getProjectPlacementStateInCurrentTransaction"
        : "getProjectPlacementState"
    ](projectId, organizationId, actor, true);
    return state ? { projectId, revision: state.projectVersion } : null;
  },
  async transact(
    projectId: string,
    organizationId: string,
    actor: PlacementActor,
    input: ProjectHierarchyTransactionRequest,
    recordPlaced?: RecordWriteInTransaction<ProjectArtifactPlacementResponse>
  ): Promise<Result<ProjectHierarchyTransactionResponse, PlacementError>> {
    const destinationProjectId =
      input.operation === ProjectHierarchyOperation.Move
        ? (input.targetProjectId ?? projectId)
        : projectId;
    const expectedProjectIds = [
      ...new Set([projectId, destinationProjectId]),
    ].sort();
    const receivedProjectIds = input.expectedRevisions
      .map((revision) => revision.projectId)
      .sort();
    if (
      input.operation === ProjectHierarchyOperation.Move &&
      (expectedProjectIds.length !== receivedProjectIds.length ||
        expectedProjectIds.some(
          (id, index) => id !== receivedProjectIds[index]
        ))
    ) {
      return Result.err(
        invalidRequest(
          "Revisions must name exactly the source and destination projects"
        )
      );
    }
    if (
      input.operation === ProjectHierarchyOperation.Move &&
      destinationProjectId !== projectId &&
      input.parentArtifactId
    ) {
      return Result.err(
        invalidRequest(
          "A cross-project move must promote the selected subtrees to roots"
        )
      );
    }
    const placementInput = placementRequest(input, destinationProjectId);
    const result = await projectArtifactPlacementService.placeProjectArtifacts(
      projectId,
      organizationId,
      placementInput,
      actor,
      {
        includeAllTypes: true,
        recordPlaced,
        requestHash: createHash("sha256")
          .update(stableStringify({ projectId, input }))
          .digest("hex"),
        ...(input.operation === ProjectHierarchyOperation.Move &&
        (input.placement === ProjectHierarchyPlacement.Start ||
          input.placement === ProjectHierarchyPlacement.End)
          ? {
              rootInsertion:
                input.placement === ProjectHierarchyPlacement.Start
                  ? ("start" as const)
                  : ("end" as const),
              rootParentArtifactId: input.parentArtifactId ?? null,
            }
          : {}),
      }
    );
    return result.ok
      ? Result.ok(hierarchyResponse(result.value))
      : Result.err(result.error);
  },
};

function placementRequest(
  input: ProjectHierarchyTransactionRequest,
  destinationProjectId: string
): ProjectArtifactPlacementRequest {
  const expectedProjectVersions = Object.fromEntries(
    input.expectedRevisions.map(({ projectId, revision }) => [
      projectId,
      revision,
    ])
  );
  if (input.operation === ProjectHierarchyOperation.Undo) {
    return {
      kind: ProjectArtifactPlacementKind.Undo,
      undoOfTransactionId: input.transactionId,
      expectedProjectVersions,
      idempotencyKey: input.idempotencyKey,
      source: ProjectArtifactPlacementSource.Undo,
    };
  }
  const position =
    input.placement === ProjectHierarchyPlacement.Start ||
    input.placement === ProjectHierarchyPlacement.End
      ? ProjectArtifactPlacementPosition.Root
      : input.placement;
  const rootUpdates: ProjectArtifactPlacementRootUpdates | undefined =
    input.rootUpdates
      ? {
          ...(input.rootUpdates.status
            ? { status: input.rootUpdates.status as ArtifactStatus }
            : {}),
          ...(input.rootUpdates.assigneeId === undefined
            ? {}
            : { assigneeId: input.rootUpdates.assigneeId }),
          ...(input.rootUpdates.priority === undefined
            ? {}
            : { priority: input.rootUpdates.priority }),
          ...(input.rootUpdates.tagIds
            ? { tagIds: input.rootUpdates.tagIds }
            : {}),
        }
      : undefined;
  return {
    kind: ProjectArtifactPlacementKind.Place,
    sourceArtifactIds: input.artifactIds,
    destinationProjectId,
    position,
    ...(input.targetArtifactId
      ? { targetArtifactId: input.targetArtifactId }
      : {}),
    ...(rootUpdates ? { rootUpdates } : {}),
    ...(input.surface ? { surface: input.surface } : {}),
    expectedProjectVersions,
    idempotencyKey: input.idempotencyKey,
    source: placementSource(input.source),
  };
}

function placementSource(source: ProjectHierarchySource) {
  switch (source) {
    case ProjectHierarchySource.Drag:
      return ProjectArtifactPlacementSource.Pointer;
    case ProjectHierarchySource.Keyboard:
      return ProjectArtifactPlacementSource.Keyboard;
    case ProjectHierarchySource.Menu:
    case ProjectHierarchySource.Api:
      return ProjectArtifactPlacementSource.Api;
    default:
      return source satisfies never;
  }
}

function hierarchyResponse(
  response: ProjectArtifactPlacementResponse
): ProjectHierarchyTransactionResponse {
  return {
    transactionId: response.transactionId,
    changedArtifactIds: response.affectedArtifactIds,
    descendantCount: response.descendantCount ?? 0,
    projectRevisions: Object.entries(response.projectVersions).map(
      ([projectId, revision]) => ({ projectId, revision })
    ),
    inverse: { transactionId: response.transactionId },
    replayed: response.replayed,
  };
}

function invalidRequest(message: string): PlacementError {
  return {
    status: Status.BadRequest,
    message,
    detail: { reason: ProjectArtifactPlacementErrorReason.InvalidRequest },
  };
}
