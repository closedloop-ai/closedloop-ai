"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import {
  CommentThreadAnchorPreview,
  CommentThreadCard,
  CommentThreadMain,
  CommentThreadReplies,
  CommentThreadReplyRow,
} from "@repo/design-system/components/ui/comment-thread";
import {
  ArrowDownWideNarrowIcon,
  ArrowUpNarrowWideIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
  PencilIcon,
  ReplyIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import {
  commentAuthorName,
  type PrComment,
  type PrCommentProviderKind,
  type PrCommentProviderProvenance,
  type PrCommentsAvailability,
  PrCommentsState,
} from "../mock";

const INITIALS_SPLIT = /[\s-]+/;

// Tab-scoped right-side comments rail, mirroring the Feature detail page's feed
// sidebar layout (scrollable stream + composer pinned at the bottom).
// Cards compose the design-system `comment-thread` primitives (the same shell
// the production LiveblocksCommentCard uses) and the shared `CommentComposer`;
// the avatar/author/actions row is recreated here since the product renders it
// via Liveblocks' `<Thread>`, which the sandbox can't import.
export function BranchCommentsPanel({
  availability,
  comments,
  emptyDescription,
  emptyTitle = "No comments yet",
  hidden = false,
  placeholder,
  readOnly = false,
  title,
}: {
  availability?: PrCommentsAvailability;
  comments: PrComment[];
  emptyDescription: string;
  emptyTitle?: string;
  hidden?: boolean;
  placeholder: string;
  readOnly?: boolean;
  title: string;
}) {
  const [items, setItems] = useState<PrComment[]>(comments);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  // Monotonic counter so new local IDs never collide after a deletion reuses a
  // length-based index (which would let edit/delete hit multiple comments).
  const nextLocalId = useRef(0);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const addComment = (body: string) => {
    nextLocalId.current += 1;
    setItems((current) => [
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
    setItems((current) => current.filter((comment) => comment.id !== id));

  const saveEdit = (id: string, body: string) => {
    setItems((current) =>
      current.map((comment) =>
        comment.id === id ? { ...comment, body } : comment
      )
    );
    setEditingId(null);
  };

  const focusComposer = () =>
    composerWrapRef.current?.querySelector("textarea")?.focus();
  const sortedItems = sortDirection === "desc" ? [...items].reverse() : items;
  const visibleCommentCount = readOnly
    ? items.reduce(
        (count, comment) => count + 1 + (comment.replies?.length ?? 0),
        0
      )
    : items.length;

  return (
    <aside
      aria-labelledby={titleId}
      className="relative flex w-[21.25rem] shrink-0 flex-col border-l bg-background max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-30 max-lg:h-3/4 max-lg:w-full max-lg:rounded-t-xl max-lg:border-t max-lg:border-l-0 max-lg:shadow-lg"
      hidden={hidden}
    >
      <div className="flex h-11 shrink-0 items-center border-b px-3">
        <h2 className="font-semibold text-sm" id={titleId}>
          {title}{" "}
          <span className="font-normal text-muted-foreground">
            {availability && hasIncompleteAvailability(availability)
              ? `${visibleCommentCount} shown`
              : visibleCommentCount}
          </span>
        </h2>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            aria-label={
              sortDirection === "desc"
                ? "Sort comments oldest first"
                : "Sort comments newest first"
            }
            onClick={() =>
              setSortDirection((current) =>
                current === "desc" ? "asc" : "desc"
              )
            }
            size="icon-sm"
            title={
              sortDirection === "desc"
                ? "Sort: newest first"
                : "Sort: oldest first"
            }
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
      {availability ? (
        <ProviderAvailability availability={availability} />
      ) : null}
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
  onEdit,
  onDelete,
  onReply,
  onSaveEdit,
  onCancelEdit,
  readOnly,
}: {
  comment: PrComment;
  isEditing: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onReply: () => void;
  onSaveEdit: (body: string) => void;
  onCancelEdit: () => void;
  readOnly: boolean;
}) {
  const authorName = commentAuthorName(comment.author);
  return (
    <CommentThreadCard className="group bg-card">
      {comment.anchorPreview ? (
        <CommentThreadAnchorPreview>
          {comment.anchorPreview}
        </CommentThreadAnchorPreview>
      ) : null}
      <CommentThreadMain
        avatar={
          <Avatar className="size-7 shrink-0">
            {comment.avatarUrl ? (
              <AvatarImage alt="" src={comment.avatarUrl} />
            ) : null}
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
                  {providerAuthorLabel(authorName, comment.provider)}
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
            <ProviderDetails provenance={comment.provider} />
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
      {comment.replies?.length ? (
        <CommentThreadReplies>
          {comment.replies.map((reply) => (
            <ProviderReply key={reply.id} reply={reply} />
          ))}
        </CommentThreadReplies>
      ) : null}
    </CommentThreadCard>
  );
}

function ProviderReply({ reply }: Readonly<{ reply: PrComment }>) {
  const authorName = commentAuthorName(reply.author);
  return (
    <CommentThreadReplyRow
      avatar={
        <Avatar className="size-6 shrink-0">
          {reply.avatarUrl ? (
            <AvatarImage alt="" src={reply.avatarUrl} />
          ) : null}
          <AvatarFallback className="bg-primary/10 font-medium text-[11px] text-primary">
            {getInitials(authorName)}
          </AvatarFallback>
        </Avatar>
      }
      body={
        <div className="space-y-1">
          <ProviderDetails provenance={reply.provider} />
          <p className="whitespace-pre-wrap text-sm">{reply.body}</p>
        </div>
      }
      header={
        <div className="flex min-w-0 flex-col">
          <span className="font-semibold text-xs">
            {providerAuthorLabel(authorName, reply.provider)}
          </span>
          <span className="text-muted-foreground text-xs">{reply.at}</span>
        </div>
      }
    />
  );
}

function ProviderDetails({
  provenance,
}: Readonly<{ provenance?: PrCommentProviderProvenance }>) {
  if (!provenance) {
    return null;
  }
  const metadata = providerMetadata(provenance);
  const location = providerLocation(provenance);
  const status = providerStatus(provenance);
  return (
    <div className="space-y-1 text-muted-foreground text-xs">
      <p>{metadata.join(" · ")}</p>
      {location ? (
        <p className="truncate" title={location}>
          {location}
        </p>
      ) : null}
      {status.length > 0 ? <p>{status.join(" · ")}</p> : null}
      {provenance.providerUrl ? (
        <a
          aria-label={`View ${providerKindLabels[provenance.kind].toLocaleLowerCase()} by @${provenance.login} on GitHub`}
          className="inline-flex items-center gap-1 hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href={provenance.providerUrl}
          rel="noreferrer"
          target="_blank"
        >
          View on GitHub
          <ExternalLinkIcon aria-hidden className="size-3" />
        </a>
      ) : null}
    </div>
  );
}

function ProviderAvailability({
  availability,
}: Readonly<{ availability: PrCommentsAvailability }>) {
  const messages = providerAvailabilityMessages(availability);
  if (messages.length === 0) {
    return null;
  }
  return (
    <ul
      className="list-disc space-y-1 border-b bg-muted/30 py-2 pr-4 pl-8 text-muted-foreground text-xs"
      role="status"
    >
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

function providerAvailabilityMessages(
  availability: PrCommentsAvailability
): string[] {
  const messages: string[] = [];
  if (availability.state === PrCommentsState.StaleMixed || availability.stale) {
    messages.push("GitHub comments may be stale.");
  }
  if (availability.mixedProjection) {
    messages.push(
      "GitHub comments combine evidence collected at different times."
    );
  }
  if (availability.providerTruncated) {
    messages.push("GitHub capped the available provider result.");
  }
  if (availability.responseTruncated) {
    messages.push("ClosedLoop capped the displayed provider response.");
  }
  if (
    availability.state === PrCommentsState.OverLimitTruncated &&
    !(availability.providerTruncated || availability.responseTruncated)
  ) {
    messages.push("Provider comment coverage is truncated.");
  }
  if (availability.omittedComments > 0) {
    messages.push(
      `${availability.omittedComments} GitHub ${availability.omittedComments === 1 ? "comment is" : "comments are"} omitted from this bounded result.`
    );
  }
  if (availability.bodyTruncatedCount > 0) {
    messages.push(
      `${availability.bodyTruncatedCount} GitHub comment ${availability.bodyTruncatedCount === 1 ? "body is" : "bodies are"} shortened.`
    );
  }
  return messages;
}

function providerAuthorLabel(
  authorName: string,
  provenance?: PrCommentProviderProvenance
): string {
  if (!provenance) {
    return authorName;
  }
  return authorName.trim().toLocaleLowerCase() ===
    provenance.login.trim().toLocaleLowerCase()
    ? `@${provenance.login}`
    : `${authorName} · @${provenance.login}`;
}

function providerMetadata(provenance: PrCommentProviderProvenance): string[] {
  const metadata = ["GitHub", providerKindLabels[provenance.kind]];
  if (provenance.resolved !== undefined) {
    metadata.push(provenance.resolved ? "Resolved" : "Unresolved");
  }
  return metadata;
}

function providerLocation(
  provenance: PrCommentProviderProvenance
): string | null {
  if (!provenance.path) {
    return null;
  }
  return `${provenance.path}${provenance.line === undefined ? "" : `:${provenance.line}`}`;
}

function providerStatus(provenance: PrCommentProviderProvenance): string[] {
  const status: string[] = [];
  if (provenance.stale) {
    status.push("Stale");
  }
  if (provenance.bodyTruncated) {
    status.push("Body truncated");
  }
  return status;
}

function hasIncompleteAvailability(
  availability: PrCommentsAvailability
): boolean {
  return (
    availability.stale ||
    availability.mixedProjection ||
    availability.providerTruncated ||
    availability.responseTruncated ||
    availability.omittedComments > 0 ||
    availability.bodyTruncatedCount > 0
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

const providerKindLabels = {
  issue: "Issue comment",
  review: "Review comment",
  review_reply: "Review reply",
} as const satisfies Record<PrCommentProviderKind, string>;
