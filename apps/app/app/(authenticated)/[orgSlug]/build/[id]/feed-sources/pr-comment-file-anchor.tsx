"use client";

import type { BranchViewComment } from "@repo/api/src/types/branch-view";
import { CommentKind } from "@repo/api/src/types/branch-view";
import { cn } from "@repo/design-system/lib/utils";
import { FileCode } from "lucide-react";
import type { MouseEvent } from "react";
import { useBranchViewContext } from "../branch-view-context";
import { getBranchViewCommentUiId } from "../comment-context";
import type { ResolvedCommentFileTarget } from "../file-targets";

type PrCommentFileAnchorProps = {
  comment: BranchViewComment;
  commentFileTarget: ResolvedCommentFileTarget | null;
};

/**
 * `<file>:<line>` chip for a PR review comment row. Clicks fire
 * `onSelectCommentDiffTarget` from the branch view context when the
 * comment has a resolvable committed-file target; otherwise the chip
 * falls back to a static label that explains the anchor went stale.
 */
export function PrCommentFileAnchor({
  comment,
  commentFileTarget,
}: Readonly<PrCommentFileAnchorProps>) {
  const { onSelectCommentDiffTarget } = useBranchViewContext();

  if (!comment.path) {
    return null;
  }

  const referenceText = `${comment.path}${
    comment.line === null ? "" : `:${comment.line}`
  }`;
  const isReviewLineTarget =
    comment.kind === CommentKind.ReviewComment && comment.line !== null;

  if (!(isReviewLineTarget && commentFileTarget)) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1">
          <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-muted-foreground text-xs">
            {referenceText}
          </span>
        </div>
        {isReviewLineTarget ? (
          <span className="text-muted-foreground text-xs">
            This comment refers to a file no longer in this branch.
          </span>
        ) : null}
      </div>
    );
  }

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (comment.line === null || !comment.path || commentFileTarget === null) {
      return;
    }
    onSelectCommentDiffTarget({
      commentId: getBranchViewCommentUiId(comment),
      fileId: commentFileTarget.fileId,
      path: comment.path,
      line: comment.line,
    });
  }

  return (
    <button
      aria-label={`View ${comment.path} at line ${comment.line}`}
      className={cn(
        "flex min-w-0 cursor-pointer items-center gap-1 rounded-sm font-mono text-muted-foreground text-xs",
        "outline-none transition-colors hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      )}
      data-comment-control="true"
      onClick={handleClick}
      type="button"
    >
      <FileCode className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{referenceText}</span>
    </button>
  );
}
