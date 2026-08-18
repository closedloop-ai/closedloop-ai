"use client";

import {
  BranchPrCommentKind,
  type BranchPrCommentKind as BranchPrCommentKindType,
} from "@repo/api/src/types/branch";
import type {
  BranchTraceCommentCollectionQuery,
  TraceCommentTarget,
} from "@repo/api/src/types/comment";
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
  CommentThreadHeader,
  CommentThreadMain,
  CommentThreadReplies,
  CommentThreadReplyRow,
} from "@repo/design-system/components/ui/comment-thread";
import {
  CornerUpLeftIcon,
  ExternalLinkIcon,
  LocateFixedIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  type BranchCommentAnchor,
  type BranchCommentAuthor,
  BranchCommentSource,
  type BranchCommentThread,
  type BranchProviderCommentProvenance,
} from "./branch-comments-model";

const INITIALS_SPLIT = /[\s-]+/;

export const BranchCommentComposerKind = {
  Edit: "edit",
  Reply: "reply",
} as const;

export type BranchCommentComposerKind =
  (typeof BranchCommentComposerKind)[keyof typeof BranchCommentComposerKind];

export type BranchCommentComposerMode = {
  kind: BranchCommentComposerKind;
  threadId: string;
};

/** Renders one provider-view-only or permissioned native comment thread. */
export function BranchCommentCard({
  canEditRoot,
  canReply: canReplyToRoot,
  draftFor,
  isPending,
  mode,
  onCancelComposer,
  onDeleteReply,
  onDeleteThread,
  onJump,
  onOpenComposer,
  onSubmitComposer,
  onUpdateDraft,
  renderBody,
  thread,
}: Readonly<{
  canEditRoot: boolean;
  canReply: boolean;
  draftFor: (kind: BranchCommentComposerKind) => string | undefined;
  isPending: (kind: BranchCommentComposerKind) => boolean;
  mode?: BranchCommentComposerMode;
  onCancelComposer: () => void;
  onDeleteReply?: (
    replyId: string,
    target: TraceCommentTarget,
    collectionQuery?: BranchTraceCommentCollectionQuery
  ) => Promise<void> | void;
  onDeleteThread?: (
    threadId: string,
    target: TraceCommentTarget,
    collectionQuery?: BranchTraceCommentCollectionQuery
  ) => Promise<void> | void;
  onJump?: (anchor: BranchCommentAnchor, target: TraceCommentTarget) => void;
  onOpenComposer: (mode: BranchCommentComposerMode) => void;
  onSubmitComposer: (kind: BranchCommentComposerKind, body: string) => void;
  onUpdateDraft: (kind: BranchCommentComposerKind, value: string) => void;
  renderBody?: (body: string, thread: BranchCommentThread) => ReactNode;
  thread: BranchCommentThread;
}>) {
  const isPlatform = thread.source === BranchCommentSource.Platform;
  return (
    <CommentThreadCard
      testId={isPlatform ? undefined : "provider-comment-thread"}
    >
      <ThreadAnchor isPlatform={isPlatform} onJump={onJump} thread={thread} />
      <CommentThreadMain
        actions={
          <ThreadActions
            canEditRoot={canEditRoot}
            canReplyToRoot={canReplyToRoot}
            isPlatform={isPlatform}
            onDeleteThread={onDeleteThread}
            onOpenComposer={onOpenComposer}
            thread={thread}
          />
        }
        avatar={<CommentAvatar author={thread.author} />}
        content={
          <>
            <CommentThreadHeader
              author={
                <span className="font-medium text-sm">
                  {providerAuthorLabel(thread.author, thread.provider)}
                </span>
              }
              metadata={
                <span className="text-muted-foreground text-xs">
                  {thread.createdAtLabel}
                </span>
              }
            />
            <ProviderDetails provenance={thread.provider} />
            {mode?.kind === BranchCommentComposerKind.Edit ? (
              <ScopedComposer
                ariaLabel="Edit root comment"
                draft={draftFor(BranchCommentComposerKind.Edit)}
                isPending={isPending(BranchCommentComposerKind.Edit)}
                onCancel={onCancelComposer}
                onSubmit={(body) =>
                  onSubmitComposer(BranchCommentComposerKind.Edit, body)
                }
                onValueChange={(value) =>
                  onUpdateDraft(BranchCommentComposerKind.Edit, value)
                }
                seed={thread.body}
                submitLabel="Save"
              />
            ) : (
              <div className="whitespace-pre-wrap text-sm">
                {renderBody?.(thread.body, thread) ?? thread.body}
              </div>
            )}
            {mode?.kind === BranchCommentComposerKind.Reply ? (
              <ScopedComposer
                ariaLabel="Reply to root comment"
                draft={draftFor(BranchCommentComposerKind.Reply)}
                isPending={isPending(BranchCommentComposerKind.Reply)}
                onCancel={onCancelComposer}
                onSubmit={(body) =>
                  onSubmitComposer(BranchCommentComposerKind.Reply, body)
                }
                onValueChange={(value) =>
                  onUpdateDraft(BranchCommentComposerKind.Reply, value)
                }
                submitLabel="Reply"
              />
            ) : null}
          </>
        }
      />
      {thread.replies.length > 0 ? (
        <CommentThreadReplies>
          {thread.replies.map((reply) => (
            <CommentThreadReplyRow
              actions={
                isPlatform && reply.canDelete && onDeleteReply ? (
                  <IconAction
                    label="Delete reply"
                    onClick={() =>
                      onDeleteReply(
                        reply.id,
                        thread.target,
                        thread.collectionQuery
                      )
                    }
                  >
                    <Trash2Icon aria-hidden className="size-3.5" />
                  </IconAction>
                ) : null
              }
              avatar={<CommentAvatar author={reply.author} compact />}
              body={
                isPlatform ? (
                  <p className="whitespace-pre-wrap text-sm">{reply.body}</p>
                ) : (
                  <div className="space-y-1">
                    <ProviderDetails provenance={reply.provider} />
                    <div className="whitespace-pre-wrap text-sm">
                      {renderBody?.(reply.body, thread) ?? reply.body}
                    </div>
                  </div>
                )
              }
              header={
                <CommentThreadHeader
                  author={
                    <span className="font-medium text-xs">
                      {providerAuthorLabel(reply.author, reply.provider)}
                    </span>
                  }
                  metadata={
                    <span className="text-muted-foreground text-xs">
                      {reply.createdAtLabel}
                    </span>
                  }
                />
              }
              key={reply.id}
            />
          ))}
        </CommentThreadReplies>
      ) : null}
    </CommentThreadCard>
  );
}

