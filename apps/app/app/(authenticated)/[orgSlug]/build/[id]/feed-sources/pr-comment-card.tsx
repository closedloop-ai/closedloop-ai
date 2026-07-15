"use client";

import type { BranchViewComment } from "@repo/api/src/types/branch-view";
import { CommentKind } from "@repo/api/src/types/branch-view";
import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Button } from "@repo/design-system/components/ui/button";
import {
  CommentThreadCard,
  CommentThreadCollapseFooter,
  CommentThreadHeader,
  CommentThreadMain,
  CommentThreadReplies,
  CommentThreadReplyRow,
} from "@repo/design-system/components/ui/comment-thread";
import { MessageSquare } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import { CommentMarkdown } from "@/lib/markdown";
import {
  type BranchViewContextValue,
  useBranchViewContext,
} from "../branch-view-context";
import { getBranchViewCommentUiId } from "../comment-context";
import {
  getReplyTargetGithubCommentId,
  getReviewThreadActionId,
} from "../comment-resolution";
import { handleBranchViewCommentActionResult } from "../components/branch-comment-action-result";
import { BranchCommentWriteIdentityPrompt } from "../components/branch-comment-write-identity-prompt";
import {
  type BranchViewIdentityPromptState,
  recordBranchViewCommentIdentityBlocker,
  useBranchViewCommentIdentityBlockers,
} from "../components/branch-view-comment-identity-blocker-store";
import { PrCommentActionMenu } from "./pr-comment-action-menu";
import { PrCommentCollapsedRow } from "./pr-comment-collapsed-row";
import { PrCommentFileAnchor } from "./pr-comment-file-anchor";
import { PrCommentInlineEditComposer } from "./pr-comment-inline-edit-composer";
import { PrCommentPriorityBadge } from "./pr-comment-priority-badge";
import { PrCommentReplyComposer } from "./pr-comment-reply-composer";
import { PrCommentSourceBadge } from "./pr-comment-source-badge";
import { PrCommentThreadFooter } from "./pr-comment-thread-footer";
import type { PrCommentItem } from "./pr-comment-types";

function shouldStartExpanded(input: {
  resolved: boolean;
  isSelected: boolean;
}): boolean {
  return input.isSelected || !input.resolved;
}

/**
 * Edit and delete mutations live on the shared `BranchViewContextValue`
 * (one instance per type for the whole tree, by design), so their
 * top-level `isPending` flag fires for every open composer in the
 * thread whenever any one of them is in flight. To get per-comment
 * pending state, compare the mutation's `variables` against the
 * comment we're rendering — same approach `PrCommentThreadFooter`
 * uses for resolve/unresolve.
 */
function isBranchViewCommentEditPending(
  comment: BranchViewComment,
  mutations: BranchViewContextValue["mutations"]
): boolean {
  if (comment.kind === CommentKind.ReviewComment) {
    return (
      mutations.editReview.isPending &&
      mutations.editReview.variables?.commentId ===
        getReviewThreadActionId(comment)
    );
  }
  return (
    mutations.editConversation.isPending &&
    mutations.editConversation.variables?.githubCommentId ===
      comment.githubCommentId
  );
}

function firstBranchViewIdentityPrompt(
  prompts: readonly (BranchViewIdentityPromptState | null)[]
): BranchViewIdentityPromptState | null {
  return prompts.find((prompt) => prompt !== null) ?? null;
}

function submitBranchViewCommentEdit(input: {
  comment: BranchViewComment;
  body: string;
  identityPrompts: ReturnType<typeof useBranchViewCommentIdentityBlockers>;
  mutations: BranchViewContextValue["mutations"];
  onAfterSuccess: () => void;
}): void {
  const onSuccess = (
    result: Parameters<typeof handleBranchViewCommentActionResult>[0]
  ) => {
    handleBranchViewCommentActionResult(result);
    if (result.success) {
      input.onAfterSuccess();
    }
  };
  if (input.comment.kind === CommentKind.ReviewComment) {
    input.mutations.editReview.mutate(
      { commentId: getReviewThreadActionId(input.comment), body: input.body },
      {
        onError: (error) =>
          recordBranchViewCommentIdentityBlocker({
            comment: input.comment,
            error,
            identityPrompts: input.identityPrompts,
            surface: "edit",
          }),
        onSuccess,
      }
    );
    return;
  }
  input.mutations.editConversation.mutate(
    { githubCommentId: input.comment.githubCommentId, body: input.body },
    {
      onError: (error) =>
        recordBranchViewCommentIdentityBlocker({
          comment: input.comment,
          error,
          identityPrompts: input.identityPrompts,
          surface: "edit",
        }),
      onSuccess,
    }
  );
}

