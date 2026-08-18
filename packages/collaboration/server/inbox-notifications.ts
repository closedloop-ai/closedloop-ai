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
    // Pass the raw error: the logger's jsonReplacer serializes name/message/
    // stack for an Error, so reducing it to `.message` here discarded the stack
    // and left a Datadog line that could not be traced back to a source line
    // (FEA-3030). Matches apps/api/lib/desktop-analytics-handler.ts.
    log.error(errorLabel, {
      error,
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

export const MentionEntityType = {
  Session: "session",
  Branch: "branch",
} as const;

export type MentionEntityType =
  (typeof MentionEntityType)[keyof typeof MentionEntityType];

export type MentionNotificationParams = {
  mentionedUserId: string;
  actorUserId: string;
  organizationId: string;
  entityType: MentionEntityType;
  entityTitle: string;
  entityUrl: string;
  commentPreview: string;
  subjectId: string;
};

/**
 * Notify a user that they were @-mentioned in a session/branch trace comment
 * (FEA-3490). Delegates to `triggerInboxNotification`, which no-ops when the
 * Liveblocks secret is unset and swallows trigger failures so a notification
 * error never fails the comment-write path. Self-mentions are dropped defensively
 * (the caller's `computeNewMentions` already excludes the actor).
 */
export async function sendMentionNotification(
  params: MentionNotificationParams
): Promise<void> {
  if (params.mentionedUserId === params.actorUserId) {
    return;
  }

  await triggerInboxNotification({
    userId: params.mentionedUserId,
    organizationId: params.organizationId,
    kind: "$mention",
    subjectId: params.subjectId,
    activityData: {
      entityType: params.entityType,
      entityTitle: params.entityTitle,
      entityUrl: params.entityUrl,
      actorId: params.actorUserId,
      commentPreview: params.commentPreview,
    },
    errorLabel: "Failed to send mention notification",
    logContext: { entityType: params.entityType },
  });
}

/**
 * The set of mention recipients that should be notified for a comment write:
 * the mentions present after the write, minus those already present before it
 * (so an edit only pings newly-added people, never re-pings existing mentions),
 * minus the actor (never notify yourself for your own mention). De-duplicated and
 * input-order-stable. `previousMentions` is empty for a create/reply.
 */
export function computeNewMentions(
  nextMentions: readonly string[],
  previousMentions: readonly string[],
  actorUserId: string
): string[] {
  const previous = new Set(previousMentions);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of nextMentions) {
    if (id === actorUserId || previous.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
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
