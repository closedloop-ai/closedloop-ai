"use client";

import { MessageSquareIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { TraceCommentItem, TraceTextAnchor } from "./trace-comments";
import { TraceCommentsRail } from "./trace-comments-rail";

/** Renders the right-side comments surface: full rail, collapsed handle, or nothing. */
export function renderCommentsRail({
  activeRow,
  collapsed,
  comments,
  onCollapse,
  onDelete,
  onExpand,
  onJump,
  onReply,
  onUpdate,
  onWidthChange,
  open,
  traceIdentity,
  width,
}: Readonly<{
  activeRow: number | null;
  collapsed: boolean;
  comments: readonly TraceCommentItem[];
  onCollapse: () => void;
  onDelete: (commentId: string) => void;
  onExpand: () => void;
  onJump: (row: number, flash?: boolean, anchor?: TraceTextAnchor) => void;
  onReply: (
    commentId: string,
    draft: { body: string; mentions?: string[] }
  ) => void;
  onUpdate: (
    commentId: string,
    update: { body: string; mentions?: string[] }
  ) => void;
  onWidthChange: (width: number) => void;
  open: boolean;
  traceIdentity: string;
  width: number;
}>): ReactNode {
  if (!open) {
    return null;
  }
  if (collapsed) {
    return (
      <CollapsedCommentsHandle count={comments.length} onExpand={onExpand} />
    );
  }
  return (
    <TraceCommentsRail
      activeRow={activeRow}
      comments={comments}
      onCollapse={onCollapse}
      onDelete={onDelete}
      onJump={onJump}
      onReply={onReply}
      onUpdate={onUpdate}
      onWidthChange={onWidthChange}
      traceIdentity={traceIdentity}
      width={width}
    />
  );
}

/**
 * Slim re-open affordance shown when the comments rail is collapsed (FEA-2479).
 * Stays pinned to the right edge so the toggle is reachable on small desktop
 * windows.
 */
function CollapsedCommentsHandle({
  count,
  onExpand,
}: Readonly<{ count: number; onExpand: () => void }>) {
  return (
    <aside className="sd3-cmts-collapsed">
      <button
        aria-label="Show comments panel"
        className="sd3-cmts-reopen"
        onClick={onExpand}
        title="Show comments"
        type="button"
      >
        <MessageSquareIcon aria-hidden className="size-4" />
        {count > 0 ? (
          <span className="sd3-cmts-reopen-count">{count}</span>
        ) : null}
      </button>
    </aside>
  );
}