function submitBranchViewCommentDelete(input: {
  comment: BranchViewComment;
  identityPrompts: ReturnType<typeof useBranchViewCommentIdentityBlockers>;
  mutations: BranchViewContextValue["mutations"];
  onAfterSuccess: () => void;
}): void {
  const onSuccess = (
    result: Parameters<typeof handleBranchViewCommentActionResult>[0]
  ) => {
    handleBranchViewCommentActionResult(result);
    if (result.success) {
      input.onAfterSuccess();
    }
  };
  if (input.comment.kind === CommentKind.ReviewComment) {
    input.mutations.deleteReview.mutate(
      getReviewThreadActionId(input.comment),
      {
        onError: (error) =>
          recordBranchViewCommentIdentityBlocker({
            comment: input.comment,
            error,
            identityPrompts: input.identityPrompts,
            surface: "delete",
          }),
        onSuccess,
      }
    );
    return;
  }
  input.mutations.deleteConversation.mutate(input.comment.githubCommentId, {
    onError: (error) =>
      recordBranchViewCommentIdentityBlocker({
        comment: input.comment,
        error,
        identityPrompts: input.identityPrompts,
        surface: "delete",
      }),
    onSuccess,
  });
}

/**
 * Top-level PR comment card. Owns local UI state for expand/collapse,
 * reply composer toggle, and inline edit composer toggle. Server
 * mutations flow through `useBranchViewContext().mutations`.
 */
export function PrCommentCard({ item }: Readonly<{ item: PrCommentItem }>) {
  const { root, replies, finding, commentFileTarget } = item;
  const ctx = useBranchViewContext();
  const identityPrompts = useBranchViewCommentIdentityBlockers();
  const rootUiId = getBranchViewCommentUiId(root);
  const isSelected = ctx.selectedCommentId === rootUiId;
  const resolved = root.resolved === true;

  const [expanded, setExpanded] = useState(() =>
    shouldStartExpanded({ resolved, isSelected })
  );
  const [isReplyOpen, setReplyOpen] = useState(false);
  const [isEditOpen, setEditOpen] = useState(false);

  useEffect(() => {
    if (isSelected) {
      setExpanded(true);
    }
  }, [isSelected]);

  function handleReplyToggle() {
    setReplyOpen((prev) => !prev);
  }

  function handleSubmitReply(body: string) {
    if (!(root.canReply === true)) {
      return;
    }
    const commentGithubId = getReplyTargetGithubCommentId(root);
    if (commentGithubId === null) {
      return;
    }
    ctx.mutations.reply.mutate(
      { commentGithubId, body },
      {
        onError: (error) =>
          recordBranchViewCommentIdentityBlocker({
            comment: root,
            error,
            identityPrompts,
            surface: "reply",
          }),
        onSuccess: () => setReplyOpen(false),
      }
    );
  }

  function handleEditToggle() {
    setEditOpen((prev) => !prev);
  }

  function handleEditSubmit(body: string) {
    submitBranchViewCommentEdit({
      comment: root,
      body,
      identityPrompts,
      mutations: ctx.mutations,
      onAfterSuccess: () => setEditOpen(false),
    });
  }

  function handleDelete() {
    submitBranchViewCommentDelete({
      comment: root,
      identityPrompts,
      mutations: ctx.mutations,
      onAfterSuccess: () => {
        if (isEditOpen) {
          setEditOpen(false);
        }
      },
    });
  }

  function handleResolveThread() {
    ctx.mutations.resolveThread.mutate(getReviewThreadActionId(root), {
      onError: (error) =>
        recordBranchViewCommentIdentityBlocker({
          comment: root,
          error,
          identityPrompts,
          surface: "resolve",
        }),
      onSuccess: handleBranchViewCommentActionResult,
    });
  }

  function handleUnresolveThread() {
    ctx.mutations.unresolveThread.mutate(getReviewThreadActionId(root), {
      onError: (error) =>
        recordBranchViewCommentIdentityBlocker({
          comment: root,
          error,
          identityPrompts,
          surface: "unresolve",
        }),
      onSuccess: handleBranchViewCommentActionResult,
    });
  }

  function handleCardSurfaceClick(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented) {
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest('[data-comment-control="true"]')
    ) {
      return;
    }
    ctx.onSelectComment(isSelected ? null : rootUiId);
  }

  function handleChatAboutThis() {
    ctx.onSelectComment(rootUiId);
  }

  if (resolved && !expanded) {
    return (
      <PrCommentCollapsedRow
        author={root.author}
        authorAvatar={root.authorAvatar}
        authorKind={root.authorKind}
        onExpand={() => setExpanded(true)}
        title={finding?.title ?? null}
      />
    );
  }

  const titleRow =
    finding && (finding.priority !== null || finding.title.length > 0) ? (
      <div className="flex flex-wrap items-center gap-1.5">
        <PrCommentPriorityBadge priority={finding.priority} />
        {finding.title.length > 0 ? (
          <span className="font-semibold text-foreground text-sm">
            {finding.title}
          </span>
        ) : null}
      </div>
    ) : null;

  const showReplyButton =
    root.kind !== CommentKind.IssueComment && root.canReply === true;
  const threadPrompt = firstBranchViewIdentityPrompt([
    identityPrompts.getActionPrompt(root, [
      "reply",
      "edit",
      "delete",
      "resolve",
      "unresolve",
    ]),
    ...replies.map((reply) =>
      identityPrompts.getActionPrompt(reply, ["edit", "delete"])
    ),
  ]);

  return (
    <CommentThreadCard
      interactive
      onClick={handleCardSurfaceClick}
      selected={isSelected}
      testId={`pr-comment-card-${rootUiId}`}
    >
      <CommentThreadMain
        actions={
          <PrCommentActionMenu
            comment={root}
            isResolvePending={ctx.mutations.resolveThread.isPending}
            isUnresolvePending={ctx.mutations.unresolveThread.isPending}
            onChatAboutThis={handleChatAboutThis}
            onDelete={handleDelete}
            onEditToggle={handleEditToggle}
            onResolveThread={handleResolveThread}
            onUnresolveThread={handleUnresolveThread}
          />
        }
        avatar={
          <CommentAvatar
            author={root.author}
            authorAvatar={root.authorAvatar}
            authorKind={root.authorKind}
          />
        }
        content={
          <>
            <CommentThreadHeader
              author={
                <span className="font-semibold text-[13px] text-foreground">
                  {root.author}
                </span>
              }
              metadata={
                <>
                  <PrCommentSourceBadge />
                  <span className="text-muted-foreground text-xs">
                    {formatRelativeTime(root.createdAt)}
                  </span>
                </>
              }
            />
            <PrCommentFileAnchor
              comment={root}
              commentFileTarget={commentFileTarget}
            />
            {titleRow}
            {isEditOpen ? (
              <PrCommentInlineEditComposer
                initialBody={root.body}
                isPending={isBranchViewCommentEditPending(root, ctx.mutations)}
                onCancel={() => setEditOpen(false)}
                onSubmit={handleEditSubmit}
              />
            ) : (
              <CommentMarkdown className="text-muted-foreground">
                {root.body}
              </CommentMarkdown>
            )}
          </>
        }
      />
      {replies.length > 0 ? <PrCommentReplies replies={replies} /> : null}
      {showReplyButton && !isReplyOpen ? (
        <div className="flex justify-end border-border border-t bg-muted/10 px-3 py-2">
          <Button
            className="h-7 text-muted-foreground text-xs"
            data-comment-control="true"
            onClick={(event) => {
              event.stopPropagation();
              handleReplyToggle();
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
            Reply
          </Button>
        </div>
      ) : null}
      {isReplyOpen ? (
        <PrCommentReplyComposer
          isPending={ctx.mutations.reply.isPending}
          onCancel={() => setReplyOpen(false)}
          onSubmit={handleSubmitReply}
        />
      ) : null}
      <PrCommentThreadFooter root={root} />
      <BranchCommentWriteIdentityPrompt prompt={threadPrompt} />
      {resolved ? (
        <CommentThreadCollapseFooter
          aria-label="Collapse resolved conversation"
          data-comment-control="true"
          label="Collapse resolved conversation"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(false);
          }}
        />
      ) : null}
    </CommentThreadCard>
  );
}

