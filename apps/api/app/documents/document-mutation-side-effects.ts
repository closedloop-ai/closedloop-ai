import { AuditAction, AuditObjectType } from "@repo/api/src/types/audit";
import type { Priority } from "@repo/api/src/types/common";
import type {
  ArtifactStatus,
  UpdateDocumentInput,
} from "@repo/api/src/types/document";
import type { ArtifactMutationAuditChange } from "@/app/audit/artifact-mutation-audit-event";
import {
  dispatchAuditEvent,
  userAuditActor,
} from "@/app/audit/audit-emit-service";
import { dispatchSingleArtifactMutationAudits } from "@/app/audit/single-artifact-mutation-audit";

type DocumentAuditState = {
  id: string;
  status: ArtifactStatus;
  priority: Priority | null;
  projectId: string | null;
};

/** Dispatches post-commit audit events for each requested field that changed. */
export function dispatchDocumentMutationAudits(params: {
  organizationId: string;
  userId: string;
  artifactInput: Omit<UpdateDocumentInput, "id">;
  previous: DocumentAuditState;
  artifact: DocumentAuditState;
}): void {
  const { artifact, artifactInput, organizationId, previous, userId } = params;
  if (
    artifactInput.status !== undefined &&
    artifact.status !== previous.status
  ) {
    dispatchDocumentStatusAudit({
      organizationId,
      userId,
      previous,
      artifact,
    });
  }

  const changes: ArtifactMutationAuditChange[] = [];
  if (artifactInput.priority !== undefined) {
    changes.push({
      action: AuditAction.DocumentPriorityChanged,
      objectId: artifact.id,
      before: previous.priority,
      after: artifact.priority,
    });
  }
  if (artifactInput.projectId !== undefined) {
    changes.push({
      action: AuditAction.ArtifactProjectChanged,
      objectId: artifact.id,
      before: previous.projectId,
      after: artifact.projectId,
    });
  }
  dispatchSingleArtifactMutationAudits({ organizationId, userId, changes });
}

function dispatchDocumentStatusAudit(params: {
  organizationId: string;
  userId: string;
  previous: DocumentAuditState;
  artifact: DocumentAuditState;
}): void {
  try {
    dispatchAuditEvent({
      organizationId: params.organizationId,
      actor: userAuditActor(params.userId),
      action: AuditAction.DocumentStatusChanged,
      objectType: AuditObjectType.Document,
      objectId: params.artifact.id,
      detail: { from: params.previous.status, to: params.artifact.status },
    });
  } catch {
    // A synchronous status-dispatch failure cannot suppress sibling audit facts
    // for priority or project transitions in the same committed write.
  }
}
