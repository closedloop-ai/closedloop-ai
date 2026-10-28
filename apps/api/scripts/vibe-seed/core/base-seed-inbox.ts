import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import {
  getNotificationEntityPath,
  NotificationEntityKind,
} from "@repo/api/src/types/notification-routes";
import {
  AssignmentEntityType,
  sendAssignmentNotification,
} from "@repo/collaboration/server/inbox-notifications";
import { keys as collaborationKeys } from "@repo/collaboration/server/keys";
import type { VibeSeedContext } from "../stage";
import { signedInPersonId } from "./base-seed-roster";

/**
 * ISS-12135 (bug 22): the signed-in person's Inbox, filled by the product's
 * own producer: one assignment notification for each open piece of work a
 * teammate handed them, exactly what `PUT /documents/[id]` sends on an
 * assignee change. The producer writes to Liveblocks, keyed by this seed's own
 * org and user ids, and does nothing when Liveblocks is not configured; the
 * product has no producer for @mentions in document comments, so those reach
 * the Inbox nowhere.
 */

const CLOSED_STATUSES: readonly string[] = [
  IssueStatus.Done,
  IssueStatus.Canceled,
  DocumentStatus.Executed,
  DocumentStatus.Obsolete,
];

export async function seedInboxNotifications(
  context: VibeSeedContext
): Promise<void> {
  if (!collaborationKeys().LIVEBLOCKS_SECRET) {
    context.log("inbox: Liveblocks is not configured, no notifications sent");
    return;
  }
  const admin = signedInPersonId(context);
  const assigned = await context.prisma.artifact.findMany({
    where: {
      organizationId: context.organizationId,
      type: ArtifactType.Document,
      assigneeId: admin,
      createdById: { not: admin },
      status: { notIn: [...CLOSED_STATUSES] },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      slug: true,
      subtype: true,
      createdById: true,
    },
  });
  for (const artifact of assigned) {
    if (!(artifact.slug && artifact.subtype && artifact.createdById)) {
      continue;
    }
    await sendAssignmentNotification({
      assigneeUserId: admin,
      actorUserId: artifact.createdById,
      organizationId: context.organizationId,
      entityType: AssignmentEntityType.Artifact,
      entityTitle: artifact.name,
      entityUrl: getNotificationEntityPath({
        kind: NotificationEntityKind.Artifact,
        slug: artifact.slug,
        subtype: artifact.subtype,
      }),
      subjectId: artifact.id,
    });
  }
  context.log(`inbox: ${assigned.length} assignment notification(s) sent`);
}