function ProviderDetails({
  provenance,
}: Readonly<{
  provenance?: BranchProviderCommentProvenance | null;
}>) {
  if (!provenance) {
    return null;
  }
  const metadata = providerMetadata(provenance);
  const location = providerLocation(provenance);
  const status = providerStatus(provenance);
  const kindLabel = providerKindLabel(provenance.kind);
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
          aria-label={`View ${kindLabel.toLocaleLowerCase()} by @${provenance.login} on GitHub`}
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

function providerAuthorLabel(
  author: BranchCommentAuthor,
  provenance?: BranchProviderCommentProvenance | null
): string {
  if (!provenance) {
    return author.name;
  }
  const normalizedName = author.name.trim().toLocaleLowerCase();
  const normalizedLogin = provenance.login.trim().toLocaleLowerCase();
  return normalizedName === normalizedLogin
    ? `@${provenance.login}`
    : `${author.name} · @${provenance.login}`;
}

function providerMetadata(
  provenance: BranchProviderCommentProvenance
): string[] {
  const metadata = ["GitHub", providerKindLabel(provenance.kind)];
  if (provenance.resolved !== null) {
    metadata.push(provenance.resolved ? "Resolved" : "Unresolved");
  }
  return metadata;
}

function providerLocation(
  provenance: BranchProviderCommentProvenance
): string | null {
  if (!provenance.path) {
    return null;
  }
  return `${provenance.path}${provenance.line === null ? "" : `:${provenance.line}`}`;
}

function providerStatus(provenance: BranchProviderCommentProvenance): string[] {
  const status: string[] = [];
  if (provenance.stale) {
    status.push("Stale");
  }
  if (provenance.bodyTruncated) {
    status.push("Body truncated");
  }
  return status;
}

function ThreadAnchor({
  isPlatform,
  onJump,
  thread,
}: Readonly<{
  isPlatform: boolean;
  onJump?: (anchor: BranchCommentAnchor, target: TraceCommentTarget) => void;
  thread: BranchCommentThread;
}>) {
  if (!thread.anchor) {
    return null;
  }
  return (
    <CommentThreadAnchorPreview>
      {isPlatform && onJump ? (
        <button
          aria-label={`Jump to ${thread.anchor.label}`}
          className="flex w-full items-center justify-between gap-2 text-left hover:text-foreground"
          onClick={() => onJump(thread.anchor!, thread.target)}
          type="button"
        >
          <span className="truncate">{thread.anchor.label}</span>
          <LocateFixedIcon aria-hidden className="size-3 shrink-0" />
        </button>
      ) : (
        thread.anchor.label
      )}
    </CommentThreadAnchorPreview>
  );
}

function ThreadActions({
  canEditRoot,
  canReplyToRoot,
  isPlatform,
  onDeleteThread,
  onOpenComposer,
  thread,
}: Readonly<{
  canEditRoot: boolean;
  canReplyToRoot: boolean;
  isPlatform: boolean;
  onDeleteThread?: (
    threadId: string,
    target: TraceCommentTarget,
    collectionQuery?: BranchTraceCommentCollectionQuery
  ) => Promise<void> | void;
  onOpenComposer: (mode: BranchCommentComposerMode) => void;
  thread: BranchCommentThread;
}>) {
  const canEdit = isPlatform && thread.canEditRoot && canEditRoot;
  const canDelete =
    isPlatform && thread.canDeleteThread && Boolean(onDeleteThread);
  const canReply = isPlatform && thread.canReply && canReplyToRoot;
  if (!(canEdit || canDelete || canReply)) {
    return null;
  }
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {canEdit ? (
        <IconAction
          label="Edit comment"
          onClick={() =>
            onOpenComposer({
              kind: BranchCommentComposerKind.Edit,
              threadId: thread.id,
            })
          }
        >
          <PencilIcon aria-hidden className="size-3.5" />
        </IconAction>
      ) : null}
      {canDelete ? (
        <IconAction
          label="Delete thread"
          onClick={() =>
            onDeleteThread?.(thread.id, thread.target, thread.collectionQuery)
          }
        >
          <Trash2Icon aria-hidden className="size-3.5" />
        </IconAction>
      ) : null}
      {canReply ? (
        <IconAction
          label="Reply to comment"
          onClick={() =>
            onOpenComposer({
              kind: BranchCommentComposerKind.Reply,
              threadId: thread.id,
            })
          }
        >
          <CornerUpLeftIcon aria-hidden className="size-3.5" />
        </IconAction>
      ) : null}
    </div>
  );
}

