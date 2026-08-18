"use client";

import { CommentActionMenu } from "@repo/design-system/components/ui/comment-action-menu";
import {
  CommentThreadAnchorPreview,
  CommentThreadCard,
  CommentThreadHeader,
  CommentThreadMain,
  CommentThreadReplies,
  CommentThreadReplyRow,
} from "@repo/design-system/components/ui/comment-thread";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import type { CommentAuthor, CommentMention, CommentThread } from "../mock";
import { canResolveThread, mentionableUsers, ThreadScope } from "../mock";
import { CommentAvatar } from "./comment-avatar";
import { MentionComposer } from "./mention-composer";

// Presentational thread card, mirroring CommentThreadItemCard in
// packages/app/documents/components/comments-section.tsx: a root comment plus
// FLAT single-level replies (no nested trees), reusing the DS comment-thread
// primitives verbatim. Adds the participant-resolve control and mention-chip
// rendering this slice introduces.

// Escapes regex metacharacters in a mention token so a literal "@Name" match is
// built safely. Module-level so the pattern is not reconstructed per render.
const REGEX_SPECIAL_CHARS_PATTERN = /[.*+?^${}()|[\]\\]/g;

/**
 * Renders a comment body with "@Name" tokens replaced by primary-tinted
 * mention chips. Mentions notify the recipient's inbox only.
 */
function renderBody(
  body: string,
  mentions?: readonly CommentMention[]
): ReactNode {
  if (!mentions?.length) {
    return body;
  }
  const tokens = mentions.map((mention) => `@${mention.label}`);
  // Split on the mention tokens, keeping the delimiters so each "@Name" can be
  // rendered as a chip while the surrounding prose stays plain text.
  const pattern = new RegExp(
    `(${tokens
      .map((token) =>
        token.replace(REGEX_SPECIAL_CHARS_PATTERN, String.raw`\$&`)
      )
      .join("|")})`,
    "g"
  );
  const parts = body.split(pattern);
  return parts.map((part, index) => {
    const isMention = tokens.includes(part);
    if (!isMention) {
      return part;
    }
    return (
      <span
        className="rounded bg-primary/10 px-1 py-0.5 font-medium text-primary text-sm"
        // biome-ignore lint/suspicious/noArrayIndexKey: split() yields a fixed positional array; a repeated token has no identity but its position, so the index is the stable key.
        key={`${part}-${index}`}
      >
        {part}
      </span>
    );
  });
}

function AuthorName({ author }: Readonly<{ author: CommentAuthor }>) {
  return <span className="font-medium text-sm">{author.name}</span>;
}

function Timestamp({ label }: Readonly<{ label: string }>) {
  return <span className="text-muted-foreground text-xs">{label}</span>;
}

// Static "N days ago"-style labels; the connected build derives these from
// createdAt via the shared date-utils formatter.
const RELATIVE_TIME: Record<string, string> = {
  "2026-07-22T15:04:00Z": "2 days ago",
  "2026-07-22T15:31:00Z": "2 days ago",
  "2026-07-22T16:12:00Z": "2 days ago",
  "2026-07-21T09:48:00Z": "3 days ago",
  "2026-07-21T10:02:00Z": "3 days ago",
  "2026-07-23T18:20:00Z": "yesterday",
  "2026-07-23T18:44:00Z": "yesterday",
};

function relativeTime(createdAt: string): string {
  return RELATIVE_TIME[createdAt] ?? createdAt;
}

type ThreadCardProps = {
  thread: CommentThread;
  currentUserId: string;
  isActive?: boolean;
  onResolveToggle: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  onReply: (threadId: string, body: string, mentions: string[]) => void;
  onEdit: (threadId: string, body: string) => void;
  /** Registers the card's root node so an inline anchor can scroll to it. */
  onRegisterRef: (threadId: string, node: HTMLElement | null) => void;
};

