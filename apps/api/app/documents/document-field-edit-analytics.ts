import { ArtifactStatusCommitResult } from "@repo/api/src/types/artifact-activity";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import type { ArtifactPriorityMutationError } from "@repo/api/src/types/artifact-priority-mutation";
import { ArtifactPriorityMutationErrorCode } from "@repo/api/src/types/artifact-priority-mutation";
import type {
  ArtifactStatusEditSurface,
  ArtifactStatusProvenance,
} from "@repo/api/src/types/artifact-status-contract";
import type { Document } from "@repo/api/src/types/document";
import {
  type DocumentFieldMutationError,
  DocumentFieldMutationErrorCode,
} from "@repo/api/src/types/document-field-mutation";
import {
  type DocumentStatusMutationError,
  DocumentStatusMutationErrorCode,
} from "@repo/api/src/types/document-status-mutation";
import {
  ArtifactPriorityCommitResult,
  isArtifactPriorityEditSurface,
} from "@repo/api/src/types/priority-contract";
import { Status } from "@repo/api/src/types/result";
import { captureArtifactFieldEditAnalytics } from "@/lib/artifact-field-edit-analytics";
import { captureArtifactPriorityChangeAnalytics } from "@/lib/artifact-priority-analytics";
import { captureArtifactStatusChangeAnalytics } from "@/lib/artifact-status-analytics";
import type { ArtifactEditAuthMethod } from "@/lib/artifact-status-provenance";
import type { documentStatusMutationService } from "./document-status-mutation-service";

type DocumentUpdateInput = Parameters<
  typeof documentStatusMutationService.updateDocument
>[2];

type DocumentUpdateRefusal =
  | DocumentStatusMutationError
  | ArtifactPriorityMutationError
  | DocumentFieldMutationError;

type RequestedDocumentField = {
  field: ArtifactFieldEditField;
  after?: string | null;
};

/** Emit one bounded post-commit outcome for every requested document field. */
export function emitDocumentFieldEditAnalytics(params: {
  organizationId: string;
  userId: string;
  provenance: ArtifactStatusProvenance | undefined;
  requested: DocumentUpdateInput;
  previous: Document;
  artifact: Document;
}): void {
  const requestedFields = requestedDocumentFields(params.requested);
  for (const edit of requestedFields) {
    const before = documentFieldValue(params.previous, edit.field);
    const after = documentFieldValue(params.artifact, edit.field);
    captureArtifactFieldEditAnalytics({
      organizationId: params.organizationId,
      userId: params.userId,
      field: edit.field,
      result:
        before === after
          ? ArtifactFieldEditOutcome.NoChange
          : ArtifactFieldEditOutcome.Committed,
      artifactCount: 1,
      before,
      after,
      provenance: params.provenance,
    });
  }
}

/** Emit only the field named by the service's canonical refusal code. */
export function emitDocumentRefusalAnalytics(params: {
  organizationId: string;
  userId: string;
  provenance: ArtifactStatusProvenance | undefined;
  requested: DocumentUpdateInput;
  error: DocumentUpdateRefusal;
}): void {
  if (
    params.error.status !== Status.BadRequest &&
    params.error.status !== Status.Conflict
  ) {
    return;
  }
  const edit = refusedDocumentField(params.requested, params.error);
  if (edit === undefined) {
    return;
  }
  captureArtifactFieldEditAnalytics({
    organizationId: params.organizationId,
    userId: params.userId,
    field: edit.field,
    result:
      params.error.status === Status.Conflict
        ? ArtifactFieldEditOutcome.Conflict
        : ArtifactFieldEditOutcome.ValidationFailed,
    artifactCount: 1,
    provenance: params.provenance,
    ...(edit.after === undefined ? {} : { after: edit.after }),
  });
}

/** Emit one bounded refusal for a composite custom-field payload. */
export function emitDocumentCustomFieldValidationAnalytics(params: {
  organizationId: string;
  userId: string;
  provenance: ArtifactStatusProvenance | undefined;
}): void {
  captureArtifactFieldEditAnalytics({
    organizationId: params.organizationId,
    userId: params.userId,
    field: ArtifactFieldEditField.CustomField,
    result: ArtifactFieldEditOutcome.ValidationFailed,
    artifactCount: 1,
    provenance: params.provenance,
  });
}

function refusedDocumentField(
  requested: DocumentUpdateInput,
  error: DocumentUpdateRefusal
): RequestedDocumentField | undefined {
  switch (error.code) {
    case DocumentStatusMutationErrorCode.InvalidStatusForSubtype:
    case DocumentStatusMutationErrorCode.StaleStatus:
      return requestedField(requested, ArtifactFieldEditField.Status);
    case ArtifactPriorityMutationErrorCode.StalePriority:
      return requestedField(requested, ArtifactFieldEditField.Priority);
    case DocumentFieldMutationErrorCode.StaleTitle:
      return requestedField(requested, ArtifactFieldEditField.Title);
    case DocumentFieldMutationErrorCode.StaleAssigneeId:
      return requestedField(requested, ArtifactFieldEditField.AssigneeId);
    case DocumentStatusMutationErrorCode.InvalidReference:
      return invalidReferenceField(requested, error.details?.field);
    case DocumentStatusMutationErrorCode.ArtifactsNotFound:
      return undefined;
    default:
      return undefined;
  }
}

