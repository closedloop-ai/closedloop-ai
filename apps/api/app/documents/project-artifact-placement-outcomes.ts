import type { ProjectArtifactPlacementResponse } from "@repo/api/src/types/project-artifact-placement";
import {
  PROJECT_ARTIFACT_PLACEMENT_MAX_EXPANDED_ARTIFACTS,
  ProjectArtifactPlacementErrorReason,
} from "@repo/api/src/types/project-artifact-placement";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import type { PlacementActivityReceipt } from "./project-artifact-placement-receipt";
import type { PlacementError } from "./project-artifact-placement-service";

export function placementFailure<T>(
  status: StatusCode,
  message: string,
  reason: ProjectArtifactPlacementErrorReason
): Result<T, PlacementError> {
  return Result.err({ status, message, detail: { reason } });
}

export function expandedArtifactLimitFailure<T>(): Result<T, PlacementError> {
  return placementFailure(
    Status.BadRequest,
    `Placement expands beyond ${PROJECT_ARTIFACT_PLACEMENT_MAX_EXPANDED_ARTIFACTS} artifacts`,
    ProjectArtifactPlacementErrorReason.ExpandedArtifactLimit
  );
}

export function replayCommittedEvent(
  event: PlacementActivityReceipt,
  routeProjectId: string,
  requestHash: string
): Result<ProjectArtifactPlacementResponse, PlacementError> {
  if (
    event.routeProjectId !== routeProjectId ||
    event.requestHash !== requestHash
  ) {
    return placementFailure(
      Status.Conflict,
      "Idempotency key was already used for a different placement",
      ProjectArtifactPlacementErrorReason.IdempotencyMismatch
    );
  }
  return Result.ok({ ...event.response, replayed: true });
}
