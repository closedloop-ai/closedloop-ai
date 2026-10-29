"use client";

import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import type { CollectionCapabilities } from "@repo/api/src/types/comment-capabilities";
import {
  type CommentDto,
  CommentSyncStatus,
  type CommentThreadDto,
} from "@repo/api/src/types/comment-thread-dto";
import { SyncAbandonedNotice } from "@repo/app/shared/trace-comments/sync-abandoned-notice";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  CommentThreadCard,
  CommentThreadHeader,
  CommentThreadMain,
  CommentThreadReplies,
  CommentThreadReplyRow,
} from "@repo/design-system/components/ui/comment-thread";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
import { cn } from "@repo/design-system/lib/utils";
import {
  CheckCircle2Icon,
  CheckIcon,
  CornerUpLeftIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  type CommentsPaneRenderComposer,
  CommentsPaneScopedComposer,
} from "./comments-pane-composer";
import type { CommentsPaneCallbacks } from "./comments-pane-contract";
import {
  type CommentsPaneAnchorStateLabels,
  type CommentsPaneDrafts,
  commentAffordances,
  deleteActionKey,
  editDraftKey,
  reopenActionKey,
  replyDraftKey,
  resolveActionKey,
  retrySyncActionKey,
  threadAffordances,
} from "./comments-pane-model";
import { CommentsPaneThreadAnchor } from "./comments-pane-thread-anchor";
import { ExternalSyncIndicator } from "./external-sync-indicator";
import type { SubmitWrite } from "./use-pending-submissions";

const INITIALS_SPLIT = /[\s-]+/;

/** What every part of a card reads; passed once rather than prop by prop. */
type CardContext = {
  callbacks: CommentsPaneCallbacks;
  capabilities: CollectionCapabilities;
  drafts: CommentsPaneDrafts;
  formatTimestamp: (iso: string) => string;
  isPending: (key: string) => boolean;
  renderBody?: (body: string, comment: CommentDto) => ReactNode;
  renderComposer?: CommentsPaneRenderComposer;
  submit: SubmitWrite;
};

export type CommentsPaneThreadCardProps = CardContext & {
  anchorActive: boolean;
  anchorStateLabels: CommentsPaneAnchorStateLabels;
  elementRef?: (element: HTMLElement | null) => void;
  revealable: boolean;
  selected: boolean;
  thread: CommentThreadDto;
};

const ACTION_ONLY = { clearDraft: false } as const;

