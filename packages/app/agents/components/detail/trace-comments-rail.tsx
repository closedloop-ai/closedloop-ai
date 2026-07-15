"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import {
  CommentThreadAnchorPreview,
  CommentThreadCard,
  CommentThreadHeader,
  CommentThreadMain,
} from "@repo/design-system/components/ui/comment-thread";
import { cn } from "@repo/design-system/lib/utils";
import {
  ArrowUpDownIcon,
  CheckIcon,
  CornerUpLeftIcon,
  CrosshairIcon,
  PanelRightCloseIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TraceCommentItem, TraceTextAnchor } from "./trace-comments";

/** Shared persisted trace comments rail for session and branch trace surfaces. */
export function TraceCommentsRail({
  activeRow,
  comments,
  onCollapse,
  onDelete,
  onJump,
  onReply,
  onUpdate,
  onWidthChange,
  width,
}: Readonly<{
  activeRow?: number | null;
  comments: readonly TraceCommentItem[];
  onCollapse?: () => void;
  onDelete?: (commentId: string) => void;
  onJump: (row: number, flash?: boolean, anchor?: TraceTextAnchor) => void;
  onReply?: (commentId: string, draft: { body: string }) => void;
  onUpdate?: (commentId: string, update: { body: string }) => void;
  onWidthChange?: (width: number) => void;
  width?: number;
}>) {
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const startResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!(onWidthChange && width != null)) {
        return;
      }
      event.preventDefault();
      const handle = event.currentTarget;
      const shell = handle.closest<HTMLElement>(".sd3");
      if (!shell) {
        return;
      }
      const resizeShell = shell;
      const rail = handle.closest<HTMLElement>(".sd3-cmts");
      const startX = event.clientX;
      const railWidth = rail?.getBoundingClientRect().width;
      const startWidth = railWidth && railWidth > 0 ? railWidth : width;

      function onMove(moveEvent: globalThis.MouseEvent) {
        const max = Math.max(320, resizeShell.clientWidth * 0.5);
        const nextWidth = clamp(
          startWidth - (moveEvent.clientX - startX),
          300,
          max
        );
        resizeShell.style.setProperty("--sd3-cmts-w", `${nextWidth}px`);
        onWidthChange?.(nextWidth);
      }

      function onUp() {
        globalThis.document.removeEventListener("mousemove", onMove);
        globalThis.document.removeEventListener("mouseup", onUp);
        handle.classList.remove("dragging");
        globalThis.document.body.style.cursor = "";
        globalThis.document.body.style.userSelect = "";
        resizeCleanupRef.current = null;
      }

      handle.classList.add("dragging");
      globalThis.document.body.style.cursor = "col-resize";
      globalThis.document.body.style.userSelect = "none";
      globalThis.document.addEventListener("mousemove", onMove);
      globalThis.document.addEventListener("mouseup", onUp);
      resizeCleanupRef.current = onUp;
    },
    [onWidthChange, width]
  );

  // Detach any still-attached resize listeners if the panel unmounts mid-drag.
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  return (
    <aside className="sd3-cmts fp">
      {onWidthChange ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: FEA-1770 source keeps the resize handle mouse-only and non-focusable.
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: FEA-1770 source keeps the resize handle mouse-only and non-focusable.
        <div
          className="fp-resize"
          onMouseDown={startResize}
          title="Drag to resize"
        />
      ) : null}
      <div className="fp-head">
        <div className="fp-head-row">
          <span className="fp-title">
            Comments <span className="fp-count">{comments.length}</span>
          </span>
          <div className="fp-head-actions">
            <button
              aria-label="Sort comments"
              className="fp-icon-btn fp-sort-btn"
              title="Sort"
              type="button"
            >
              <ArrowUpDownIcon aria-hidden className="size-3.5" />
            </button>
            {onCollapse ? (
              <button
                aria-label="Collapse comments panel"
                className="fp-icon-btn fp-collapse-btn"
                onClick={onCollapse}
                title="Collapse comments"
                type="button"
              >
                <PanelRightCloseIcon aria-hidden className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="fp-stream">
        <div className="fp-daysep">
          <span>Today</span>
        </div>
        {comments.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="font-medium text-sm">No trace comments yet</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Select trace text to anchor the next comment.
            </p>
          </div>
        ) : (
          comments.map((comment) => (
            <TraceCommentCard
              active={comment.anchor.row === activeRow}
              comment={comment}
              key={comment.id}
              onDelete={onDelete}
              onJump={onJump}
              onReply={onReply}
              onUpdate={onUpdate}
            />
          ))
        )}
      </div>

      <div className="fp-composer fp-composer-hint-only">
        <div className="fp-composer-hint">
          <CrosshairIcon aria-hidden className="size-3" />
          <span>Select trace text to open an inline comment composer</span>
        </div>
      </div>
    </aside>
  );
}

