"use client";

import type { ThreadStatus } from "@repo/api/src/types/comment";
import { ThreadStatus as ThreadStatusValue } from "@repo/api/src/types/comment";
import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import { MentionComposer } from "@repo/app/shared/components/mention-composer";
import {
  formatDateTimeOrFallback,
  formatRelativeTimeOrFallback,
} from "@repo/app/shared/lib/date-utils";
import { mentionDisplayName } from "@repo/app/shared/lib/mentions";
import {
  useCurrentUser,
  useOrganizationUsers,
} from "@repo/app/users/hooks/use-users";
import { Button } from "@repo/design-system/components/ui/button";
import { CollapsibleSection } from "@repo/design-system/components/ui/collapsible-section";
import {
  CommentThreadCard,
  CommentThreadHeader,
  CommentThreadMain,
  CommentThreadReplies,
  CommentThreadReplyRow,
} from "@repo/design-system/components/ui/comment-thread";
import { CommentThreadActionFooter } from "@repo/design-system/components/ui/comment-thread-action-footer";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Label } from "@repo/design-system/components/ui/label";
import { Separator } from "@repo/design-system/components/ui/separator";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { CheckCheck, MessageSquare, RotateCcw } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
  canReopenDocumentThread,
  canResolveDocumentThread,
  useCreateDocumentComment,
  useDocumentComments,
  useReplyToDocumentComment,
  useToggleDocumentThreadResolved,
} from "../hooks/use-document-comments";
import { renderCommentBody } from "../lib/render-comment-body";

export type CommentAuthor = {
  name: string;
  avatarUrl?: string | null;
};

export type CommentReplyItem = {
  id: string;
  authorId: string | null;
  author: CommentAuthor;
  body: string;
  createdAt: string;
};

export type CommentThreadItem = {
  id: string;
  /** Thread creator (root comment author) — the reopen-permission subject. */
  authorId: string | null;
  status: ThreadStatus;
  /** Display name of whoever resolved the thread, for the resolved caption. */
  resolvedByName: string | null;
  /** Author + every replier id — the participant-resolve permission set. */
  participantIds: readonly string[];
  author: CommentAuthor;
  body: string;
  createdAt: string;
  replies?: CommentReplyItem[];
};

type CommentsSectionProps = {
  documentId: string;
  defaultOpen?: boolean;
};

/**
 * Presentational Comments section props. `onSubmitComment` is REQUIRED so a
 * caller can never mount a composer whose submit silently drops the typed
 * comment (the FEA-3910 no-op). The connected `CommentsSection` supplies it
 * from its own create mutation; Storybook/tests supply an equivalent handler.
 * The reply and resolve handlers are optional so a read-only mount (a viewer
 * with no write path wired) never renders controls that do nothing.
 */
type CommentsSectionViewProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  comments?: CommentThreadItem[];
  /**
   * True while the thread read is in flight (before any list has arrived). Kept
   * distinct from "loaded empty" so the "No comments yet" empty state never
   * claims there are no threads before the read has settled.
   */
  isLoading?: boolean;
  /** Current viewer id — drives the participant-resolve / reopen permission. */
  viewerId?: string | null;
  /** Active org member display names, for chipping "@Name" runs on read. */
  mentionNames?: readonly string[];
  disabled?: boolean;
  isSubmitting?: boolean;
  /** True while a reply post is in flight — disables the open reply composer. */
  isReplyPending?: boolean;
  /**
   * Clock the thread timestamps are formatted against. Defaults to the real
   * clock; pass a fixed instant from a story or test that needs a deterministic
   * relative label (ISS-5286). Threading this is what lets a story pin its
   * fixtures AND still show a just-posted comment reading as "Just now" rather
   * than as the same absolute date as its month-old seeds.
   */
  now?: Date | number;
  onSubmitComment: (body: string) => unknown;
  onReply?: (threadId: string, body: string) => unknown;
  onToggleResolved?: (threadId: string, nextResolved: boolean) => void;
};