function ScopedComposer({
  ariaLabel,
  draft,
  isPending,
  onCancel,
  onSubmit,
  onValueChange,
  seed,
  submitLabel,
}: Readonly<{
  ariaLabel: string;
  draft: string | undefined;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (body: string) => void;
  onValueChange: (value: string) => void;
  seed?: string;
  submitLabel: string;
}>) {
  return (
    <CommentComposer
      ariaLabel={ariaLabel}
      clearOnSubmit={false}
      isPending={isPending}
      minHeightClassName="min-h-16"
      onCancel={onCancel}
      onSubmit={onSubmit}
      onValueChange={onValueChange}
      submitLabel={submitLabel}
      value={draft ?? seed ?? ""}
    />
  );
}

function CommentAvatar({
  author,
  compact = false,
}: Readonly<{ author: BranchCommentAuthor; compact?: boolean }>) {
  return (
    <Avatar className={compact ? "size-6 shrink-0" : "size-7 shrink-0"}>
      {author.avatarUrl ? <AvatarImage alt="" src={author.avatarUrl} /> : null}
      <AvatarFallback className="bg-primary/10 text-primary text-xs">
        {initials(author.name)}
      </AvatarFallback>
    </Avatar>
  );
}

function IconAction({
  children,
  label,
  onClick,
}: Readonly<{ children: ReactNode; label: string; onClick: () => void }>) {
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

function initials(name: string): string {
  const parts = name.split(INITIALS_SPLIT).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

function providerKindLabel(kind: BranchPrCommentKindType): string {
  return providerKindLabels[kind] ?? "Provider comment";
}

const providerKindLabels = {
  [BranchPrCommentKind.Issue]: "Issue comment",
  [BranchPrCommentKind.Review]: "Review comment",
  [BranchPrCommentKind.ReviewReply]: "Review reply",
} satisfies Record<BranchPrCommentKindType, string>;