function PrCommentReplies({
  replies,
}: Readonly<{ replies: readonly BranchViewComment[] }>) {
  return (
    <CommentThreadReplies showDivider>
      {replies.map((reply) => (
        <PrCommentReplyRow key={reply.id} reply={reply} />
      ))}
    </CommentThreadReplies>
  );
}

function PrCommentReplyRow({ reply }: Readonly<{ reply: BranchViewComment }>) {
  const ctx = useBranchViewContext();
  const identityPrompts = useBranchViewCommentIdentityBlockers();
  const [isEditOpen, setEditOpen] = useState(false);

  function handleEditSubmit(body: string) {
    submitBranchViewCommentEdit({
      comment: reply,
      body,
      identityPrompts,
      mutations: ctx.mutations,
      onAfterSuccess: () => setEditOpen(false),
    });
  }

  function handleDelete() {
    submitBranchViewCommentDelete({
      comment: reply,
      identityPrompts,
      mutations: ctx.mutations,
      onAfterSuccess: () => {
        if (isEditOpen) {
          setEditOpen(false);
        }
      },
    });
  }

  return (
    <CommentThreadReplyRow
      actions={
        <PrCommentActionMenu
          comment={reply}
          onDelete={handleDelete}
          onEditToggle={() => setEditOpen((prev) => !prev)}
        />
      }
      avatar={
        <CommentAvatar
          author={reply.author}
          authorAvatar={reply.authorAvatar}
          authorKind={reply.authorKind}
          size="sm"
        />
      }
      body={
        isEditOpen ? (
          <PrCommentInlineEditComposer
            initialBody={reply.body}
            isPending={isBranchViewCommentEditPending(reply, ctx.mutations)}
            onCancel={() => setEditOpen(false)}
            onSubmit={handleEditSubmit}
          />
        ) : (
          <CommentMarkdown className="text-muted-foreground text-xs">
            {reply.body}
          </CommentMarkdown>
        )
      }
      header={
        <CommentThreadHeader
          author={
            <span className="font-semibold text-foreground text-xs">
              {reply.author}
            </span>
          }
          metadata={
            <span className="text-[11px] text-muted-foreground">
              {formatRelativeTime(reply.createdAt)}
            </span>
          }
        />
      }
    />
  );
}