/**
 * Connected Comments section for a document/FEAT detail page — the artifact-level
 * comment rail. Owns its own read (`useDocumentComments`) plus create, reply, and
 * resolve/reopen mutations against `/documents/:id/threads` and its sub-routes,
 * so a mount site cannot forget to wire a write path. The list reads from the
 * same artifact-level thread store the writes post to. The read is deferred until
 * the section is expanded so an unopened section adds no on-mount request to the
 * document page; the org-member list the composer and mention chips need loads
 * with the same gate.
 */
export function CommentsSection({
  documentId,
  defaultOpen = false,
}: Readonly<CommentsSectionProps>) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const { data: comments, isLoading: isLoadingComments } = useDocumentComments(
    documentId,
    isOpen
  );
  const { data: currentUser } = useCurrentUser({ enabled: isOpen });
  const { data: orgUsers } = useOrganizationUsers({ enabled: isOpen });
  const createComment = useCreateDocumentComment(documentId);
  const replyToComment = useReplyToDocumentComment(documentId);
  const toggleResolved = useToggleDocumentThreadResolved(documentId);

  const mentionNames = useMemo(
    () =>
      (orgUsers ?? [])
        .filter((user) => user.active)
        .map((user) => mentionDisplayName(user)),
    [orgUsers]
  );

  return (
    <CommentsSectionView
      comments={comments ?? []}
      isLoading={isLoadingComments}
      isReplyPending={replyToComment.isPending}
      isSubmitting={createComment.isPending}
      mentionNames={mentionNames}
      onOpenChange={setIsOpen}
      // Return the mutation promise so the composer retains the draft on a
      // failed post and clears it only on success (the global QueryClient
      // surfaces the error toast).
      onReply={(threadId, body) =>
        replyToComment.mutateAsync({ threadId, body })
      }
      onSubmitComment={(body) => createComment.mutateAsync(body)}
      onToggleResolved={(threadId, nextResolved) =>
        toggleResolved.mutate({ threadId, nextResolved })
      }
      open={isOpen}
      viewerId={currentUser?.id}
    />
  );
}

export function CommentsSectionView({
  open,
  onOpenChange,
  comments = [],
  isLoading = false,
  viewerId,
  mentionNames = [],
  disabled = false,
  isSubmitting = false,
  isReplyPending = false,
  now,
  onSubmitComment,
  onReply,
  onToggleResolved,
}: Readonly<CommentsSectionViewProps>) {
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const composerLabelId = useId();

  const openThreads = comments.filter(
    (thread) => thread.status !== ThreadStatusValue.Resolved
  );
  const resolvedThreads = comments.filter(
    (thread) => thread.status === ThreadStatusValue.Resolved
  );
  const hasComments = comments.length > 0;

  // One card renderer for both the open and resolved lists so the wiring stays
  // in a single place.
  const renderThreadCard = (thread: CommentThreadItem) => (
    <CommentThreadItemCard
      isReplyOpen={replyingToId === thread.id}
      isReplyPending={isReplyPending}
      key={thread.id}
      mentionNames={mentionNames}
      now={now}
      onCloseReply={() => setReplyingToId(null)}
      onOpenReply={() => setReplyingToId(thread.id)}
      onReply={onReply}
      onToggleResolved={onToggleResolved}
      thread={thread}
      viewerId={viewerId}
    />
  );

  return (
    <CollapsibleSection
      onOpenChange={onOpenChange}
      open={open}
      title="Comments"
    >
      <div className="space-y-4">
        {hasComments ? (
          <div className="space-y-3">
            {openThreads.map((thread) => renderThreadCard(thread))}
            {openThreads.length === 0 ? (
              <p className="text-muted-foreground text-sm">No open threads.</p>
            ) : null}
            {resolvedThreads.length > 0 ? (
              <div className="space-y-3">
                <Button
                  aria-expanded={showResolved}
                  className="h-auto w-fit p-0 font-medium text-muted-foreground text-sm hover:text-foreground hover:no-underline"
                  onClick={() => setShowResolved((prev) => !prev)}
                  variant="link"
                >
                  {showResolved ? "Hide" : "Show"} {resolvedThreads.length}{" "}
                  resolved
                </Button>
                {showResolved
                  ? resolvedThreads.map((thread) => renderThreadCard(thread))
                  : null}
              </div>
            ) : null}
          </div>
        ) : (
          <CommentsPlaceholder isLoading={isLoading} />
        )}
        <Separator />
        <div className="flex flex-col gap-2">
          <Label className="text-sm" id={composerLabelId}>
            Add a comment
          </Label>
          <MentionComposer
            disabled={disabled}
            isPending={isSubmitting}
            labelledBy={composerLabelId}
            onSubmit={({ body }) => onSubmitComment(body)}
            placeholder="Share feedback or ask a question…"
            submitLabel="Comment"
          />
        </div>
      </div>
    </CollapsibleSection>
  );
}

