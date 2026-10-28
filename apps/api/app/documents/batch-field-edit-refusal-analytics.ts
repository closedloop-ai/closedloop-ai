import {
  type ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import type { ArtifactPriorityMutationErrorDetails } from "@repo/api/src/types/artifact-priority-mutation";
import { ArtifactPriorityMutationErrorCode } from "@repo/api/src/types/artifact-priority-mutation";
import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  type BatchItemResult,
} from "@repo/api/src/types/batch-mutation-result";
import type { DocumentStatusMutationErrorDetails } from "@repo/api/src/types/document-status-mutation";
import { DocumentStatusMutationErrorCode } from "@repo/api/src/types/document-status-mutation";
import { Status, type StatusCode } from "@repo/api/src/types/result";
import type { ActivityActor } from "@/lib/artifact-activity-capture";
import { createArtifactFieldEditAnalyticsContext } from "@/lib/artifact-field-edit-analytics-context";

type BatchFieldEditAnalyticsBase = {
  organizationId: string;
  userId: string;
  authMethod: ActivityActor["authMethod"];
  field: ArtifactFieldEditField;
  surface?: ArtifactStatusEditSurface;
  after?: string | null;
};

type BatchFieldEditRefusal = {
  status: StatusCode;
  code: string;
  details?:
    | DocumentStatusMutationErrorDetails
    | ArtifactPriorityMutationErrorDetails;
};

/** Emit one bounded outcome for a whole-batch typed refusal. */
export function emitBatchFieldEditRefusalAnalytics(
  input: BatchFieldEditAnalyticsBase & {
    error: BatchFieldEditRefusal;
  }
): void {
  const result = refusalOutcome(input.error);
  if (result === undefined) {
    return;
  }
  emitOutcome(input, result, refusedArtifactCount(input.error));
}

/** Aggregate v2 item refusals by bounded outcome without emitting record ids. */
export function emitBatchItemFieldEditRefusalAnalytics(
  input: BatchFieldEditAnalyticsBase & {
    results: Iterable<BatchItemResult>;
  }
): void {
  let validationFailures = 0;
  let conflicts = 0;
  for (const result of input.results) {
    if (result.status === BATCH_ITEM_APPLIED_STATUS) {
      continue;
    }
    if (result.code === BatchItemFailureCode.InvalidStatusForSubtype) {
      validationFailures += 1;
    } else if (
      result.code === BatchItemFailureCode.StaleStatus ||
      result.code === BatchItemFailureCode.StalePriority
    ) {
      conflicts += 1;
    }
  }
  if (validationFailures > 0) {
    emitOutcome(
      input,
      ArtifactFieldEditOutcome.ValidationFailed,
      validationFailures
    );
  }
  if (conflicts > 0) {
    emitOutcome(input, ArtifactFieldEditOutcome.Conflict, conflicts);
  }
}

/** Whether a v2 batch contains any refused item. */
export function hasBatchItemFieldEditRefusal(
  results: Iterable<BatchItemResult>
): boolean {
  for (const result of results) {
    if (result.status !== BATCH_ITEM_APPLIED_STATUS) {
      return true;
    }
  }
  return false;
}

function refusalOutcome(error: {
  status: StatusCode;
  code: string;
}): ArtifactFieldEditOutcome | undefined {
  if (
    error.status === Status.Conflict &&
    (error.code === DocumentStatusMutationErrorCode.StaleStatus ||
      error.code === ArtifactPriorityMutationErrorCode.StalePriority)
  ) {
    return ArtifactFieldEditOutcome.Conflict;
  }
  if (
    error.status === Status.BadRequest &&
    error.code === DocumentStatusMutationErrorCode.InvalidStatusForSubtype
  ) {
    return ArtifactFieldEditOutcome.ValidationFailed;
  }
  return undefined;
}

function refusedArtifactCount(
  error: BatchFieldEditRefusal
): number | undefined {
  switch (error.code) {
    case DocumentStatusMutationErrorCode.InvalidStatusForSubtype:
      return detailArrayCount(error.details, "invalidStatuses");
    case DocumentStatusMutationErrorCode.StaleStatus:
      return detailArrayCount(error.details, "staleStatuses");
    case ArtifactPriorityMutationErrorCode.StalePriority:
      return detailArrayCount(error.details, "stalePriorities");
    case DocumentStatusMutationErrorCode.ArtifactsNotFound:
    case DocumentStatusMutationErrorCode.InvalidReference:
      return undefined;
    default:
      return undefined;
  }
}

function detailArrayCount(
  details: BatchFieldEditRefusal["details"],
  key: "invalidStatuses" | "staleStatuses" | "stalePriorities"
): number | undefined {
  const value = details?.[key];
  return Array.isArray(value) ? value.length : undefined;
}

function emitOutcome(
  input: BatchFieldEditAnalyticsBase,
  result: ArtifactFieldEditOutcome,
  artifactCount: number | undefined
): void {
  createArtifactFieldEditAnalyticsContext({
    organizationId: input.organizationId,
    userId: input.userId,
    surface: input.surface,
    authMethod: input.authMethod,
  }).capture({
    field: input.field,
    result,
    ...(artifactCount === undefined ? {} : { artifactCount }),
    ...(input.after === undefined ? {} : { after: input.after }),
  });
}
