import "server-only";
import { Liveblocks } from "@liveblocks/node";
import { log } from "@repo/observability/log";
import { keys } from "./keys";

export const AssignmentEntityType = {
  Artifact: "artifact",
  Feature: "feature",
  Project: "project",
} as const;

export type AssignmentEntityType =
  (typeof AssignmentEntityType)[keyof typeof AssignmentEntityType];

export type AssignmentNotificationParams = {
  assigneeUserId: string;
  actorUserId: string;
  organizationId: string;
  entityType: AssignmentEntityType;
  entityTitle: string;
  entityUrl: string;
  subjectId: string;
};

export async function sendAssignmentNotification(
  params: AssignmentNotificationParams
): Promise<void> {
  const secret = keys().LIVEBLOCKS_SECRET;
  if (!secret) {
    return;
  }

  if (params.assigneeUserId === params.actorUserId) {
    return;
  }

  const liveblocks = new Liveblocks({ secret });

  try {
    await liveblocks.triggerInboxNotification({
      userId: params.assigneeUserId,
      kind: "$assignment",
      subjectId: params.subjectId,
      tenantId: params.organizationId,
      activityData: {
        entityType: params.entityType,
        entityTitle: params.entityTitle,
        entityUrl: params.entityUrl,
        actorId: params.actorUserId,
      },
    });
  } catch (error) {
    log.error("Failed to send assignment notification", {
      error: error instanceof Error ? error.message : String(error),
      assigneeUserId: params.assigneeUserId,
      entityType: params.entityType,
      subjectId: params.subjectId,
    });
  }
}

/**
 * Check if an assignee changed and should trigger a notification.
 * Returns the new assigneeId if a notification should be sent, or null otherwise.
 */
export function detectAssigneeChange(
  newAssigneeId: string | null | undefined,
  previousAssigneeId: string | null | undefined,
  actorUserId: string
): string | null {
  if (!newAssigneeId) {
    return null;
  }
  if (newAssigneeId === previousAssigneeId) {
    return null;
  }
  if (newAssigneeId === actorUserId) {
    return null;
  }
  return newAssigneeId;
}