/** One thread of the canonical pane; every control is capability AND permission gated. */
export function CommentsPaneThreadCard({
  anchorActive,
  anchorStateLabels,
  elementRef,
  revealable,
  selected,
  thread,
  ...ctx
}: Readonly<CommentsPaneThreadCardProps>) {
  const { callbacks, drafts } = ctx;
  const [root, ...replies] = thread.comments;
  const affordances = threadAffordances(ctx.capabilities, thread);
  const replyKey = replyDraftKey(thread.id);
  const [replyOpen, setReplyOpen] = useState(false);
  const canReply = affordances.reply && Boolean(callbacks.onReply);
  // A kept draft reopens its composer, so closing the rail never hides typing.
  const showReply = canReply && (replyOpen || Boolean(drafts[replyKey]?.body));
  const select = () => callbacks.onSelectThread?.(thread.id);
  const highlighted = selected || anchorActive;
  const cancelReply = () => {
    // Cancel is the explicit discard; nothing else drops a draft.
    callbacks.onDraftChange(replyKey, null);
    setReplyOpen(false);
  };

  return (
    <div data-thread-id={thread.id} ref={elementRef}>
      <CommentThreadCard
        aria-current={selected ? "true" : undefined}
        // `bg-card` would out-merge the selected `bg-accent`, so it is unselected-only.
        className={highlighted ? "border-primary/50" : "bg-card"}
        data-anchor-active={anchorActive ? "true" : undefined}
        data-anchor-state={thread.anchorState ?? undefined}
        data-sync-state={thread.sync?.state}
        data-thread-status={thread.status}
        interactive={Boolean(callbacks.onSelectThread)}
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("[data-comment-control]")
          ) {
            return;
          }
          select();
        }}
        onKeyDown={(event) => {
          if (
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            select();
          }
        }}
        role="group"
        selected={highlighted}
        tabIndex={callbacks.onSelectThread ? 0 : undefined}
      >
        <CommentsPaneThreadAnchor
          anchorStateLabels={anchorStateLabels}
          onReveal={
            revealable && callbacks.onRevealAnchor
              ? () => callbacks.onRevealAnchor?.(thread)
              : undefined
          }
          thread={thread}
        />
        {root ? (
          <RootComment
            affordances={affordances}
            comment={root}
            ctx={ctx}
            onOpenReply={() => setReplyOpen(true)}
            showReplyAction={canReply && !showReply}
            thread={thread}
          />
        ) : null}
        {replies.length > 0 ? (
          <CommentThreadReplies>
            {replies.map((reply) => (
              <ReplyComment
                comment={reply}
                ctx={ctx}
                key={reply.id}
                threadId={thread.id}
              />
            ))}
          </CommentThreadReplies>
        ) : null}
        {showReply ? (
          <CommentsPaneScopedComposer
            ariaLabel="Reply to comment"
            className="px-3 pb-3 sm:px-4"
            {...scopedComposerContext(ctx, replyKey)}
            onCancel={cancelReply}
            onSubmit={({ body, mentions }) =>
              ctx.submit(replyKey, async () => {
                await callbacks.onReply?.(thread.id, {
                  body,
                  ...(mentions ? { mentions } : {}),
                });
                setReplyOpen(false);
              })
            }
            placeholder="Reply..."
            submitLabel="Reply"
            value={drafts[replyKey]?.body ?? ""}
          />
        ) : null}
      </CommentThreadCard>
    </div>
  );
}

function RootComment({
  affordances,
  comment,
  ctx,
  onOpenReply,
  showReplyAction,
  thread,
}: Readonly<{
  affordances: ReturnType<typeof threadAffordances>;
  comment: CommentDto;
  ctx: CardContext;
  onOpenReply: () => void;
  showReplyAction: boolean;
  thread: CommentThreadDto;
}>) {
  const editing = useEditState(comment, ctx);
  const own = commentAffordances(ctx.capabilities, comment);
  const canEdit = own.edit && Boolean(ctx.callbacks.onEdit);
  const resolved = thread.status === ThreadStatus.Resolved;
  return (
    <CommentThreadMain
      actions={
        <RootActions
          affordances={affordances}
          canDelete={own.delete && Boolean(ctx.callbacks.onDelete)}
          canEdit={canEdit && !editing.open}
          commentId={comment.id}
          ctx={ctx}
          onOpenReply={onOpenReply}
          onStartEdit={editing.start}
          resolved={resolved}
          showReplyAction={showReplyAction}
          threadId={thread.id}
        />
      }
      avatar={<CommentAvatar comment={comment} />}
      content={
        <>
          <CommentThreadHeader
            author={
              <span className="font-medium text-sm">
                {comment.author.name ?? "Unknown user"}
              </span>
            }
            metadata={
              <>
                <span className="text-muted-foreground text-xs">
                  {ctx.formatTimestamp(comment.createdAt)}
                </span>
                {resolved ? <Chip size="sm">Resolved</Chip> : null}
                <ThreadSyncState
                  affordances={affordances}
                  comment={comment}
                  ctx={ctx}
                  thread={thread}
                />
              </>
            }
          />
          {thread.source === ThreadSource.Github ? (
            <ExternalSyncIndicator
              relationship={{
                href: affordances.linkOut ?? undefined,
                label: "GitHub",
                provider: "github",
              }}
            />
          ) : null}
          <CommentBody
            canEdit={canEdit}
            comment={comment}
            ctx={ctx}
            editing={editing}
          />
        </>
      }
    />
  );
}