/**
 * Placeholder shown when there are no threads to render. While the read is in
 * flight it draws skeleton rows so the section never asserts "No comments yet"
 * before the list has settled; once the read resolves empty it shows the real
 * empty state.
 */
function CommentsPlaceholder({ isLoading }: Readonly<{ isLoading: boolean }>) {
  if (isLoading) {
    return (
      <div aria-hidden className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  return (
    <EmptyState
      description="Start a discussion, capture feedback, or ask for clarification on this artifact."
      icon={MessageSquare}
      size="compact"
      title="No comments yet"
    />
  );
}

function ThreadTimestamp({
  createdAt,
  now,
}: Readonly<{ createdAt: string; now?: Date | number }>) {
  return (
    <span
      className="text-muted-foreground text-xs"
      title={formatDateTimeOrFallback(createdAt)}
    >
      {formatRelativeTimeOrFallback(createdAt, { now })}
    </span>
  );
}

function CommentThreadItemCard({
  thread,
  viewerId,
  mentionNames,
  isReplyOpen,
  isReplyPending,
  now,
  onOpenReply,
  onCloseReply,
  onReply,
  onToggleResolved,
}: Readonly<{
  thread: CommentThreadItem;
  viewerId?: string | null;
  mentionNames: readonly string[];
  isReplyOpen: boolean;
  isReplyPending: boolean;
  now?: Date | number;
  onOpenReply: () => void;
  onCloseReply: () => void;
  onReply?: (threadId: string, body: string) => unknown;
  onToggleResolved?: (threadId: string, nextResolved: boolean) => void;
}>) {
  const isResolved = thread.status === ThreadStatusValue.Resolved;
  // Resolve is participant-scoped (author or any replier); reopen is author-only.
  // A control is only offered when the viewer can take that action AND a handler
  // is wired, so the menu never lies about what the viewer can do.
  const canToggle = isResolved
    ? canReopenDocumentThread(thread, viewerId)
    : canResolveDocumentThread(thread, viewerId);
  const onResolveAction =
    onToggleResolved && canToggle
      ? () => onToggleResolved(thread.id, !isResolved)
      : undefined;

  const resolveLabel = isResolved ? "Reopen thread" : "Resolve thread";

  return (
    <CommentThreadCard>
      <CommentThreadMain
        actions={
          // Resolve is the only action the document-thread backend exposes
          // (there is no edit/delete route), so a single icon-only control is
          // rendered rather than an action menu with disabled edit/delete items
          // that would misrepresent what the viewer can do. Icon-only ⇒ real
          // aria-label (WCAG 4.1.2). Reopen uses the revert icon (RotateCcw, our
          // canonical undo glyph) so it reads as "undo resolve" rather than a
          // second checkmark; resolve uses a plain check.
          onResolveAction ? (
            <Button
              aria-label={resolveLabel}
              className="h-7 w-7 shrink-0"
              onClick={onResolveAction}
              size="icon"
              title={resolveLabel}
              variant="ghost"
            >
              {isResolved ? (
                <RotateCcw aria-hidden className="size-3.5" />
              ) : (
                <CheckCheck aria-hidden className="size-3.5" />
              )}
            </Button>
          ) : null
        }
        avatar={
          <CommentAvatar
            author={thread.author.name}
            authorAvatar={thread.author.avatarUrl}
            size="sm"
          />
        }
        content={
          <>
            <CommentThreadHeader
              author={
                <span className="font-medium text-sm">
                  {thread.author.name}
                </span>
              }
              metadata={
                <ThreadTimestamp createdAt={thread.createdAt} now={now} />
              }
            />
            <p
              className={
                isResolved
                  ? "whitespace-pre-wrap text-muted-foreground text-sm"
                  : "whitespace-pre-wrap text-sm"
              }
            >
              {renderCommentBody(thread.body, mentionNames)}
            </p>
            {isResolved ? (
              <p className="text-muted-foreground text-xs">
                {thread.resolvedByName
                  ? `Resolved by ${thread.resolvedByName}`
                  : "Resolved"}
              </p>
            ) : null}
          </>
        }
      />
      {thread.replies?.length ? (
        <CommentThreadReplies
          className="border-l border-l-border bg-transparent pl-5"
          showDivider={false}
        >
          {thread.replies.map((reply) => (
            <CommentThreadReplyRow
              avatar={
                <CommentAvatar
                  author={reply.author.name}
                  authorAvatar={reply.author.avatarUrl}
                  size="xs"
                />
              }
              body={
                <p className="whitespace-pre-wrap text-sm">
                  {renderCommentBody(reply.body, mentionNames)}
                </p>
              }
              header={
                <CommentThreadHeader
                  author={
                    <span className="font-medium text-sm">
                      {reply.author.name}
                    </span>
                  }
                  metadata={
                    <ThreadTimestamp createdAt={reply.createdAt} now={now} />
                  }
                />
              }
              key={reply.id}
            />
          ))}
        </CommentThreadReplies>
      ) : null}
      {onReply ? (
        <ThreadReplyFooter
          isReplyOpen={isReplyOpen}
          isReplyPending={isReplyPending}
          onCloseReply={onCloseReply}
          onOpenReply={onOpenReply}
          onReply={(body) => onReply(thread.id, body)}
        />
      ) : null}
    </CommentThreadCard>
  );
}

function ThreadReplyFooter({
  isReplyOpen,
  isReplyPending,
  onOpenReply,
  onCloseReply,
  onReply,
}: Readonly<{
  isReplyOpen: boolean;
  isReplyPending: boolean;
  onOpenReply: () => void;
  onCloseReply: () => void;
  onReply: (body: string) => unknown;
}>) {
  if (isReplyOpen) {
    return (
      <div className="px-3 pb-3 sm:px-4">
        <MentionComposer
          autoFocus
          isPending={isReplyPending}
          minHeightClassName="min-h-[64px]"
          onCancel={onCloseReply}
          onSubmit={({ body }) => {
            // Close the composer only once the reply resolves so a failed post
            // keeps the composer open with the typed draft for retry. The
            // MentionComposer retains its own draft on rejection; closing here
            // early would discard it. A void return (no wired mutation) closes
            // synchronously, preserving prior behavior.
            const result = onReply(body);
            if (isThenable(result)) {
              return result.then(() => onCloseReply());
            }
            onCloseReply();
            return result;
          }}
          placeholder="Reply..."
          submitLabel="Reply"
        />
      </div>
    );
  }
  return <CommentThreadActionFooter label="Reply" onClick={onOpenReply} />;
}

/**
 * Narrows an `onReply` return to a Promise so the caller can gate follow-up work
 * (closing the reply composer) on resolution while a non-Promise return stays
 * synchronous.
 */
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value != null && typeof (value as { then?: unknown }).then === "function"
  );
}