export function ThreadCard({
  thread,
  currentUserId,
  isActive = false,
  onResolveToggle,
  onDelete,
  onReply,
  onEdit,
  onRegisterRef,
}: Readonly<ThreadCardProps>) {
  const [isReplyOpen, setReplyOpen] = useState(false);
  const [isEditOpen, setEditOpen] = useState(false);
  const isAuthor = thread.author.id === currentUserId;
  const threadId = thread.id;
  const setRootRef = useCallback(
    (node: HTMLElement | null) => onRegisterRef(threadId, node),
    [onRegisterRef, threadId]
  );
  // This slice invents the resolve rule (the domain CommentActionMenu only
  // takes canEdit/canDelete and does not gate resolve): the thread author or any
  // participant may resolve, and the author may reopen. See canResolveThread.
  const canResolve = canResolveThread(thread, currentUserId);
  const canReopen = isAuthor;
  // Resolve when open+allowed, reopen when resolved+author; otherwise no handler
  // (the menu item hides) so the control never lies about what the viewer can do.
  const canToggleResolve = thread.resolved ? canReopen : canResolve;
  const onResolveAction = canToggleResolve
    ? () => onResolveToggle(thread.id)
    : undefined;

  return (
    <div ref={setRootRef}>
      <CommentThreadCard
        className={isActive ? "ring-1 ring-primary/50" : undefined}
      >
        {thread.scope === ThreadScope.Inline && thread.anchorText ? (
          <CommentThreadAnchorPreview>
            {thread.anchorText}
          </CommentThreadAnchorPreview>
        ) : null}
        <CommentThreadMain
          actions={
            // The menu renders when the viewer can act on the thread: edit/delete
            // are author-only, resolve follows canResolveThread, reopen is
            // author-only. A viewer with no available action sees no menu.
            isAuthor || canResolve ? (
              <CommentActionMenu
                canDelete={isAuthor}
                canEdit={isAuthor}
                onDelete={() => onDelete(thread.id)}
                onEditToggle={() => setEditOpen((prev) => !prev)}
                onResolveAction={onResolveAction}
                resolveLabel={
                  thread.resolved ? "Reopen thread" : "Resolve thread"
                }
              />
            ) : null
          }
          avatar={
            <CommentAvatar
              author={thread.author.name}
              authorKind={thread.author.kind}
              size="sm"
            />
          }
          content={
            <>
              <CommentThreadHeader
                author={<AuthorName author={thread.author} />}
                metadata={<Timestamp label={relativeTime(thread.createdAt)} />}
              />
              {isEditOpen ? (
                <MentionComposer
                  autoFocus
                  minHeightClassName="min-h-[64px]"
                  onCancel={() => setEditOpen(false)}
                  onSubmit={({ body }) => {
                    onEdit(thread.id, body);
                    setEditOpen(false);
                  }}
                  placeholder="Edit comment..."
                  submitLabel="Save"
                  users={mentionableUsers}
                />
              ) : (
                <p className="whitespace-pre-wrap text-sm">
                  {renderBody(thread.body, thread.mentions)}
                </p>
              )}
            </>
          }
        />
        {thread.replies.length > 0 ? (
          <CommentThreadReplies
            className="border-l border-l-border bg-transparent pl-5"
            showDivider={false}
          >
            {thread.replies.map((reply) => (
              <CommentThreadReplyRow
                avatar={
                  <CommentAvatar
                    author={reply.author.name}
                    authorKind={reply.author.kind}
                    size="xs"
                  />
                }
                body={
                  <p className="whitespace-pre-wrap text-sm">
                    {renderBody(reply.body, reply.mentions)}
                  </p>
                }
                header={
                  <CommentThreadHeader
                    author={<AuthorName author={reply.author} />}
                    metadata={
                      <Timestamp label={relativeTime(reply.createdAt)} />
                    }
                  />
                }
                key={reply.id}
              />
            ))}
          </CommentThreadReplies>
        ) : null}
        <div className="px-3 pb-3 sm:px-4">
          {isReplyOpen ? (
            <MentionComposer
              autoFocus
              minHeightClassName="min-h-[64px]"
              onCancel={() => setReplyOpen(false)}
              onSubmit={({ body, mentions }) => {
                onReply(thread.id, body, mentions);
                setReplyOpen(false);
              }}
              placeholder="Reply..."
              submitLabel="Reply"
              users={mentionableUsers}
            />
          ) : (
            <div className="flex justify-end">
              <button
                className="font-medium text-primary text-sm hover:underline"
                onClick={() => setReplyOpen(true)}
                type="button"
              >
                Reply
              </button>
            </div>
          )}
        </div>
      </CommentThreadCard>
    </div>
  );
}
