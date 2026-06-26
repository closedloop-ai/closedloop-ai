"use client";

import type { BranchViewComment } from "@repo/api/src/types/branch-view";
import { CommentActionMenu } from "@repo/design-system/components/ui/comment-action-menu";
import {
  canResolveBranchViewReviewThread,
  canUnresolveBranchViewReviewThread,
} from "../components/branch-review-thread-capabilities";

type PrCommentActionMenuProps = {
  /**
   * The comment whose actions this menu renders. May be a thread root or
   * a reply. Resolve and Chat-About-This items only render when the
   * matching handlers are provided — replies should omit them.
   */
  comment: BranchViewComment;
  onEditToggle: () => void;
  onDelete: () => void;
  /** Required to render the Chat About This item (thread-level). */
  onChatAboutThis?: () => void;
  /** Required, with `onUnresolveThread`, to render the Resolve/Unresolve item. */
  onResolveThread?: () => void;
  onUnresolveThread?: () => void;
  isResolvePending?: boolean;
  isUnresolvePending?: boolean;
};

/**
 * Per-comment overflow menu for PR comment cards. Used on both thread
 * roots and replies. The Resolve item appears only when the
 * API-projected capabilities permit resolve OR unresolve, and only when
 * the caller supplies the thread-resolution handlers — matching the
 * inline section's behavior so users never see permanently-disabled
 * thread actions on a per-reply menu.
 */
export function PrCommentActionMenu({
  comment,
  isResolvePending = false,
  isUnresolvePending = false,
  onChatAboutThis,
  onEditToggle,
  onDelete,
  onResolveThread,
  onUnresolveThread,
}: Readonly<PrCommentActionMenuProps>) {
  const canResolveNow =
    onResolveThread !== undefined &&
    onUnresolveThread !== undefined &&
    canResolveBranchViewReviewThread(comment);
  const canUnresolveNow =
    onResolveThread !== undefined &&
    onUnresolveThread !== undefined &&
    canUnresolveBranchViewReviewThread(comment);
  const showResolveItem = canResolveNow || canUnresolveNow;
  const canEdit = comment.canEdit === true;
  const canDelete = comment.canDelete === true;
  const hasHtmlUrl = comment.htmlUrl.trim().length > 0;
  let resolveLabel: string | undefined;

  if (showResolveItem) {
    resolveLabel = canUnresolveNow
      ? "Unresolve Conversation"
      : "Resolve Conversation";
  }

  return (
    <CommentActionMenu
      canDelete={canDelete}
      canEdit={canEdit}
      copyValue={hasHtmlUrl ? comment.htmlUrl : null}
      isResolvePending={
        (canResolveNow ? isResolvePending : false) ||
        (canUnresolveNow ? isUnresolvePending : false)
      }
      onChatAboutThis={onChatAboutThis}
      onDelete={onDelete}
      onEditToggle={onEditToggle}
      onResolveAction={() => {
        if (canResolveNow) {
          onResolveThread?.();
          return;
        }
        if (canUnresolveNow) {
          onUnresolveThread?.();
        }
      }}
      resolveLabel={resolveLabel}
    />
  );
}