function TraceCommentCard({
  active,
  comment,
  onDelete,
  onJump,
  onReply,
  onUpdate,
}: Readonly<{
  active: boolean;
  comment: TraceCommentItem;
  onDelete?: (commentId: string) => void;
  onJump: (row: number, flash?: boolean, anchor?: TraceTextAnchor) => void;
  onReply?: (commentId: string, draft: { body: string }) => void;
  onUpdate?: (commentId: string, update: { body: string }) => void;
}>) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftBody, setDraftBody] = useState(comment.body);
  const [isReplying, setIsReplying] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const jumpToComment = () => onJump(comment.anchor.row, true, comment.anchor);
  const canEdit = comment.canEdit && onUpdate;
  const canDelete = comment.canDelete && onDelete;
  const canReply = Boolean(onReply);
  const hasOwnedActions = Boolean(
    canEdit || canDelete || canReply || isEditing || isReplying
  );
  const startEdit = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setDraftBody(comment.body);
    setIsEditing(true);
  };
  const cancelEdit = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setDraftBody(comment.body);
    setIsEditing(false);
  };
  const saveEdit = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const body = draftBody.trim();
    if (!body) {
      return;
    }
    onUpdate?.(comment.id, { body });
    setIsEditing(false);
  };
  const deleteComment = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onDelete?.(comment.id);
  };
  const startReply = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setIsReplying(true);
  };
  const cancelReply = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setReplyBody("");
    setIsReplying(false);
  };
  const submitReply = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const body = replyBody.trim();
    if (!body) {
      return;
    }
    onReply?.(comment.id, { body });
    setReplyBody("");
    setIsReplying(false);
  };
  return (
    <CommentThreadCard
      className={cn("fp-comment-card", active && "is-active")}
      interactive
      onClick={jumpToComment}
      selected={active}
    >
      <CommentThreadAnchorPreview className="cursor-pointer">
        {comment.anchor.selectedText}
      </CommentThreadAnchorPreview>
      <CommentThreadMain
        actions={
          <span
            className={cn(
              "fp-comment-actions",
              hasOwnedActions && "is-visible"
            )}
          >
            {isEditing ? (
              <>
                <button
                  aria-label="Save trace note"
                  className="fp-icon-btn"
                  onClick={saveEdit}
                  title="Save"
                  type="button"
                >
                  <CheckIcon aria-hidden className="size-3" />
                </button>
                <button
                  aria-label="Cancel trace note edit"
                  className="fp-icon-btn"
                  onClick={cancelEdit}
                  title="Cancel"
                  type="button"
                >
                  <XIcon aria-hidden className="size-3" />
                </button>
              </>
            ) : (
              <>
                {canEdit ? (
                  <button
                    aria-label="Edit trace note"
                    className="fp-icon-btn"
                    onClick={startEdit}
                    title="Edit"
                    type="button"
                  >
                    <PencilIcon aria-hidden className="size-3" />
                  </button>
                ) : null}
                {canDelete ? (
                  <button
                    aria-label="Delete trace note"
                    className="fp-icon-btn"
                    onClick={deleteComment}
                    title="Delete"
                    type="button"
                  >
                    <Trash2Icon aria-hidden className="size-3" />
                  </button>
                ) : null}
              </>
            )}
            {canReply ? (
              <button
                aria-label="Reply to trace note"
                className="fp-icon-btn"
                onClick={startReply}
                title="Reply"
                type="button"
              >
                <CornerUpLeftIcon aria-hidden className="size-3" />
              </button>
            ) : null}
          </span>
        }
        avatar={
          <Avatar className="size-[26px]">
            <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
              AI
            </AvatarFallback>
          </Avatar>
        }
        className="fp-comment-main"
        content={
          <>
            <CommentThreadHeader
              author={
                <b className="text-xs">
                  {comment.authorName ?? "Unknown user"}
                </b>
              }
              metadata={
                <span className="fp-when">{comment.createdAtLabel}</span>
              }
            />
            {isEditing ? (
              <textarea
                aria-label="Edit trace note"
                className="mt-2 min-h-20 w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm"
                onChange={(event) => setDraftBody(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                value={draftBody}
              />
            ) : (
              <div className="fp-comment-text">{comment.body}</div>
            )}
            {comment.replies.length > 0 ? (
              <div className="fp-replies">
                {comment.replies.map((reply) => (
                  <div className="fp-reply" key={reply.id}>
                    <CommentThreadHeader
                      author={
                        <b className="text-xs">
                          {reply.authorName ?? "Unknown user"}
                        </b>
                      }
                      metadata={
                        <>
                          <span className="fp-when">
                            {reply.createdAtLabel}
                          </span>
                          {reply.canDelete && onDelete ? (
                            <span className="fp-comment-actions is-visible">
                              <button
                                aria-label="Delete trace reply"
                                className="fp-icon-btn"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onDelete(reply.id);
                                }}
                                title="Delete"
                                type="button"
                              >
                                <Trash2Icon aria-hidden className="size-3" />
                              </button>
                            </span>
                          ) : null}
                        </>
                      }
                    />
                    <div className="fp-reply-text">{reply.body}</div>
                  </div>
                ))}
              </div>
            ) : null}
            {isReplying ? (
              <div className="fp-reply-composer">
                <textarea
                  aria-label="Reply body"
                  onChange={(event) => setReplyBody(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  placeholder="Reply..."
                  value={replyBody}
                />
                <div className="fp-reply-composer-actions">
                  <button
                    aria-label="Save trace reply"
                    className="fp-icon-btn"
                    onClick={submitReply}
                    title="Save reply"
                    type="button"
                  >
                    <CheckIcon aria-hidden className="size-3" />
                  </button>
                  <button
                    aria-label="Cancel trace reply"
                    className="fp-icon-btn"
                    onClick={cancelReply}
                    title="Cancel reply"
                    type="button"
                  >
                    <XIcon aria-hidden className="size-3" />
                  </button>
                </div>
              </div>
            ) : null}
          </>
        }
      />
    </CommentThreadCard>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
