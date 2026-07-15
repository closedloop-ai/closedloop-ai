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

type LiveblocksTriggerParams = Parameters<
  Liveblocks["triggerInboxNotification"]
>[0];

type TriggerInboxNotificationParams = {
  userId: string;
  organizationId: string;
  kind: LiveblocksTriggerParams["kind"];
  subjectId: string;
  activityData: LiveblocksTriggerParams["activityData"];
  errorLabel: string;
  logContext?: Record<string, unknown>;
};

/**
 * Shared sender for Liveblocks inbox notifications. No-ops when the Liveblocks
 * secret is unset and swallows trigger failures so a notification error never
 * fails the calling path. The public `send*Notification` helpers below are thin
 * wrappers that supply the `kind`, `activityData`, and `errorLabel`.
 */
async function triggerInboxNotification({
  userId,
  organizationId,
  kind,
  subjectId,
  activityData,
  errorLabel,
  logContext,
}: TriggerInboxNotificationParams): Promise<void> {
  const secret = keys().LIVEBLOCKS_SECRET;
  if (!secret) {
    return;
  }

  const liveblocks = new Liveblocks({ secret });

  try {
    await liveblocks.triggerInboxNotification({
      userId,
      kind,
      subjectId,
      tenantId: organizationId,
      activityData,
    });
  } catch (error) {
    log.error(errorLabel, {
      error: error instanceof Error ? error.message : String(error),
      userId,
      subjectId,
      ...logContext,
    });
  }
}

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
  if (params.assigneeUserId === params.actorUserId) {
    return;
  }

  await triggerInboxNotification({
    userId: params.assigneeUserId,
    organizationId: params.organizationId,
    kind: "$assignment",
    subjectId: params.subjectId,
    activityData: {
      entityType: params.entityType,
      entityTitle: params.entityTitle,
      entityUrl: params.entityUrl,
      actorId: params.actorUserId,
    },
    errorLabel: "Failed to send assignment notification",
    logContext: { entityType: params.entityType },
  });
}

export type LoopCompletedNotificationParams = {
  userId: string;
  organizationId: string;
  loopTitle: string;
  loopUrl: string;
  subjectId: string;
};

/**
 * Notify a Loop's owner that their autonomous agent run reached terminal
 * success. Delegates to `triggerInboxNotification`, which no-ops when the
 * Liveblocks secret is unset and swallows trigger failures so a notification
 * error never fails the loop-completion path.
 */
export async function sendLoopCompletedNotification(
  params: LoopCompletedNotificationParams
): Promise<void> {
  await triggerInboxNotification({
    userId: params.userId,
    organizationId: params.organizationId,
    kind: "$loopCompleted",
    subjectId: params.subjectId,
    activityData: {
      loopTitle: params.loopTitle,
      loopUrl: params.loopUrl,
    },
    errorLabel: "Failed to send loop completed notification",
  });
}

export type AwaitingInputNotificationParams = {
  userId: string;
  organizationId: string;
  sessionTitle: string;
  sessionUrl: string;
  subjectId: string;
};

/**
 * Notify a run's owner that it transitioned into awaiting-input (blocked on the
 * user). Delegates to `triggerInboxNotification`, which no-ops when the
 * Liveblocks secret is unset and swallows trigger failures so a notification
 * error never fails the session-sync path that detected the transition.
 */
export async function sendAwaitingInputNotification(
  params: AwaitingInputNotificationParams
): Promise<void> {
  await triggerInboxNotification({
    userId: params.userId,
    organizationId: params.organizationId,
    kind: "$awaitingInput",
    subjectId: params.subjectId,
    activityData: {
      sessionTitle: params.sessionTitle,
      sessionUrl: params.sessionUrl,
    },
    errorLabel: "Failed to send awaiting-input notification",
  });
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
