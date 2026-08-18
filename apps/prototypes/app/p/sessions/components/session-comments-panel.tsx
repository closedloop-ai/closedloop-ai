"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import {
  CommentThreadAnchorPreview,
  CommentThreadCard,
  CommentThreadMain,
} from "@repo/design-system/components/ui/comment-thread";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { MessageSquareIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import type { SessionComment } from "../mock-detail";
import { getInitials } from "./session-cells";

// Persistent right-side comments rail, mirroring the in-product session-detail
// trace-comments rail: header + scrollable stream + composer pinned at the
// bottom. Cards compose the design-system `comment-thread` primitives (the same
// shell the production trace comments use) and the shared `CommentComposer`.
export function SessionCommentsPanel({
  comments,
  activeTraceRow,
  onCommentsChange,
  onSelectAnchor,
}: {
  comments: SessionComment[];
  activeTraceRow: number;
  onCommentsChange: (comments: SessionComment[]) => void;
  onSelectAnchor: (row: number, atMinutes?: number) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);

  const addComment = (body: string) => {
    onCommentsChange([
      ...comments,
      {
        id: `local-${crypto.randomUUID()}`,
        author: "You",
        at: "just now",
        body,
        traceRow: activeTraceRow,
      },
    ]);
  };

  const removeComment = (id: string) =>
    onCommentsChange(comments.filter((comment) => comment.id !== id));

  const saveEdit = (id: string, body: string) => {
    onCommentsChange(
      comments.map((comment) =>
        comment.id === id ? { ...comment, body } : comment
      )
    );
    setEditingId(null);
  };

  return (
    <aside className="flex w-[21.25rem] shrink-0 flex-col border-l bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <MessageSquareIcon
          aria-hidden
          className="size-4 text-muted-foreground"
        />
        <h2 className="font-semibold text-foreground text-sm">Comments</h2>
        <Chip className="ml-auto" variant="muted">
          {comments.length}
        </Chip>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {comments.length === 0 ? (
          <EmptyState
            className="py-10"
            description="Anchor a note to any turn in the trace and it appears here."
            icon={MessageSquareIcon}
            title="No comments yet"
          />
        ) : (
          <div className="flex flex-col gap-3">
            {comments.map((comment) => (
              <CommentCard
                comment={comment}
                isEditing={editingId === comment.id}
                // Only the reader's own comments are editable/deletable — the
                // prototype must not teach the production build to mutate other
                // users' content (review).
                isOwn={comment.author === "You"}
                key={comment.id}
                onCancelEdit={() => setEditingId(null)}
                onDelete={() => removeComment(comment.id)}
                onEdit={() => setEditingId(comment.id)}
                onSaveEdit={(body) => saveEdit(comment.id, body)}
                onSelectAnchor={() => onSelectAnchor(comment.traceRow)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="border-t p-3">
        <CommentComposer
          minHeightClassName="min-h-16"
          onSubmit={addComment}
          placeholder="Add a comment…"
          submitLabel="Comment"
        />
      </div>
    </aside>
  );
}

function CommentCard({
  comment,
  isEditing,
  isOwn,
  onEdit,
  onDelete,
  onSaveEdit,
  onCancelEdit,
  onSelectAnchor,
}: {
  comment: SessionComment;
  isEditing: boolean;
  isOwn: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onSaveEdit: (body: string) => void;
  onCancelEdit: () => void;
  onSelectAnchor: () => void;
}) {
  return (
    <CommentThreadCard
      className="group cursor-pointer bg-card transition-colors hover:border-primary/40"
      interactive
      onClick={onSelectAnchor}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectAnchor();
        }
      }}
      role="button"
      tabIndex={0}
    >
      {comment.anchorPreview ? (
        <CommentThreadAnchorPreview>
          {comment.anchorPreview}
        </CommentThreadAnchorPreview>
      ) : null}
      <CommentThreadMain
        avatar={
          <Avatar className="size-7 shrink-0">
            <AvatarFallback className="bg-primary/10 font-medium text-primary text-xs">
              {getInitials(comment.author)}
            </AvatarFallback>
          </Avatar>
        }
        content={
          <>
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-semibold text-sm">
                  {comment.author}
                </span>
                <span className="text-muted-foreground text-xs">
                  {comment.at}
                </span>
              </div>
              {isOwn ? (
                <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <CommentAction label="Edit comment" onClick={onEdit}>
                    <PencilIcon className="size-3.5" />
                  </CommentAction>
                  <CommentAction label="Delete comment" onClick={onDelete}>
                    <Trash2Icon className="size-3.5" />
                  </CommentAction>
                </div>
              ) : null}
            </div>
            {isEditing ? (
              <CommentComposer
                cancelLabel="Cancel"
                defaultValue={comment.body}
                minHeightClassName="min-h-16"
                onCancel={onCancelEdit}
                onSubmit={onSaveEdit}
                submitLabel="Save"
              />
            ) : (
              <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
            )}
          </>
        }
      />
    </CommentThreadCard>
  );
}

function CommentAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      {children}
    </Button>
  );
}
