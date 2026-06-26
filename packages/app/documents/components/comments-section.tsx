"use client";

import type { PrCommentAuthorKind } from "@repo/api/src/types/branch-view";
import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import {
  formatDateTimeOrFallback,
  formatRelativeTimeOrFallback,
} from "@repo/app/shared/lib/date-utils";
import { CollapsibleSection } from "@repo/design-system/components/ui/collapsible-section";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import {
  CommentThreadCard,
  CommentThreadHeader,
  CommentThreadMain,
  CommentThreadReplies,
  CommentThreadReplyRow,
} from "@repo/design-system/components/ui/comment-thread";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { MessageSquare } from "lucide-react";
import { useState } from "react";

export type CommentAuthor = {
  name: string;
  avatarUrl?: string | null;
  kind?: PrCommentAuthorKind;
};

export type CommentThreadItem = {
  id: string;
  author: CommentAuthor;
  body: string;
  createdAt: string;
  replies?: CommentThreadItem[];
};

type CommentsSectionProps = {
  documentId: string;
  defaultOpen?: boolean;
  comments?: CommentThreadItem[];
  draft?: string;
  disabled?: boolean;
  isSubmitting?: boolean;
  onDraftChange?: (value: string) => void;
  onSubmitComment?: (body: string) => void;
  onReply?: (commentId: string, body: string) => void;
};

export function CommentsSection({
  documentId: _documentId,
  defaultOpen = false,
  comments = [],
  draft,
  disabled = false,
  isSubmitting = false,
  onDraftChange,
  onSubmitComment,
  onReply,
}: Readonly<CommentsSectionProps>) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [replyingToId, setReplyingToId] = useState<string | null>(null);

  const hasComments = comments.length > 0;

  return (
    <CollapsibleSection onOpenChange={setIsOpen} open={isOpen} title="Comments">
      <div className="space-y-4">
        {hasComments ? (
          <div className="space-y-4">
            {comments.map((comment) => (
              <CommentThreadItemCard
                comment={comment}
                isReplyOpen={replyingToId === comment.id}
                key={comment.id}
                onCloseReply={() => setReplyingToId(null)}
                onOpenReply={() => setReplyingToId(comment.id)}
                onReply={onReply}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            className="border-dashed"
            description="Start a discussion, capture feedback, or ask for clarification on this artifact."
            icon={MessageSquare}
            title="No comments yet"
          />
        )}
        <CommentComposer
          defaultValue={draft}
          disabled={disabled}
          isPending={isSubmitting}
          onSubmit={(body) => {
            onSubmitComment?.(body);
          }}
          onValueChange={onDraftChange}
          placeholder="Add a comment..."
          submitLabel="Comment"
        />
      </div>
    </CollapsibleSection>
  );
}

function CommentThreadItemCard({
  comment,
  isReplyOpen,
  onOpenReply,
  onCloseReply,
  onReply,
}: Readonly<{
  comment: CommentThreadItem;
  isReplyOpen: boolean;
  onOpenReply: () => void;
  onCloseReply: () => void;
  onReply?: (commentId: string, body: string) => void;
}>) {
  return (
    <CommentThreadCard>
      <CommentThreadMain
        avatar={
          <CommentAvatar
            author={comment.author.name}
            authorAvatar={comment.author.avatarUrl}
            authorKind={comment.author.kind}
            size="sm"
          />
        }
        content={
          <>
            <CommentThreadHeader
              author={
                <span className="font-medium text-sm">
                  {comment.author.name}
                </span>
              }
              metadata={
                <span
                  className="text-muted-foreground text-xs"
                  title={formatDateTimeOrFallback(comment.createdAt)}
                >
                  {formatRelativeTimeOrFallback(comment.createdAt)}
                </span>
              }
            />
            <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
          </>
        }
      />
      {comment.replies?.length ? (
        <CommentThreadReplies
          className="border-l border-l-border bg-transparent pl-5"
          showDivider={false}
        >
          {comment.replies.map((reply) => (
            <CommentThreadReplyRow
              avatar={
                <CommentAvatar
                  author={reply.author.name}
                  authorAvatar={reply.author.avatarUrl}
                  authorKind={reply.author.kind}
                  size="xs"
                />
              }
              body={<p className="whitespace-pre-wrap text-sm">{reply.body}</p>}
              header={
                <CommentThreadHeader
                  author={
                    <span className="font-medium text-sm">
                      {reply.author.name}
                    </span>
                  }
                  metadata={
                    <span
                      className="text-muted-foreground text-xs"
                      title={formatDateTimeOrFallback(reply.createdAt)}
                    >
                      {formatRelativeTimeOrFallback(reply.createdAt)}
                    </span>
                  }
                />
              }
              key={reply.id}
            />
          ))}
        </CommentThreadReplies>
      ) : null}
      {onReply ? (
        <div className="flex justify-end">
          {isReplyOpen ? (
            <div className="w-full">
              <CommentComposer
                minHeightClassName="min-h-[72px]"
                onCancel={onCloseReply}
                onSubmit={(body) => {
                  onReply(comment.id, body);
                  onCloseReply();
                }}
                placeholder="Reply..."
                submitLabel="Reply"
              />
            </div>
          ) : (
            <button
              className="font-medium text-primary text-sm hover:underline"
              onClick={onOpenReply}
              type="button"
            >
              Reply
            </button>
          )}
        </div>
      ) : null}
    </CommentThreadCard>
  );
}
