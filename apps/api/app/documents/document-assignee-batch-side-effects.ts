import {
  getNotificationEntityPath,
  NotificationEntityKind,
} from "@repo/api/src/types/notification-routes";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { AssignmentEntityType } from "@repo/collaboration/server/inbox-notifications";
import { searchIndexService } from "@/app/search/search-index-service";
import { dispatchAssignmentNotification } from "@/lib/assignment-notifications";

/** Emit owner notifications and refresh search only for committed rows. */
export function emitBatchDocumentAssigneeSideEffects(input: {
  actorUserId: string;
  organizationId: string;
  assigneeId: string | null;
  changes: readonly {
    artifactId: string;
    before: string | null;
    name: string;
    slug: string;
    subtype: string;
  }[];
}): void {
  if (input.changes.length === 0) {
    return;
  }
  for (const change of input.changes) {
    try {
      dispatchAssignmentNotification({
        previousAssigneeId: change.before,
        newAssigneeId: input.assigneeId,
        actorUserId: input.actorUserId,
        organizationId: input.organizationId,
        entityType: AssignmentEntityType.Artifact,
        entityTitle: change.name,
        entityUrl: getNotificationEntityPath({
          kind: NotificationEntityKind.Artifact,
          slug: change.slug,
          subtype: change.subtype,
        }),
        subjectId: change.artifactId,
      });
    } catch {
      // A post-commit notification failure cannot turn committed items into a 500.
    }
  }
  try {
    searchIndexService.updateAssigneeManyAfterCommit(
      {
        organizationId: input.organizationId,
        entityType: SearchEntityType.Document,
      },
      input.changes.map((change) => change.artifactId),
      input.assigneeId
    );
  } catch {
    // A post-commit projection failure cannot turn committed items into a 500.
  }
}
