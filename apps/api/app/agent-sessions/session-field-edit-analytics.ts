import type { AgentSessionFieldMutationError } from "@repo/api/src/types/agent-session-field-mutation";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
  type ArtifactFieldEditOutcome as ArtifactFieldEditOutcomeValue,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import type { ArtifactStatusProvenance } from "@repo/api/src/types/artifact-status-contract";
import { captureArtifactFieldEditAnalytics } from "@/lib/artifact-field-edit-analytics";

export type SessionGroupingAnalyticsChange = {
  field: ArtifactFieldEditField;
  before?: string | null;
  after?: string | null;
};

type SessionGroupingValues = {
  status?: string;
  projectId?: string | null;
  ownerUserId?: string | null;
};

/** Build field-scoped outcomes from values already read under the write lock. */
export function buildSessionGroupingAnalyticsChanges(
  before: SessionGroupingValues,
  after: SessionGroupingValues
): SessionGroupingAnalyticsChange[] {
  const changes: SessionGroupingAnalyticsChange[] = [];
  if (after.status !== undefined) {
    changes.push({
      field: ArtifactFieldEditField.Status,
      ...(before.status === undefined ? {} : { before: before.status }),
      after: after.status,
    });
  }
  if (after.projectId !== undefined) {
    changes.push({
      field: ArtifactFieldEditField.ProjectId,
      ...(before.projectId === undefined ? {} : { before: before.projectId }),
      after: after.projectId,
    });
  }
  if (after.ownerUserId !== undefined) {
    changes.push({
      field: ArtifactFieldEditField.AssigneeId,
      ...(before.ownerUserId === undefined
        ? {}
        : { before: before.ownerUserId }),
      after: after.ownerUserId,
    });
  }
  return changes;
}

/** Map a multi-field stale envelope to only the fields its details names. */
export function buildSessionConflictAnalyticsChanges(
  error: AgentSessionFieldMutationError,
  requested: SessionGroupingValues
): SessionGroupingAnalyticsChange[] {
  const changes: SessionGroupingAnalyticsChange[] = [];
  if (error.details.staleStatuses?.length && requested.status !== undefined) {
    changes.push({
      field: ArtifactFieldEditField.Status,
      after: requested.status,
    });
  }
  if (
    error.details.staleProjectIds?.length &&
    requested.projectId !== undefined
  ) {
    changes.push({
      field: ArtifactFieldEditField.ProjectId,
      after: requested.projectId,
    });
  }
  if (
    error.details.staleOwnerUserIds?.length &&
    requested.ownerUserId !== undefined
  ) {
    changes.push({
      field: ArtifactFieldEditField.AssigneeId,
      after: requested.ownerUserId,
    });
  }
  return changes;
}

/** Emit bounded outcomes after the enclosing session transaction completes. */
export function emitSessionGroupingAnalytics(params: {
  organizationId: string;
  userId: string;
  changes: SessionGroupingAnalyticsChange[];
  forcedResult?: ArtifactFieldEditOutcomeValue;
  provenance?: ArtifactStatusProvenance;
}): void {
  for (const change of params.changes) {
    const result =
      params.forcedResult ??
      (change.before === change.after
        ? ArtifactFieldEditOutcome.NoChange
        : ArtifactFieldEditOutcome.Committed);
    captureArtifactFieldEditAnalytics({
      organizationId: params.organizationId,
      userId: params.userId,
      field: change.field,
      result,
      artifactCount: 1,
      ...(params.provenance === undefined
        ? {}
        : { provenance: params.provenance }),
      ...(change.before === undefined ? {} : { before: change.before }),
      ...(change.after === undefined ? {} : { after: change.after }),
    });
  }
}
