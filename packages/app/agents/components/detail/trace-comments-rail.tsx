"use client";

import { clamp } from "@repo/api/src/utils/math";
import { MentionComposer } from "@repo/app/shared/components/mention-composer";
import {
  type MentionUser,
  resolveMentionLabel,
  seedMentionsFromIds,
} from "@repo/app/shared/lib/mentions";
import type { SortDirection } from "@repo/app/shared/lib/table-utils";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
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
  ArrowDownWideNarrowIcon,
  ArrowUpNarrowWideIcon,
  AtSignIcon,
  CornerUpLeftIcon,
  CrosshairIcon,
  PanelRightCloseIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sortByCreatedAtThenId } from "./comment-sort";
import type { TraceCommentItem, TraceTextAnchor } from "./trace-comments";

/** A resolved mention chip: the stable user id plus its display label. */
type ResolvedMention = { id: string; label: string };

/** Resolves a persisted mention user-ID list to labeled chips. */
type MentionResolver = (userIds: readonly string[]) => ResolvedMention[];

/**
 * Render order for the comments rail, reusing the canonical `SortDirection`
 * union rather than re-declaring the members. `desc` = newest-first (the
 * default), `asc` = oldest-first. The sort is applied client-side over the
 * already-fetched list; toggling it never triggers a network round-trip.
 */