function invalidReferenceField(
  requested: DocumentUpdateInput,
  field: unknown
): RequestedDocumentField | undefined {
  if (field === ArtifactFieldEditField.AssigneeId) {
    return requestedField(requested, ArtifactFieldEditField.AssigneeId);
  }
  if (field === ArtifactFieldEditField.ApproverId) {
    return requestedField(requested, ArtifactFieldEditField.ApproverId);
  }
  if (field === ArtifactFieldEditField.ProjectId) {
    return requestedField(requested, ArtifactFieldEditField.ProjectId);
  }
  return undefined;
}

function requestedField(
  requested: DocumentUpdateInput,
  field: ArtifactFieldEditField
): RequestedDocumentField | undefined {
  return requestedDocumentFields(requested).find(
    (candidate) => candidate.field === field
  );
}

function requestedDocumentFields(
  requested: DocumentUpdateInput
): RequestedDocumentField[] {
  const edits: RequestedDocumentField[] = [];
  if (requested.status !== undefined) {
    edits.push({
      field: ArtifactFieldEditField.Status,
      after: requested.status,
    });
  }
  if (requested.priority !== undefined) {
    edits.push({
      field: ArtifactFieldEditField.Priority,
      after: requested.priority,
    });
  }
  if (requested.assigneeId !== undefined) {
    edits.push({
      field: ArtifactFieldEditField.AssigneeId,
      after: requested.assigneeId,
    });
  }
  if (requested.approverId !== undefined) {
    edits.push({
      field: ArtifactFieldEditField.ApproverId,
      after: requested.approverId,
    });
  }
  if (requested.title !== undefined) {
    edits.push({ field: ArtifactFieldEditField.Title, after: requested.title });
  }
  if (requested.dueDate !== undefined) {
    edits.push({
      field: ArtifactFieldEditField.DueDate,
      after: requested.dueDate?.toISOString() ?? null,
    });
  }
  if (requested.projectId !== undefined) {
    edits.push({
      field: ArtifactFieldEditField.ProjectId,
      after: requested.projectId,
    });
  }
  return edits;
}

function documentFieldValue(
  document: Document,
  field: ArtifactFieldEditField
): string | null {
  switch (field) {
    case ArtifactFieldEditField.Status:
      return document.status;
    case ArtifactFieldEditField.Priority:
      return document.priority;
    case ArtifactFieldEditField.AssigneeId:
      return document.assigneeId;
    case ArtifactFieldEditField.ApproverId:
      return document.approverId;
    case ArtifactFieldEditField.Title:
      return document.title;
    case ArtifactFieldEditField.DueDate:
      return document.dueDate?.toISOString() ?? null;
    case ArtifactFieldEditField.ProjectId:
      return document.projectId;
    case ArtifactFieldEditField.Tag:
    case ArtifactFieldEditField.Name:
    case ArtifactFieldEditField.CustomField:
      return null;
    default:
      return field satisfies never;
  }
}

/**
 * The shipped `artifact_status_changed` (ISS-9436) and `artifact_priority_changed`
 * (ISS-9443) events for a single document PUT, restored after #8967 removed
 * them without a ruling (PRD-722 AC6). Each event fires only when this request
 * asked for that field, so a concurrent writer's change between the read and
 * the write is never attributed here. Status also needs trusted provenance;
 * priority needs a priority surface and a non-API-key caller. Neither fires on
 * a no-op.
 */
export function emitDocumentLegacyChangeAnalytics(params: {
  organizationId: string;
  userId: string;
  provenance: ArtifactStatusProvenance | undefined;
  surface: ArtifactStatusEditSurface | undefined;
  authMethod: ArtifactEditAuthMethod;
  requested: DocumentUpdateInput;
  previous: Document;
  artifact: Document;
}): void {
  const { artifact, previous, provenance, surface } = params;
  if (
    provenance !== undefined &&
    params.requested.status !== undefined &&
    artifact.status !== previous.status
  ) {
    try {
      captureArtifactStatusChangeAnalytics({
        organizationId: params.organizationId,
        userId: params.userId,
        surface: provenance.surface,
        result: ArtifactStatusCommitResult.Committed,
        from: previous.status,
        to: artifact.status,
        artifactCount: 1,
      });
    } catch {
      // Swallowed by design: analytics must never fail the write.
    }
  }
  if (
    surface === undefined ||
    !isArtifactPriorityEditSurface(surface) ||
    params.authMethod === "api_key" ||
    params.requested.priority === undefined ||
    artifact.priority === previous.priority
  ) {
    return;
  }
  try {
    captureArtifactPriorityChangeAnalytics({
      organizationId: params.organizationId,
      userId: params.userId,
      surface,
      result: ArtifactPriorityCommitResult.Committed,
      from: previous.priority,
      to: artifact.priority,
      artifactCount: 1,
    });
  } catch {
    // Swallowed by design: telemetry must never fail the write.
  }
}