function RootActions({
  affordances,
  canDelete,
  canEdit,
  commentId,
  ctx,
  onOpenReply,
  onStartEdit,
  resolved,
  showReplyAction,
  threadId,
}: Readonly<{
  affordances: ReturnType<typeof threadAffordances>;
  canDelete: boolean;
  canEdit: boolean;
  commentId: string;
  ctx: CardContext;
  onOpenReply: () => void;
  onStartEdit: () => void;
  resolved: boolean;
  showReplyAction: boolean;
  threadId: string;
}>) {
  const { callbacks, isPending, submit } = ctx;
  const canToggle = resolved
    ? affordances.reopen && Boolean(callbacks.onReopen)
    : affordances.resolve && Boolean(callbacks.onResolve);
  const toggleKey = resolved
    ? reopenActionKey(threadId)
    : resolveActionKey(threadId);
  const deleteKey = deleteActionKey(commentId);
  return (
    <div className="flex shrink-0 items-center gap-0.5" data-comment-control>
      {canToggle ? (
        <IconAction
          disabled={isPending(toggleKey)}
          label={resolved ? "Reopen comment" : "Resolve comment"}
          onClick={() =>
            submit(
              toggleKey,
              () =>
                resolved
                  ? callbacks.onReopen?.(threadId)
                  : callbacks.onResolve?.(threadId),
              ACTION_ONLY
            )
          }
        >
          {resolved ? (
            <CheckCircle2Icon aria-hidden className="size-3.5 text-success" />
          ) : (
            <CheckIcon aria-hidden className="size-3.5" />
          )}
        </IconAction>
      ) : null}
      {canEdit ? (
        <IconAction label="Edit comment" onClick={onStartEdit}>
          <PencilIcon aria-hidden className="size-3.5" />
        </IconAction>
      ) : null}
      {canDelete ? (
        <IconAction
          disabled={isPending(deleteKey)}
          label="Delete thread"
          onClick={() =>
            submit(
              deleteKey,
              () => callbacks.onDelete?.({ commentId, threadId }),
              ACTION_ONLY
            )
          }
        >
          <Trash2Icon aria-hidden className="size-3.5" />
        </IconAction>
      ) : null}
      {showReplyAction ? (
        <IconAction label="Reply to comment" onClick={onOpenReply}>
          <CornerUpLeftIcon aria-hidden className="size-3.5" />
        </IconAction>
      ) : null}
    </div>
  );
}

function ReplyComment({
  comment,
  ctx,
  threadId,
}: Readonly<{ comment: CommentDto; ctx: CardContext; threadId: string }>) {
  const editing = useEditState(comment, ctx);
  const own = commentAffordances(ctx.capabilities, comment);
  const canEdit = own.edit && Boolean(ctx.callbacks.onEdit);
  const canDelete = own.delete && Boolean(ctx.callbacks.onDelete);
  const deleteKey = deleteActionKey(comment.id);
  return (
    <CommentThreadReplyRow
      actions={
        <div
          className="flex shrink-0 items-center gap-0.5"
          data-comment-control
        >
          {canEdit && !editing.open ? (
            <IconAction label="Edit comment" onClick={editing.start}>
              <PencilIcon aria-hidden className="size-3.5" />
            </IconAction>
          ) : null}
          {canDelete ? (
            <IconAction
              disabled={ctx.isPending(deleteKey)}
              label="Delete reply"
              onClick={() =>
                ctx.submit(
                  deleteKey,
                  () =>
                    ctx.callbacks.onDelete?.({
                      commentId: comment.id,
                      threadId,
                    }),
                  ACTION_ONLY
                )
              }
            >
              <Trash2Icon aria-hidden className="size-3.5" />
            </IconAction>
          ) : null}
        </div>
      }
      avatar={<CommentAvatar comment={comment} compact />}
      body={
        <CommentBody
          canEdit={canEdit}
          comment={comment}
          ctx={ctx}
          editing={editing}
        />
      }
      header={
        <CommentThreadHeader
          author={
            <span className="font-medium text-xs">
              {comment.author.name ?? "Unknown user"}
            </span>
          }
          metadata={
            <span className="text-muted-foreground text-xs">
              {ctx.formatTimestamp(comment.createdAt)}
            </span>
          }
        />
      }
    />
  );
}

/**
 * Pending is the desktop outbox (not yet accepted); a failed or abandoned
 * delivery reuses the shared dead-letter notice and its retry door.
 */
