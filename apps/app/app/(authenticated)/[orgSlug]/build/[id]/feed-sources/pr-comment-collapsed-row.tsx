"use client";

import type { BranchViewComment } from "@repo/api/src/types/branch-view";
import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import { CollapsedCommentRow } from "@repo/design-system/components/ui/collapsed-comment-row";

/**
 * Compact one-line summary that replaces a resolved PR comment card when
 * the user collapses the thread. Mirrors the `feed.css` `.fp-comment-collapsed`
 * structure: check glyph · author · optional title · chevron-down.
 */
export function PrCommentCollapsedRow({
  author,
  authorAvatar,
  authorKind,
  onExpand,
  title,
}: Readonly<{
  author: string;
  authorAvatar?: string | null;
  authorKind?: BranchViewComment["authorKind"];
  onExpand: () => void;
  title: string | null;
}>) {
  return (
    <CollapsedCommentRow
      author={author}
      avatar={
        <CommentAvatar
          author={author}
          authorAvatar={authorAvatar}
          authorKind={authorKind}
          size="sm"
        />
      }
      onExpand={onExpand}
      title={title}
    />
  );
}
