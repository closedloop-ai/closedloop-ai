import {
  BranchDetailTabParam,
  getNotificationEntityPath,
  NotificationEntityKind,
} from "@repo/api/src/types/notification-routes";
import {
  type MentionEntityType,
  MentionEntityType as MentionEntityTypeEnum,
  sendMentionNotification,
} from "@repo/collaboration/server/inbox-notifications";
import { waitUntil } from "@vercel/functions";

/** Max characters of the comment body carried into the inbox row preview. */
const COMMENT_PREVIEW_MAX_CHARS = 140;

type DispatchMentionNotificationsParams = {
  /**
   * Users to notify — already org-scoped and delta-filtered by the caller
   * (`computeNewMentions`). The actor is excluded again defensively.
   */
  recipientUserIds: readonly string[];
  actorUserId: string;
  organizationId: string;
  entityType: MentionEntityType;
  entityTitle: string;
  /** Session/branch artifact id — the `/sessions|branches/{id}` deep-link target. */
  artifactId: string;
  /** Comment id — the notification subject, so each comment groups its own pings. */
  commentId: string;
  /** Raw comment body; truncated to a short preview for the inbox row. */
  commentBody: string;
};

/**
 * Fire-and-forget @-mention inbox notifications for a trace comment (FEA-3490).
 * One Liveblocks inbox entry per newly-mentioned user, each carrying a deep link
 * to the session/branch the comment lives on — parity with mentioning someone in
 * any other artifact inline comment. Dispatched via `waitUntil` so a Liveblocks
 * hiccup never blocks or fails the comment-write path, and no-ops on an empty
 * recipient list.
 */
export function dispatchMentionNotifications(
  params: DispatchMentionNotificationsParams
): void {
  const recipients = params.recipientUserIds.filter(
    (id) => id !== params.actorUserId
  );
  if (recipients.length === 0) {
    return;
  }

  const entityUrl = buildEntityUrl(params.entityType, params.artifactId);
  const commentPreview = toPreview(params.commentBody);

  for (const mentionedUserId of recipients) {
    waitUntil(
      sendMentionNotification({
        mentionedUserId,
        actorUserId: params.actorUserId,
        organizationId: params.organizationId,
        entityType: params.entityType,
        entityTitle: params.entityTitle,
        entityUrl,
        commentPreview,
        subjectId: params.commentId,
      })
    );
  }
}

function buildEntityUrl(
  entityType: MentionEntityType,
  artifactId: string
): string {
  if (entityType === MentionEntityTypeEnum.Session) {
    return getNotificationEntityPath({
      kind: NotificationEntityKind.Session,
      sessionId: artifactId,
    });
  }
  return getNotificationEntityPath({
    kind: NotificationEntityKind.Branch,
    branchId: artifactId,
    // The branch page defaults to the branch-details tab, but the trace-comments
    // rail only mounts under sessions-timeline — deep-link there so the mentioned
    // comment is actually on screen when the notification is clicked.
    tab: BranchDetailTabParam.SessionsTimeline,
  });
}

function toPreview(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  return normalized.length > COMMENT_PREVIEW_MAX_CHARS
    ? `${normalized.slice(0, COMMENT_PREVIEW_MAX_CHARS - 1)}…`
    : normalized;
}
