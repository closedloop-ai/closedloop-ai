import { CommentSurface } from "@repo/api/src/types/comment";
import {
  computeNewMentions,
  MentionEntityType,
} from "@repo/collaboration/server/inbox-notifications";
import { type TransactionClient, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { extractBodyMentions } from "@/app/comments/mention-body";
import { dispatchMentionNotifications } from "@/lib/mention-notifications";

/**
 * Reads the @-mention user-ID list already persisted on a comment's body doc
 * (FEA-3490). Used when an edit omits `mentions` entirely so a body-only edit
 * retains the comment's existing mentions instead of clearing them. The stored
 * ids were org-scoped when first written, so they are safe to re-persist as-is.
 */
export async function readPersistedCommentMentions(
  tx: TransactionClient,
  commentId: string
): Promise<string[]> {
  const existing = await tx.comment.findUnique({
    where: { id: commentId },
    select: { body: true },
  });
  return existing ? extractBodyMentions(existing.body) : [];
}

/**
 * Fire the @-mention inbox notifications for a just-written trace comment
 * (FEA-3490). Computes the newly-mentioned recipients (present now, absent
 * before, never the actor), resolves the session/branch title for the copy, and
 * hands off to the fire-and-forget dispatcher. Called AFTER the write
 * transaction commits so a notification hiccup can never roll back the comment,
 * and no-ops when nothing new was mentioned.
 */
export async function notifyTraceMentions(params: {
  resolved: { artifactId: string; surface: CommentSurface };
  organizationId: string;
  actorUserId: string;
  nextMentions: readonly string[];
  previousMentions: readonly string[];
  commentId: string;
  commentBody: string;
}): Promise<void> {
  const recipients = computeNewMentions(
    params.nextMentions,
    params.previousMentions,
    params.actorUserId
  );
  if (recipients.length === 0) {
    return;
  }
  const entityType = MENTION_ENTITY_TYPE_BY_SURFACE[params.resolved.surface];
  if (entityType === null) {
    return;
  }
  const entityTitle = await getArtifactTitle(
    params.organizationId,
    params.resolved.artifactId,
    entityType
  );
  dispatchMentionNotifications({
    recipientUserIds: recipients,
    actorUserId: params.actorUserId,
    organizationId: params.organizationId,
    entityType,
    entityTitle,
    artifactId: params.resolved.artifactId,
    commentId: params.commentId,
    commentBody: params.commentBody,
  });
}

export async function scopeMentionsToOrg(
  tx: TransactionClient,
  organizationId: string,
  mentions: readonly string[] | undefined
): Promise<string[]> {
  if (!mentions || mentions.length === 0) {
    return [];
  }
  const requested = [...new Set(mentions)];
  const members = await tx.user.findMany({
    where: {
      organizationId,
      active: true,
      id: { in: requested },
    },
    select: { id: true },
  });
  const allowed = new Set(members.map((member) => member.id));
  return requested.filter((id) => allowed.has(id));
}

/**
 * Document comments send no mention notification until PLN-2099's
 * notification rules exist (ISS-11216 v2 ruling; PLN-2187 Q-002).
 */
const MENTION_ENTITY_TYPE_BY_SURFACE: Record<
  CommentSurface,
  MentionEntityType | null
> = {
  [CommentSurface.SessionDetail]: MentionEntityType.Session,
  [CommentSurface.BranchDetail]: MentionEntityType.Branch,
  [CommentSurface.BranchTimeline]: MentionEntityType.Branch,
  [CommentSurface.DocumentDetail]: null,
};

async function getArtifactTitle(
  organizationId: string,
  artifactId: string,
  entityType: MentionEntityType
): Promise<string> {
  const fallback =
    entityType === MentionEntityType.Session ? "a session" : "a branch";
  try {
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: { id: artifactId, organizationId },
        select: { name: true },
      })
    );
    return artifact?.name?.trim() || fallback;
  } catch (error) {
    // The comment is already committed; a title lookup failure must never
    // surface as a request error. Fall back to a generic label so the mention
    // notification still fires with a sensible (if unnamed) deep link.
    log.warn("trace_comment_mention_title_lookup_failed", {
      organizationId,
      artifactId,
      error: parseError(error),
    });
    return fallback;
  }
}
