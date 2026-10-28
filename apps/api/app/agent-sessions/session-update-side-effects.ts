import { AuditAction } from "@repo/api/src/types/audit";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import type { ArtifactMutationAuditChange } from "@/app/audit/artifact-mutation-audit-event";
import { dispatchSingleArtifactMutationAudits } from "@/app/audit/single-artifact-mutation-audit";
import { searchIndexService } from "@/app/search/search-index-service";

type SessionGroupingChange = {
  artifactId: string;
  before: string | null;
  after: string | null;
};

/** Transaction-owned facts needed by post-commit Session side effects. */
export type SessionUpdateSideEffectFacts = {
  ownerUserId?: string | null;
  projectChange?: SessionGroupingChange;
  ownerChange?: SessionGroupingChange;
};

/** Emits projection and audit effects after the session transaction commits. */
export function emitSessionUpdateSideEffects(
  input: { organizationId: string; sessionId: string; userId: string },
  written: SessionUpdateSideEffectFacts
): void {
  if (written.ownerUserId !== undefined) {
    refreshAssigneeProjection(input, written.ownerUserId);
  }

  const changes: ArtifactMutationAuditChange[] = [];
  if (written.projectChange) {
    changes.push({
      action: AuditAction.ArtifactProjectChanged,
      objectId: written.projectChange.artifactId,
      before: written.projectChange.before,
      after: written.projectChange.after,
    });
  }
  if (written.ownerChange) {
    changes.push({
      action: AuditAction.AgentSessionAssigned,
      objectId: written.ownerChange.artifactId,
      before: written.ownerChange.before,
      after: written.ownerChange.after,
    });
  }
  dispatchSingleArtifactMutationAudits({
    organizationId: input.organizationId,
    userId: input.userId,
    changes,
  });
}

/**
 * `@owner` search reads `search_document.assignee_id`, which the transcript
 * indexer refreshes only when a transcript lands, so an Owner write re-projects
 * it after commit (ISS-12251). Fail-open: the write has already committed.
 */
function refreshAssigneeProjection(
  input: { organizationId: string; sessionId: string },
  ownerUserId: string | null
): void {
  try {
    searchIndexService.updateAssigneeAfterCommit(
      {
        organizationId: input.organizationId,
        entityType: SearchEntityType.AgentSession,
        entityId: input.sessionId,
      },
      ownerUserId
    );
  } catch {
    // Swallowed by design: a projection refresh must never fail the write.
  }
}
