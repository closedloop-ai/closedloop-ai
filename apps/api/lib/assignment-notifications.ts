import {
  type AssignmentEntityType,
  type AssignmentNotificationParams,
  detectAssigneeChange,
  sendAssignmentNotification,
} from "@repo/collaboration/server/inbox-notifications";
import { waitUntil } from "@vercel/functions";

type DispatchAssignmentNotificationParams = {
  previousAssigneeId: string | null | undefined;
  newAssigneeId: string | null | undefined;
  actorUserId: string;
  organizationId: string;
  entityType: AssignmentEntityType;
  entityTitle: string;
  entityUrl: string;
  subjectId: string;
};

export function dispatchAssignmentNotification(
  params: DispatchAssignmentNotificationParams
): void {
  const assignee = detectAssigneeChange(
    params.newAssigneeId,
    params.previousAssigneeId,
    params.actorUserId
  );
  if (!assignee) {
    return;
  }

  const notificationParams: AssignmentNotificationParams = {
    assigneeUserId: assignee,
    actorUserId: params.actorUserId,
    organizationId: params.organizationId,
    entityType: params.entityType,
    entityTitle: params.entityTitle,
    entityUrl: params.entityUrl,
    subjectId: params.subjectId,
  };

  waitUntil(sendAssignmentNotification(notificationParams));
}