type CommentSortDir = SortDirection;

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
  traceIdentity,
  width,
}: Readonly<{
  activeRow?: number | null;
  comments: readonly TraceCommentItem[];
  onCollapse?: () => void;
  onDelete?: (commentId: string) => void;
  onJump: (row: number, flash?: boolean, anchor?: TraceTextAnchor) => void;
  onReply?: (
    commentId: string,
    draft: { body: string; mentions?: string[] }
  ) => void;
  onUpdate?: (
    commentId: string,
    update: { body: string; mentions?: string[] }
  ) => void;
  onWidthChange?: (width: number) => void;
  /**
   * Stable identity of the trace this rail is showing (the session/branch id).
   * The rail is reused across same-component session/branch navigation, so the
   * sort order is reset to the default whenever this changes — per-entity UI
   * state must not leak across targets (packages/app/AGENTS.md).
   */
  traceIdentity?: string;
  width?: number;
}>) {
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // Client-side render order for the rail. Default `desc` = newest-first; the
  // sort button toggles it and re-orders the already-fetched list in place (no
  // refetch). Owned here because the rail holds the array it renders.
  const [sortDir, setSortDir] = useState<CommentSortDir>("desc");
  // Reset the sort back to newest-first when the rail is pointed at a different
  // trace (session/branch), so a non-default order chosen for one target does
  // not carry into the next. Adjusting state during render is the React-endorsed
  // way to reset on a prop change without an effect round-trip.
  const [lastTraceIdentity, setLastTraceIdentity] = useState(traceIdentity);
  if (traceIdentity !== lastTraceIdentity) {
    setLastTraceIdentity(traceIdentity);
    setSortDir("desc");
  }
  const toggleSortDir = useCallback(
    () => setSortDir((prev) => (prev === "desc" ? "asc" : "desc")),
    []
  );
  const sortedComments = useMemo(
    () => sortByCreatedAtThenId(comments, sortDir),
    [comments, sortDir]
  );
  // FEA-3490: resolve persisted mention IDs → display labels for @-chips, and
  // seed the edit composer so an edit preserves existing mentions.
  const { data: users } = useOrganizationUsers();
  const usersById = useMemo(() => {
    const map = new Map<string, MentionUser>();
    for (const user of users ?? []) {
      map.set(user.id, {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        active: user.active,
      });
    }
    return map;
  }, [users]);
  const resolveMentions = useCallback<MentionResolver>(
    (userIds) =>
      userIds.map((id) => ({
        id,
        label: resolveMentionLabel(id, usersById),
      })),
    [usersById]
  );
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
          {/*
           * ISS-5818 (D5): a real `h2`, matching the prototype's
           * `session-comments-panel.tsx:70`. The rail is the page's third
           * section and was its third `span`-as-heading, so leaving it behind
           * while the Timeline and Trace gained headings would give a screen
           * reader a document outline that stops two thirds of the way down.
           *
           * No `section[aria-labelledby]` here, unlike the other two: this rail
           * is already an `<aside>`, which IS a landmark — wrapping it in a
           * region would nest two landmarks around one panel, which is what the
           * prototype does too. The heading gives the rail a document-outline
           * entry; it does NOT name the landmark (a `complementary` role takes
           * its name only from the author), so the aside is still unnamed — the
           * same as before ISS-5818, and worth an `aria-labelledby` of its own
           * rather than a claim here that it already has one.
           *
           * `fp-title` carries the styling, so the heading does not inherit a
           * browser `h2`'s default size.
           */}
          <h2 className="fp-title">
            Comments <span className="fp-count">{comments.length}</span>
          </h2>
          <div className="fp-head-actions">
            <button
              aria-label={
                sortDir === "desc"
                  ? "Sort comments (newest first)"
                  : "Sort comments (oldest first)"
              }
              aria-pressed={sortDir === "asc"}
              className="fp-icon-btn fp-sort-btn"
              onClick={toggleSortDir}
              title={
                sortDir === "desc" ? "Sort: newest first" : "Sort: oldest first"
              }
              type="button"
            >
              {sortDir === "desc" ? (
                <ArrowDownWideNarrowIcon aria-hidden className="size-3.5" />
              ) : (
                <ArrowUpNarrowWideIcon aria-hidden className="size-3.5" />
              )}
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
        {sortedComments.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="font-medium text-sm">No trace comments yet</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Select trace text to anchor the next comment.
            </p>
          </div>
        ) : (
          sortedComments.map((comment) => (
            <TraceCommentCard
              active={comment.anchor.row === activeRow}
              comment={comment}
              key={comment.id}
              mentionUsersById={usersById}
              onDelete={onDelete}
              onJump={onJump}
              onReply={onReply}
              onUpdate={onUpdate}
              resolveMentions={resolveMentions}
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
  mentionUsersById,
  onDelete,
  onJump,
  onReply,
  onUpdate,
  resolveMentions,
}: Readonly<{
  active: boolean;
  comment: TraceCommentItem;
  mentionUsersById: ReadonlyMap<string, MentionUser>;
  onDelete?: (commentId: string) => void;
  onJump: (row: number, flash?: boolean, anchor?: TraceTextAnchor) => void;
  onReply?: (
    commentId: string,
    draft: { body: string; mentions?: string[] }
  ) => void;
  onUpdate?: (
    commentId: string,
    update: { body: string; mentions?: string[] }
  ) => void;
  resolveMentions: MentionResolver;
}>) {
  const [isEditing, setIsEditing] = useState(false);
  const [isReplying, setIsReplying] = useState(false);
  const jumpToComment = (event: ReactMouseEvent<HTMLDivElement>) => {
    // A click inside an inline composer (edit/reply) or an action control must
    // not also jump the trace to this row. The composer and its controls carry
    // `data-comment-control`, so a click originating within one is ignored here.
    if (
      event.target instanceof Element &&
      event.target.closest("[data-comment-control]")
    ) {
      return;
    }
    onJump(comment.anchor.row, true, comment.anchor);
  };
  const canEdit = comment.canEdit && onUpdate;
  const canDelete = comment.canDelete && onDelete;
  const canReply = Boolean(onReply);
  const hasOwnedActions = Boolean(
    canEdit || canDelete || canReply || isEditing || isReplying
  );
  // Seed the edit composer with the comment's existing @-mentions so an edit
  // that leaves the "@Name" tokens intact preserves them (FEA-3490).
  const editMentionSeed = seedMentionsFromIds(
    comment.mentions ?? [],
    mentionUsersById
  );
  const startEdit = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setIsEditing(true);
  };
  const cancelEdit = () => setIsEditing(false);
  const saveEdit = (payload: { body: string; mentions: string[] }) => {
    onUpdate?.(comment.id, { body: payload.body, mentions: payload.mentions });
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
  const cancelReply = () => setIsReplying(false);
  const submitReply = (payload: { body: string; mentions: string[] }) => {
    onReply?.(comment.id, { body: payload.body, mentions: payload.mentions });
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
            {isEditing ? null : (
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
            {canReply && !(isEditing || isReplying) ? (
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
              <div className="mt-2">
                <MentionComposer
                  autoFocus
                  cancelLabel="Cancel"
                  defaultValue={comment.body}
                  initialMentions={editMentionSeed}
                  onCancel={cancelEdit}
                  onSubmit={saveEdit}
                  placeholder="Edit comment"
                  submitLabel="Save"
                />
              </div>
            ) : (
              <>
                <div className="fp-comment-text">{comment.body}</div>
                <MentionChips
                  mentions={resolveMentions(comment.mentions ?? [])}
                />
              </>
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
                    <MentionChips
                      mentions={resolveMentions(reply.mentions ?? [])}
                    />
                  </div>
                ))}
              </div>
            ) : null}
            {isReplying ? (
              <div className="fp-reply-composer">
                <MentionComposer
                  autoFocus
                  cancelLabel="Cancel"
                  onCancel={cancelReply}
                  onSubmit={submitReply}
                  placeholder="Reply..."
                  submitLabel="Reply"
                />
              </div>
            ) : null}
          </>
        }
      />
    </CommentThreadCard>
  );
}

/**
 * Renders resolved @-mention display labels as chips beneath a trace comment or
 * reply body (FEA-3490). Renders nothing when there are no mentions, so a
 * mention-free comment (or the flag-off path, which yields no labels) is
 * unchanged.
 */
function MentionChips({
  mentions,
}: Readonly<{ mentions: readonly ResolvedMention[] }>) {
  if (mentions.length === 0) {
    return null;
  }
  return (
    <div
      className="mt-1 flex flex-wrap gap-1"
      data-testid="trace-mention-chips"
    >
      {mentions.map((mention) => (
        <span
          className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 font-medium text-[11px] text-primary"
          key={mention.id}
        >
          <AtSignIcon aria-hidden className="size-2.5" />
          {mention.label}
        </span>
      ))}
    </div>
  );
}
