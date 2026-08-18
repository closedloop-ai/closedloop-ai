"use client";

import { useUser } from "@liveblocks/react";
import type { CommentProps } from "@liveblocks/react-ui";
import { Comment } from "@liveblocks/react-ui";
import type { CommentAvatarSize } from "@repo/app/shared/components/comment-avatar";
import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import {
  formatDateTimeOrFallback,
  formatRelativeTimeOrFallback,
} from "@repo/app/shared/lib/date-utils";

/**
 * DS-themed replacement for Liveblocks' default per-comment chrome, passed to
 * `<Thread components={{ Comment }}>`. It renders the shared DS comment header
 * (the same `CommentAvatar` + name + relative-time treatment the DB-projected
 * card in `comments-section.tsx` uses) while delegating the comment BODY,
 * actions, edit affordance, reactions, and dropdown to Liveblocks' own
 * `<Comment>` primitive. That is the FEA-4058 convergence: identical card chrome
 * across both surfaces, but the live thread keeps rendering its native rich body
 * so mentions and formatting marks are never flattened to plain text.
 *
 * Only the avatar/author/date SLOTS are overridden; `<Comment>` still owns the
 * body renderer and all mutation controls, so no edit/delete/reaction behavior
 * is re-implemented (and thus none can regress). `<Thread>` still governs reply
 * indentation via `indentContent` (forwarded untouched through `...props`); the
 * override only steps the avatar down for replies so the root/reply avatar
 * treatment matches the DB-projected artifact card.
 *
 * `authorKind` (human vs bot) is intentionally NOT wired here: the Liveblocks
 * user resolver (`createResolveUsers` in `@repo/collaboration`) resolves ids to
 * `{ name, avatar, color }` only — it carries no bot marker, and the org-user
 * source it reads (`UserInfo`) has none either. Threading a real kind through
 * needs a resolver/schema change, tracked separately; until then every live
 * commenter renders as a human avatar rather than guessing.
 */
export function LiveblocksDsComment(props: Readonly<CommentProps>) {
  const { comment } = props;
  const { user, isLoading } = useUser(comment.userId);
  const authorName = resolveCommentAuthorName(user?.name, isLoading);

  // `<Thread>` sets `aria-posinset` per comment (1 = the root/first comment),
  // so a reply is any comment past the first. Replies get the `xs` avatar the
  // DB-projected card uses; the root keeps `sm`.
  const isReply =
    props["aria-posinset"] !== undefined && props["aria-posinset"] > 1;
  const avatarSize: CommentAvatarSize = isReply ? "xs" : "sm";

  return (
    <Comment
      {...props}
      author={<span className="font-medium text-sm">{authorName}</span>}
      avatar={
        <CommentAvatar
          author={authorName}
          authorAvatar={user?.avatar}
          size={avatarSize}
        />
      }
      date={
        <span
          className="text-muted-foreground text-xs"
          title={formatDateTimeOrFallback(comment.createdAt)}
        >
          {formatRelativeTimeOrFallback(comment.createdAt)}
          {comment.editedAt ? " (edited)" : null}
        </span>
      }
    />
  );
}

/**
 * Resolve the display name for a live comment author. While the org-user query
 * is still resolving the id, show a neutral placeholder rather than the raw
 * Liveblocks user id; if the resolver ultimately has no record for the id (a
 * removed or cross-org user), fall back to "Unknown user" so a raw id never
 * leaks into the thread.
 */
function resolveCommentAuthorName(
  resolvedName: string | undefined,
  isLoading: boolean
): string {
  if (resolvedName) {
    return resolvedName;
  }
  return isLoading ? "Loading…" : "Unknown user";
}
