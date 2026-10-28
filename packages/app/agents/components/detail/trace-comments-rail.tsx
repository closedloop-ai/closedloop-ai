"use client";

import { clamp } from "@repo/api/src/utils/math";
import {
  type MentionUser,
  resolveMentionLabel,
  seedMentionsFromIds,
} from "@repo/app/shared/lib/mentions";
import type { SortDirection } from "@repo/app/shared/lib/table-utils";
import { SyncAbandonedNotice } from "@repo/app/shared/trace-comments/sync-abandoned-notice";
import { OrgMentionComposer } from "@repo/app/users/components/org-mention-composer";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import {
  CommentThreadAnchorPreview,
  CommentThreadCard,
  CommentThreadHeader,
  CommentThreadMain,
} from "@repo/design-system/components/ui/comment-thread";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
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
  onRetrySync,
  onUpdate,
  onWidthChange,
  selectedThreadId,
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
  /**
   * ISS-8597: re-pend a comment whose sync was permanently rejected. Undefined
   * when the surface's source cannot dead-letter one, which is what suppresses
   * the retry affordance rather than a second flag.
   */
  onRetrySync?: (commentId: string) => void;
  onUpdate?: (
    commentId: string,
    update: { body: string; mentions?: string[] }
  ) => void;
  onWidthChange?: (width: number) => void;
  /**
   * ISS-11004: the comment a `?comment=` link addressed, which the Session
   * Activity tab's comment rows point at. That thread reads as the active one
   * and is scrolled into view, so the reader lands on the comment the link
   * named rather than at the top of an unfamiliar rail. Undefined on a surface
   * with no such link, which leaves Branch's rail exactly as it was.
   */
  selectedThreadId?: string | null;
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
  const streamRef = useRef<HTMLDivElement>(null);
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

  // ISS-11004: reveal the thread a link addressed, ONCE per address. The rail
  // re-renders on every comment refresh, so re-scrolling whenever the list changes
  // would keep yanking a reader who has since scrolled away. The marker is set
  // only when the card was actually found and scrolled — an address that
  // arrives before its comments have rendered retries on the next render
  // instead of being recorded as done — and cleared when the address goes, so
  // addressing the same comment again later scrolls again.
  const revealedThreadIdRef = useRef<string | null>(null);
  const selectedIsRendered = sortedComments.some(
    (comment) => comment.threadId === selectedThreadId
  );
  useEffect(() => {
    if (!selectedThreadId) {
      revealedThreadIdRef.current = null;
      return;
    }
    if (
      !selectedIsRendered ||
      revealedThreadIdRef.current === selectedThreadId
    ) {
      return;
    }
    const card = findCommentCard(streamRef.current, selectedThreadId);
    if (!card) {
      return;
    }
    revealedThreadIdRef.current = selectedThreadId;
    card.scrollIntoView({ block: "nearest" });
  }, [selectedThreadId, selectedIsRendered]);
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

      <div className="fp-stream" ref={streamRef}>
        {sortedComments.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="font-medium text-sm">{TRACE_COMMENTS_EMPTY_TITLE}</p>
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
              onRetrySync={onRetrySync}
              onUpdate={onUpdate}
              resolveMentions={resolveMentions}
              selected={comment.threadId === selectedThreadId}
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

/**
 * The retry handler this viewer may have, which is none unless they wrote the
 * comment.
 *
 * `packages/api/src/types/comment.ts` says the author is the only one who can
 * move a dead-lettered row, and the server answers `forbidden` to anyone else.
 * Authorship used to be implicit: while `syncAbandoned` came only from the
 * desktop's local queue it could describe nothing but the local user's own
 * outgoing rows. ISS-10382 has the cloud serve the field to every viewer of the
 * thread, so the implication is gone and the check has to be explicit — or a
 * reader gets a button that can only fail.
 */
function retryHandlerFor(
  comment: TraceCommentItem,
  onRetrySync?: (commentId: string) => void
): ((commentId: string) => void) | undefined {
  return comment.canEdit ? onRetrySync : undefined;
}

function TraceCommentCard({
  active,
  comment,
  mentionUsersById,
  onDelete,
  onJump,
  onReply,
  onRetrySync,
  onUpdate,
  resolveMentions,
  selected,
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
  onRetrySync?: (commentId: string) => void;
  onUpdate?: (
    commentId: string,
    update: { body: string; mentions?: string[] }
  ) => void;
  resolveMentions: MentionResolver;
  /** True for the thread a `?comment=` link addressed (ISS-11004). */
  selected: boolean;
}>) {
  const selectionChrome = commentCardSelectionChrome(active, selected);
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
      aria-current={selectionChrome.ariaCurrent}
      className={cn(
        "fp-comment-card",
        selectionChrome.highlighted && "is-active"
      )}
      data-comment-thread-id={comment.threadId}
      interactive
      onClick={jumpToComment}
      selected={selectionChrome.highlighted}
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
          // ISS-12269: this drew a fixed "AI" for every author, whoever wrote
          // the comment. The adjacent header states the name, so the picture
          // is decorative.
          <PersonAvatar
            avatarUrl={comment.authorAvatarUrl}
            className="size-[26px]"
            decorative
            fallbackClassName="text-[10px]"
            name={commentAuthorName(comment.authorName)}
          />
        }
        className="fp-comment-main"
        content={
          <>
            <CommentThreadHeader
              author={
                <b className="text-xs">
                  {commentAuthorName(comment.authorName)}
                </b>
              }
              metadata={
                <>
                  <span className="fp-when">{comment.createdAtLabel}</span>
                  {/*
                   * Mounted only for a comment that is actually dead-lettered,
                   * which since the 2026-09-16 ruling is the whole gate: the
                   * field is only ever set by the flag-gated terminal write. A
                   * rail of ordinary comments mounts none of these and opens no
                   * subscription, because there is no longer a flag read here to
                   * open one.
                   */}
                  {comment.syncAbandoned === true ? (
                    <SyncAbandonedNotice
                      commentId={comment.id}
                      // ISS-10827: the same authorship `retryHandlerFor` gates
                      // the door on, passed explicitly — a reader must not be
                      // told their own delivery failed.
                      isAuthor={comment.canEdit}
                      onRetrySync={retryHandlerFor(comment, onRetrySync)}
                    />
                  ) : null}
                </>
              }
            />
            {isEditing ? (
              <div className="mt-2">
                <OrgMentionComposer
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
                          {commentAuthorName(reply.authorName)}
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
                <OrgMentionComposer
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

export const TRACE_COMMENTS_EMPTY_TITLE = "No trace comments yet";

/**
 * The rendered card for one thread id, matched by attribute rather than a
 * built selector so an id carrying selector syntax cannot break the query.
 */
function findCommentCard(
  stream: HTMLDivElement | null,
  threadId: string
): Element | null {
  if (!stream) {
    return null;
  }
  for (const card of stream.querySelectorAll("[data-comment-thread-id]")) {
    if (card.getAttribute("data-comment-thread-id") === threadId) {
      return card;
    }
  }
  return null;
}

/**
 * How a card reads when it is the active trace row, the addressed comment, or
 * both. `aria-current` states the addressed one in the accessibility tree, so
 * it is never identified by its background alone (WCAG 1.4.1).
 */
function commentCardSelectionChrome(
  active: boolean,
  selected: boolean
): { ariaCurrent: "true" | undefined; highlighted: boolean } {
  return {
    ariaCurrent: selected ? "true" : undefined,
    highlighted: active || selected,
  };
}

/** The shipped fallback for a comment whose author identity did not resolve. */
const UNKNOWN_COMMENT_AUTHOR_LABEL = "Unknown user";

/** The shipped fallback for an author identity that did not resolve. */
function commentAuthorName(authorName: string | null): string {
  return authorName ?? UNKNOWN_COMMENT_AUTHOR_LABEL;
}
