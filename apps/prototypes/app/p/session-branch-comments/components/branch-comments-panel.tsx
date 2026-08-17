"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import {
  CommentThreadAnchorPreview,
  CommentThreadCard,
  CommentThreadMain,
} from "@repo/design-system/components/ui/comment-thread";
import {
  ArrowDownWideNarrowIcon,
  ArrowUpNarrowWideIcon,
  MessageSquareIcon,
  PencilIcon,
  ReplyIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { commentAuthorName, type PrComment } from "../mock";

const INITIALS_SPLIT = /[\s-]+/;

// Tab-scoped right-side comments rail, mirroring the Feature detail page's feed
// sidebar layout (scrollable stream + composer pinned at the bottom).
// Cards compose the design-system `comment-thread` primitives (the same shell
// the production LiveblocksCommentCard uses) and the shared `CommentComposer`;
// the avatar/author/actions row is recreated here since the product renders it
// via Liveblocks' `<Thread>`, which the sandbox can't import.
export function BranchCommentsPanel({
  comments,
  emptyDescription,
  emptyTitle = "No comments yet",
  hidden = false,
  items: controlledItems,
  onAddComment,
  onAnchorClick,
  onItemsChange,
  placeholder,
  readOnly = false,
  title,
}: {
  comments: PrComment[];
  emptyDescription: string;
  emptyTitle?: string;
  hidden?: boolean;
  // When supplied, the panel is controlled: the parent owns the comment list so
  // notes created elsewhere (the timeline Add-comment affordance) share it.
  items?: PrComment[];
  onAddComment?: (body: string) => void;
  // Jump back to the trace turn an anchored comment was written against.
  onAnchorClick?: (turnId: string) => void;
  onItemsChange?: (items: PrComment[]) => void;
  placeholder: string;
  readOnly?: boolean;
  title: string;
}) {
  const [internalItems, setInternalItems] = useState<PrComment[]>(comments);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  // Monotonic counter so new local IDs never collide after a deletion reuses a
  // length-based index (which would let edit/delete hit multiple comments).
  const nextLocalId = useRef(0);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const isControlled = controlledItems !== undefined;
  const items = controlledItems ?? internalItems;
  const updateItems = (updater: (current: PrComment[]) => PrComment[]) => {
    if (isControlled) {
      onItemsChange?.(updater(items));
    } else {
      setInternalItems(updater);
    }
  };

  const addComment = (body: string) => {
    if (isControlled) {
      onAddComment?.(body);
      return;
    }
    nextLocalId.current += 1;
    setInternalItems((current) => [
      ...current,
      {
        id: `local-${nextLocalId.current}`,
        author: "You",
        at: "just now",
        body,
      },
    ]);
  };

  const removeComment = (id: string) =>
    updateItems((current) => current.filter((comment) => comment.id !== id));

  const saveEdit = (id: string, body: string) => {
    updateItems((current) =>
      current.map((comment) =>
        comment.id === id ? { ...comment, body } : comment
      )
    );
    setEditingId(null);
  };

  const focusComposer = () =>
    composerWrapRef.current?.querySelector("textarea")?.focus();
  const sortedItems = sortDirection === "desc" ? [...items].reverse() : items;
  // One derived label so the icon button's accessible name and tooltip both
  // describe the current sort state (they must not disagree — action vs state).
  const sortStateLabel =
    sortDirection === "desc" ? "Sorted newest first" : "Sorted oldest first";

  return (
    <aside
      aria-labelledby={titleId}
      className="relative flex w-[21.25rem] shrink-0 flex-col border-l bg-background"
      hidden={hidden}
    >
      <div className="flex h-11 shrink-0 items-center border-b px-3">
        <h2 className="font-semibold text-sm" id={titleId}>
          {title}{" "}
          <span className="font-normal text-muted-foreground">
            {items.length}
          </span>
        </h2>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            aria-label={sortStateLabel}
            onClick={() =>
              setSortDirection((current) =>
                current === "desc" ? "asc" : "desc"
              )
            }
            size="icon-sm"
            title={sortStateLabel}
            type="button"
            variant="ghost"
          >
            {sortDirection === "desc" ? (
              <ArrowDownWideNarrowIcon className="size-3.5" />
            ) : (
              <ArrowUpNarrowWideIcon className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {items.length === 0 ? (
          <div className="flex items-start gap-2 rounded-md border bg-muted/25 p-3">
            <MessageSquareIcon
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <div>
              <p className="font-medium text-sm">{emptyTitle}</p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                {emptyDescription}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {sortedItems.map((comment) => (
              <CommentCard
                comment={comment}
                isEditing={editingId === comment.id}
                key={comment.id}
                onAnchorClick={onAnchorClick}
                onCancelEdit={() => setEditingId(null)}
                onDelete={() => removeComment(comment.id)}
                onEdit={() => setEditingId(comment.id)}
                onReply={focusComposer}
                onSaveEdit={(body) => saveEdit(comment.id, body)}
                readOnly={readOnly}
              />
            ))}
          </div>
        )}
      </div>

      {readOnly ? null : (
        <div className="border-t p-3" ref={composerWrapRef}>
          <CommentComposer
            minHeightClassName="min-h-16"
            onSubmit={addComment}
            placeholder={placeholder}
            submitLabel="Comment"
          />
        </div>
      )}
    </aside>
  );
}

function CommentCard({
  comment,
  isEditing,
  onAnchorClick,
  onEdit,
  onDelete,
  onReply,
  onSaveEdit,
  onCancelEdit,
  readOnly,
}: {
  comment: PrComment;
  isEditing: boolean;
  onAnchorClick?: (turnId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onReply: () => void;
  onSaveEdit: (body: string) => void;
  onCancelEdit: () => void;
  readOnly: boolean;
}) {
  const authorName = commentAuthorName(comment.author);
  const anchorTurnId = comment.anchorTurnId;
  return (
    <CommentThreadCard className="group bg-card">
      {renderAnchorPreview(
        comment.anchorPreview,
        anchorTurnId && onAnchorClick
          ? () => onAnchorClick(anchorTurnId)
          : undefined
      )}
      <CommentThreadMain
        avatar={
          <Avatar className="size-7 shrink-0">
            <AvatarFallback className="bg-primary/10 font-medium text-[11px] text-primary">
              {getInitials(authorName)}
            </AvatarFallback>
          </Avatar>
        }
        content={
          <>
            {/* Name + timestamp share the header row with the action icons; the
                comment body gets its own full-width row below. */}
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-semibold text-sm">
                  {authorName}
                </span>
                <span className="text-muted-foreground text-xs">
                  {comment.at}
                </span>
              </div>
              {readOnly ? null : (
                <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <CommentAction label="Edit comment" onClick={onEdit}>
                    <PencilIcon className="size-3.5" />
                  </CommentAction>
                  <CommentAction label="Delete comment" onClick={onDelete}>
                    <Trash2Icon className="size-3.5" />
                  </CommentAction>
                  <CommentAction label="Reply" onClick={onReply}>
                    <ReplyIcon className="size-3.5" />
                  </CommentAction>
                </div>
              )}
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
      onClick={onClick}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      {children}
    </Button>
  );
}

function getInitials(name: string): string {
  const parts = name.split(INITIALS_SPLIT).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

// A comment anchored to a trace turn renders its quoted excerpt as a jump-back
// control; a comment with a static preview (or none) renders the plain banner.
function renderAnchorPreview(
  preview: string | undefined,
  onJump: (() => void) | undefined
): ReactNode {
  if (!preview) {
    return null;
  }
  if (!onJump) {
    return <CommentThreadAnchorPreview>{preview}</CommentThreadAnchorPreview>;
  }
  return (
    <button
      aria-label="Jump to the commented message"
      className="block w-full rounded-t-[inherit] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={onJump}
      title="Jump to the commented message"
      type="button"
    >
      <CommentThreadAnchorPreview className="cursor-pointer transition-colors hover:bg-muted/70">
        {preview}
      </CommentThreadAnchorPreview>
    </button>
  );
}