function ThreadSyncState({
  affordances,
  comment,
  ctx,
  thread,
}: Readonly<{
  affordances: ReturnType<typeof threadAffordances>;
  comment: CommentDto;
  ctx: CardContext;
  thread: CommentThreadDto;
}>) {
  const state = thread.sync?.state;
  const { onRetrySync } = ctx.callbacks;
  if (state === CommentSyncStatus.Pending) {
    return (
      <Badge role="status" variant="muted">
        Pending
      </Badge>
    );
  }
  if (
    state !== CommentSyncStatus.Failed &&
    state !== CommentSyncStatus.Abandoned
  ) {
    return null;
  }
  return (
    <SyncAbandonedNotice
      commentId={thread.id}
      isAuthor={comment.permissions.canEdit}
      onRetrySync={
        affordances.retrySync && onRetrySync
          ? (threadId) =>
              ctx.submit(
                retrySyncActionKey(threadId),
                () => onRetrySync(threadId),
                ACTION_ONLY
              )
          : undefined
      }
    />
  );
}

function CommentBody({
  canEdit,
  comment,
  ctx,
  editing,
}: Readonly<{
  canEdit: boolean;
  comment: CommentDto;
  ctx: CardContext;
  editing: ReturnType<typeof useEditState>;
}>) {
  const key = editDraftKey(comment.id);
  if (!(editing.open && canEdit)) {
    return (
      <div className="whitespace-pre-wrap break-words text-sm">
        {ctx.renderBody?.(comment.body, comment) ?? comment.body}
      </div>
    );
  }
  return (
    <CommentsPaneScopedComposer
      ariaLabel="Edit comment"
      {...scopedComposerContext(ctx, key)}
      initialMentions={comment.mentions}
      onCancel={() => {
        ctx.callbacks.onDraftChange(key, null);
        editing.stop();
      }}
      onSubmit={({ body, mentions }) =>
        ctx.submit(key, async () => {
          await ctx.callbacks.onEdit?.(comment.id, {
            body,
            expectedRevision: ctx.drafts[key]?.baseRevision ?? comment.revision,
            ...(mentions ? { mentions } : {}),
          });
          editing.stop();
        })
      }
      placeholder="Edit comment"
      submitLabel="Save"
      value={ctx.drafts[key]?.body ?? comment.body}
    />
  );
}

function scopedComposerContext(ctx: CardContext, draftKey: string) {
  return {
    draft: ctx.drafts[draftKey],
    draftKey,
    isPending: ctx.isPending(draftKey),
    onDraftChange: ctx.callbacks.onDraftChange,
    renderComposer: ctx.renderComposer,
  };
}

function useEditState(comment: CommentDto, ctx: CardContext) {
  const [open, setOpen] = useState(false);
  const key = editDraftKey(comment.id);
  const hasDraft = ctx.drafts[key] !== undefined;
  return {
    open: open || hasDraft,
    // The draft is born with the revision being edited, and keeps it through
    // refetches and rail remounts; see `CommentsPaneDraft.baseRevision`.
    start: () => {
      ctx.callbacks.onDraftChange(key, {
        body: comment.body,
        baseRevision: comment.revision,
      });
      setOpen(true);
    },
    stop: () => setOpen(false),
  };
}

function CommentAvatar({
  comment,
  compact = false,
}: Readonly<{ comment: CommentDto; compact?: boolean }>) {
  const name = comment.author.name ?? "";
  return (
    <PersonAvatar
      avatarUrl={comment.author.avatarUrl}
      className={cn("shrink-0", compact ? "size-6" : "size-7")}
      fallbackClassName="text-xs"
      initials={initials(name)}
      name={name}
    />
  );
}

function IconAction({
  children,
  disabled = false,
  label,
  onClick,
}: Readonly<{
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}>) {
  return (
    <Button
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      size="icon-sm"
      title={label}
      type="button"
      variant="ghost"
    >
      {children}
    </Button>
  );
}

function initials(name: string): string {
  const parts = name.split(INITIALS_SPLIT).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}
