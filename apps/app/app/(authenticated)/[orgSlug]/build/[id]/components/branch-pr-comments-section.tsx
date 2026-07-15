"use client";

import {
  type BranchViewCommentActionResult,
  type BranchViewCommentCreatePromptEligibility,
  CommentKind,
} from "@repo/api/src/types/branch-view";
import {
  useCreateBranchViewConversationComment,
  useDeleteBranchViewConversationComment,
  useDeleteBranchViewReviewComment,
  useEditBranchViewConversationComment,
  useEditBranchViewReviewComment,
  useReplyToComment,
  useResolveBranchViewReviewThread,
  useUnresolveBranchViewReviewThread,
} from "@repo/app/documents/hooks/use-branch-view";
import { parseBranchViewCommentIdentityBlocker } from "@repo/app/github/lib/branch-view-comment-identity-blocker";
import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  CommentThreadCard,
  CommentThreadHeader,
  CommentThreadMain,
  CommentThreadReplies,
  CommentThreadReplyRow,
} from "@repo/design-system/components/ui/comment-thread";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { ScrollArea } from "@repo/design-system/components/ui/scroll-area";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import {
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  FileCode,
  Loader2,
  MessageSquare,
  Pencil,
  Trash2,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useMemo, useState } from "react";
import { CommentMarkdown } from "@/lib/markdown";
import { getBranchViewCommentUiId } from "../comment-context";
import {
  getReplyTargetGithubCommentId,
  getReviewThreadActionId,
  isResolvableReviewComment,
} from "../comment-resolution";
import {
  type CommentDiffNavigationRequest,
  type ResolvedCommentFileTarget,
  resolveCommittedCommentFileTarget,
} from "../file-targets";
import type { BranchViewComment, BranchViewFile } from "../types";
import { handleBranchViewCommentActionResult } from "./branch-comment-action-result";
import { BranchCommentWriteIdentityPrompt } from "./branch-comment-write-identity-prompt";
import {
  type BranchReviewFinding,
  type BranchReviewFindingAnchorClassification,
  classifyBranchReviewFindingAnchor,
  getBranchReviewFindingAnchorStatusLabel,
  getBranchReviewFindingSeverityClassName,
  getBranchReviewFindingSeverityLabel,
  parseBranchReviewFinding,
} from "./branch-review-findings";
import {
  canResolveBranchViewReviewThread,
  canUnresolveBranchViewReviewThread,
} from "./branch-review-thread-capabilities";
import {
  recordBranchViewCommentIdentityBlocker,
  useBranchViewCommentIdentityBlockers,
} from "./branch-view-comment-identity-blocker-store";
import { buildCommentThreads } from "./comment-threads";

type BranchPrCommentsSectionProps = {
  canCreateConversationComment: boolean;
  commentPromptEligibility?: BranchViewCommentCreatePromptEligibility;
  comments: BranchViewComment[];
  committedFiles: BranchViewFile[];
  externalLinkId: string;
  fileCacheHeadSha?: string | null;
  headSha?: string | null;
  selectedCommentId: string | null;
  onSelectComment: (id: string | null) => void;
  onSelectCommentDiffTarget: (request: CommentDiffNavigationRequest) => void;
};

type CommentFilter = "all" | "inline" | "general";

type ResolveThreadAction = {
  isPending: boolean;
  label: "Resolve thread" | "Unresolve thread";
  onSelect: () => void;
};

function CommentRowActions({
  canDelete,
  canEdit,
  canCopyLink,
  isDeleting,
  isEditing,
  isReplying,
  onDelete,
  onCopyLink,
  onEditToggle,
  onReplyToggle,
  resolveThreadAction,
  showReply,
}: Readonly<{
  canDelete: boolean;
  canEdit: boolean;
  canCopyLink: boolean;
  isDeleting: boolean;
  isEditing: boolean;
  isReplying: boolean;
  onDelete: () => void;
  onCopyLink: () => void;
  onEditToggle: () => void;
  onReplyToggle: () => void;
  resolveThreadAction: ResolveThreadAction | null;
  showReply: boolean;
}>) {
  function handleReplyClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onReplyToggle();
  }

  function handleEditClick() {
    onEditToggle();
  }

  function handleDeleteClick() {
    onDelete();
  }

  function handleCopyLinkClick() {
    onCopyLink();
  }

  function handleResolveThreadClick() {
    resolveThreadAction?.onSelect();
  }

  return (
    <div
      className="flex shrink-0 items-center gap-1"
      data-comment-control="true"
    >
      {showReply ? (
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button
              aria-label="Reply"
              className={cn(
                "h-7 w-7 shrink-0 p-0",
                isReplying && "bg-accent text-accent-foreground"
              )}
              data-comment-control="true"
              onClick={handleReplyClick}
              size="icon"
              variant="ghost"
            >
              <MessageSquare className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Reply</p>
          </TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More actions"
            className="h-7 w-7 shrink-0 p-0"
            data-comment-control="true"
            onClick={(event) => event.stopPropagation()}
            size="icon"
            variant="ghost"
          >
            <Ellipsis className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!canEdit} onSelect={handleEditClick}>
            <Pencil className="mr-2 h-3.5 w-3.5" />
            {isEditing ? "Cancel edit" : "Edit"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canDelete || isDeleting}
            onSelect={handleDeleteClick}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
          {resolveThreadAction ? (
            <DropdownMenuItem
              disabled={resolveThreadAction.isPending}
              onSelect={handleResolveThreadClick}
            >
              <CheckCheck className="mr-2 h-3.5 w-3.5" />
              {resolveThreadAction.label}
            </DropdownMenuItem>
          ) : null}
          {canCopyLink ? (
            <DropdownMenuItem onClick={handleCopyLinkClick}>
              <Copy className="mr-2 h-3.5 w-3.5" />
              Copy link
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ConversationComposer({
  draft,
  isPending,
  onChangeDraft,
  onSubmit,
}: {
  draft: string;
  isPending?: boolean;
  onChangeDraft: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="border-border border-b bg-background p-3 sm:p-4">
      <Textarea
        aria-label="Write a comment"
        className="min-h-[96px] resize-y text-sm"
        data-comment-control="true"
        disabled={isPending}
        onChange={(event) => onChangeDraft(event.target.value)}
        placeholder="Write a comment..."
        value={draft}
      />
      <div className="mt-2 flex justify-end">
        <Button
          data-comment-control="true"
          disabled={draft.trim().length === 0 || isPending}
          onClick={onSubmit}
          size="sm"
          type="button"
        >
          {isPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : null}
          Comment
        </Button>
      </div>
    </div>
  );
}

function InlineReplyComposer({
  draft,
  indent,
  isPending,
  onCancel,
  onChangeDraft,
  onSubmit,
}: {
  draft: string;
  /** Match threaded reply horizontal inset (pl-11). */
  indent?: boolean;
  isPending?: boolean;
  onCancel: () => void;
  onChangeDraft: (v: string) => void;
  onSubmit: () => void;
}) {
  function handleCancelClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onCancel();
  }

  function handleSubmitClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onSubmit();
  }

  return (
    <div
      className={cn(
        "border-border border-b bg-muted/30 py-3 pr-4",
        indent ? "pl-11" : "pl-4"
      )}
      data-comment-control="true"
    >
      <Textarea
        aria-label="Write a reply"
        className="min-h-[88px] resize-y text-sm"
        data-comment-control="true"
        disabled={isPending}
        onChange={(e) => onChangeDraft(e.target.value)}
        placeholder="Write a reply..."
        value={draft}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          data-comment-control="true"
          disabled={isPending}
          onClick={handleCancelClick}
          size="sm"
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button
          data-comment-control="true"
          disabled={draft.trim().length === 0 || isPending}
          onClick={handleSubmitClick}
          size="sm"
          type="button"
        >
          Reply
        </Button>
      </div>
    </div>
  );
}

function InlineEditComposer({
  draft,
  isPending,
  onCancel,
  onChangeDraft,
  onSubmit,
}: {
  draft: string;
  isPending?: boolean;
  onCancel: () => void;
  onChangeDraft: (v: string) => void;
  onSubmit: () => void;
}) {
  function handleCancelClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onCancel();
  }

  function handleSubmitClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onSubmit();
  }

  return (
    <div className="flex flex-col gap-2" data-comment-control="true">
      <Textarea
        aria-label="Edit comment"
        className="min-h-[96px] resize-y text-sm"
        data-comment-control="true"
        disabled={isPending}
        onChange={(event) => onChangeDraft(event.target.value)}
        value={draft}
      />
      <div className="flex justify-end gap-2">
        <Button
          data-comment-control="true"
          disabled={isPending}
          onClick={handleCancelClick}
          size="sm"
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button
          data-comment-control="true"
          disabled={draft.trim().length === 0 || isPending}
          onClick={handleSubmitClick}
          size="sm"
          type="button"
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function CommentFileLineReference({
  comment,
  onSelectCommentDiffTarget,
  target,
}: Readonly<{
  comment: BranchViewComment;
  onSelectCommentDiffTarget: (request: CommentDiffNavigationRequest) => void;
  target: ResolvedCommentFileTarget | null;
}>) {
  if (!comment.path) {
    return null;
  }

  const referenceText = `${comment.path}${
    comment.line == null ? "" : `:${comment.line}`
  }`;
  const isReviewLineTarget =
    comment.kind === CommentKind.ReviewComment && comment.line !== null;

  if (!(isReviewLineTarget && target)) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1">
          <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-muted-foreground text-xs">
            {referenceText}
          </span>
        </div>
        {isReviewLineTarget ? (
          <span className="text-muted-foreground text-xs">
            This comment refers to a file no longer in this branch.
          </span>
        ) : null}
      </div>
    );
  }

  const resolvedTarget = target;

  function handleChipClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (comment.line === null || !comment.path) {
      return;
    }
    onSelectCommentDiffTarget({
      commentId: getBranchViewCommentUiId(comment),
      fileId: resolvedTarget.fileId,
      path: comment.path,
      line: comment.line,
    });
  }

  return (
    <button
      aria-label={`View ${comment.path} at line ${comment.line}`}
      className={cn(
        "flex min-w-0 cursor-pointer items-center gap-1 rounded-sm font-mono text-muted-foreground text-xs",
        "outline-none transition-colors hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      )}
      data-comment-control="true"
      onClick={handleChipClick}
      type="button"
    >
      <FileCode className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{referenceText}</span>
    </button>
  );
}

function CommentRow({
  comment,
  commentFileTarget,
  finding,
  findingAnchor,
  replies,
  isSelected,
  isReplying,
  isEditing,
  isDeleting,
  isResolving,
  editDraft,
  onChangeEditDraft,
  onCopyLink,
  onDelete,
  onEditSubmit,
  onEditToggle,
  onReplyToggle,
  onResolveThread,
  onSelect,
  onSelectCommentDiffTarget,
  onUnresolveThread,
}: {
  comment: BranchViewComment;
  commentFileTarget: ResolvedCommentFileTarget | null;
  finding: BranchReviewFinding | null;
  findingAnchor: BranchReviewFindingAnchorClassification | null;
  replies: BranchViewComment[];
  isSelected: boolean;
  isReplying: boolean;
  isEditing: boolean;
  isDeleting: boolean;
  isResolving: boolean;
  editDraft: string;
  onChangeEditDraft: (value: string) => void;
  onCopyLink: (comment: BranchViewComment) => void;
  onDelete: () => void;
  onEditSubmit: () => void;
  onEditToggle: () => void;
  onReplyToggle: () => void;
  onResolveThread: (comment: BranchViewComment) => void;
  onSelect: () => void;
  onSelectCommentDiffTarget: (request: CommentDiffNavigationRequest) => void;
  onUnresolveThread: (comment: BranchViewComment) => void;
}) {
  const identityPrompts = useBranchViewCommentIdentityBlockers();
  const canCopyLink = comment.htmlUrl.trim().length > 0;
  const resolveThreadAction = resolveBranchViewCommentAction({
    comment,
    isResolving,
    onResolveThread,
    onUnresolveThread,
  });
  const replyPrompt = identityPrompts.getActionPrompt(comment, ["reply"]);
  const managementPrompt = identityPrompts.getActionPrompt(comment, [
    "edit",
    "delete",
    "resolve",
    "unresolve",
  ]);

  function handleRowSurfaceClick(event: MouseEvent<HTMLDivElement>) {
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
    onSelect();
  }

  function handleRowSelectionClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onSelect();
  }

  function handleThreadReplyClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onReplyToggle();
  }

  return (
    <CommentThreadCard
      data-testid={`comment-row-${getBranchViewCommentUiId(comment)}`}
      interactive
      onClick={handleRowSurfaceClick}
      selected={isSelected}
    >
      <CommentThreadMain
        actions={
          <CommentRowActions
            canCopyLink={canCopyLink}
            canDelete={comment.canDelete === true}
            canEdit={comment.canEdit === true}
            isDeleting={isDeleting}
            isEditing={isEditing}
            isReplying={isReplying}
            onCopyLink={() => onCopyLink(comment)}
            onDelete={onDelete}
            onEditToggle={onEditToggle}
            onReplyToggle={onReplyToggle}
            resolveThreadAction={resolveThreadAction}
            showReply={
              comment.kind !== CommentKind.IssueComment &&
              comment.canReply === true
            }
          />
        }
        avatar={
          <>
            <button
              aria-label={`Open comment by ${comment.author}`}
              className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:right-3 focus:z-10 focus:rounded-md focus:bg-background focus:px-2 focus:py-1 focus:text-foreground focus:text-xs focus:ring-2 focus:ring-ring"
              data-comment-control="true"
              onClick={handleRowSelectionClick}
              type="button"
            />
            <CommentAvatar
              author={comment.author}
              authorAvatar={comment.authorAvatar}
              authorKind={comment.authorKind}
            />
          </>
        }
        content={
          <>
            <CommentThreadHeader
              author={
                <span className="font-semibold text-[13px] text-foreground">
                  {comment.author}
                </span>
              }
              className="justify-between gap-2"
              metadata={
                <span className="text-muted-foreground text-xs">
                  {formatRelativeTime(comment.createdAt)}
                </span>
              }
            />
            <CommentFileLineReference
              comment={comment}
              onSelectCommentDiffTarget={onSelectCommentDiffTarget}
              target={commentFileTarget}
            />
            {finding ? (
              <CommentFindingMetadata
                classification={findingAnchor}
                finding={finding}
              />
            ) : null}
            {isEditing ? (
              <InlineEditComposer
                draft={editDraft}
                isPending={isDeleting}
                onCancel={onEditToggle}
                onChangeDraft={onChangeEditDraft}
                onSubmit={onEditSubmit}
              />
            ) : (
              <CommentMarkdown className="text-muted-foreground">
                {comment.body}
              </CommentMarkdown>
            )}
          </>
        }
      />
      {replies.length > 0 ? (
        <CommentThreadReplies
          label={`${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
        >
          {replies.map((reply) => (
            <CommentThreadReplyRow
              avatar={
                <CommentAvatar
                  author={reply.author}
                  authorAvatar={reply.authorAvatar}
                  authorKind={reply.authorKind}
                  size="sm"
                />
              }
              body={
                <CommentMarkdown className="text-muted-foreground text-xs">
                  {reply.body}
                </CommentMarkdown>
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
              key={reply.id}
            />
          ))}
          {comment.kind === CommentKind.IssueComment ||
          comment.canReply !== true ? null : (
            <Button
              className="h-7 text-muted-foreground text-xs"
              data-comment-control="true"
              onClick={handleThreadReplyClick}
              size="sm"
              variant="ghost"
            >
              <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
              Reply
            </Button>
          )}
        </CommentThreadReplies>
      ) : null}
      <BranchCommentWriteIdentityPrompt prompt={replyPrompt} />
      <BranchCommentWriteIdentityPrompt prompt={managementPrompt} />
    </CommentThreadCard>
  );
}

function CommentFindingMetadata({
  classification,
  finding,
}: Readonly<{
  classification: BranchReviewFindingAnchorClassification | null;
  finding: BranchReviewFinding;
}>) {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid={`comment-finding-metadata-${finding.id}`}
    >
      <Badge
        className={cn(
          "rounded-sm border px-1.5 py-0 font-semibold text-[11px]",
          getBranchReviewFindingSeverityClassName(finding.severity)
        )}
        variant="outline"
      >
        {finding.priority ??
          getBranchReviewFindingSeverityLabel(finding.severity)}
      </Badge>
      {classification ? (
        <span className="text-muted-foreground text-xs">
          {getBranchReviewFindingAnchorStatusLabel(classification.status)}
        </span>
      ) : null}
      {finding.suggestion ? (
        <span className="text-muted-foreground text-xs">
          Suggestion: {finding.suggestion}
        </span>
      ) : null}
    </div>
  );
}

export function BranchPrCommentsSection({
  canCreateConversationComment,
  commentPromptEligibility,
  comments,
  committedFiles,
  externalLinkId,
  fileCacheHeadSha = null,
  headSha = null,
  selectedCommentId,
  onSelectComment,
  onSelectCommentDiffTarget,
}: Readonly<BranchPrCommentsSectionProps>) {
  const identityPrompts = useBranchViewCommentIdentityBlockers();
  const replyMutation = useReplyToComment(externalLinkId);
  const createConversationMutation =
    useCreateBranchViewConversationComment(externalLinkId);
  const editConversationMutation =
    useEditBranchViewConversationComment(externalLinkId);
  const deleteConversationMutation =
    useDeleteBranchViewConversationComment(externalLinkId);
  const editReviewMutation = useEditBranchViewReviewComment(externalLinkId);
  const deleteReviewMutation = useDeleteBranchViewReviewComment(externalLinkId);
  const resolveReviewThreadMutation =
    useResolveBranchViewReviewThread(externalLinkId);
  const unresolveReviewThreadMutation =
    useUnresolveBranchViewReviewThread(externalLinkId);
  const [expanded, setExpanded] = useState(true);
  const [filter, setFilter] = useState<CommentFilter>("all");
  const [conversationDraft, setConversationDraft] = useState("");
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(
    null
  );
  const [replyDraft, setReplyDraft] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const resolvableReviewComments = comments.filter(isResolvableReviewComment);
  const inlineCommentCount = comments.filter(
    (comment) => comment.kind === CommentKind.ReviewComment
  ).length;
  const generalCommentCount = comments.length - inlineCommentCount;
  const resolvedResolvableCount = resolvableReviewComments.filter(
    (comment) => comment.resolved === true
  ).length;
  const pendingResolvableCount =
    resolvableReviewComments.length - resolvedResolvableCount;
  const findingsByCommentId = useMemo(() => {
    const findings = new Map<string, BranchReviewFinding>();
    for (const comment of comments) {
      const finding = parseBranchReviewFinding(comment);
      if (finding) {
        findings.set(getBranchViewCommentUiId(comment), finding);
      }
    }
    return findings;
  }, [comments]);
  const findingAnchorByCommentId = useMemo(() => {
    const classifications = new Map<
      string,
      BranchReviewFindingAnchorClassification
    >();
    for (const finding of findingsByCommentId.values()) {
      classifications.set(
        finding.id,
        classifyBranchReviewFindingAnchor({
          comment: finding.comment,
          committedFiles,
          fileCacheHeadSha,
          headSha,
        })
      );
    }
    return classifications;
  }, [committedFiles, fileCacheHeadSha, findingsByCommentId, headSha]);
  const filteredComments = useMemo((): BranchViewComment[] => {
    if (filter === "all") {
      return comments;
    }
    if (filter === "inline") {
      return comments.filter((c) => c.kind === CommentKind.ReviewComment);
    }
    return comments.filter((c) => c.kind === CommentKind.IssueComment);
  }, [comments, filter]);
  const threads = useMemo(
    () => buildCommentThreads(filteredComments),
    [filteredComments]
  );
  const committedCommentTargets = useMemo(() => {
    const targets = new Map<string, ResolvedCommentFileTarget>();
    for (const thread of threads) {
      for (const comment of [thread.root, ...thread.replies]) {
        if (
          comment.kind !== CommentKind.ReviewComment ||
          !comment.path ||
          comment.line === null
        ) {
          continue;
        }
        const target = resolveCommittedCommentFileTarget(
          committedFiles,
          comment.path
        );
        if (target) {
          targets.set(getBranchViewCommentUiId(comment), target);
        }
      }
    }
    return targets;
  }, [committedFiles, threads]);

  function emptyCommentMessage(): string {
    if (comments.length === 0) {
      return "No comments yet";
    }
    if (filter === "inline") {
      return "No inline comments";
    }
    if (filter === "general") {
      return "No general comments";
    }
    return "No comments";
  }

  function closeReplyComposer(): void {
    setReplyingToCommentId(null);
    setReplyDraft("");
  }

  function closeEditComposer(): void {
    setEditingCommentId(null);
    setEditDraft("");
  }

  function submitConversationComment(): void {
    const body = conversationDraft.trim();
    if (body.length === 0) {
      return;
    }
    createConversationMutation.mutate(
      { body },
      {
        onError: (error) => {
          const identityBlocker = parseBranchViewCommentIdentityBlocker(error);
          if (identityBlocker) {
            identityPrompts.recordIdentityBlocker({
              identityBlocker,
              surface: "createConversation",
            });
          }
        },
        onSuccess: (result) => {
          handleBranchViewCommentActionResult(result);
          if (result.success) {
            setConversationDraft("");
          }
        },
      }
    );
  }

  function toggleReplyComposer(commentId: string): void {
    if (replyingToCommentId === commentId) {
      closeReplyComposer();
      return;
    }
    setReplyingToCommentId(commentId);
    setReplyDraft("");
  }

  function toggleEditComposer(comment: BranchViewComment): void {
    const commentUiId = getBranchViewCommentUiId(comment);
    if (editingCommentId === commentUiId) {
      closeEditComposer();
      return;
    }
    setEditingCommentId(commentUiId);
    setEditDraft(comment.body);
  }

  function submitEdit(): void {
    const comment = comments.find(
      (c) => getBranchViewCommentUiId(c) === editingCommentId
    );
    const body = editDraft.trim();
    if (!(comment && body)) {
      return;
    }
    if (comment.kind === CommentKind.ReviewComment) {
      editReviewMutation.mutate(
        { commentId: getReviewThreadActionId(comment), body },
        {
          onError: (error) => {
            recordBranchViewCommentIdentityBlocker({
              comment,
              error,
              identityPrompts,
              surface: "edit",
            });
          },
          onSuccess: (result) => {
            handleBranchViewCommentActionResult(result);
            if (result.success) {
              closeEditComposer();
            }
          },
        }
      );
      return;
    }

    editConversationMutation.mutate(
      { githubCommentId: comment.githubCommentId, body },
      {
        onError: (error) => {
          recordBranchViewCommentIdentityBlocker({
            comment,
            error,
            identityPrompts,
            surface: "edit",
          });
        },
        onSuccess: (result) => {
          handleBranchViewCommentActionResult(result);
          if (result.success) {
            closeEditComposer();
          }
        },
      }
    );
  }

  function deleteConversationComment(comment: BranchViewComment): void {
    const onSuccess = (result: BranchViewCommentActionResult) => {
      handleBranchViewCommentActionResult(result);
      if (
        result.success &&
        editingCommentId === getBranchViewCommentUiId(comment)
      ) {
        closeEditComposer();
      }
    };

    if (comment.kind === CommentKind.ReviewComment) {
      deleteReviewMutation.mutate(getReviewThreadActionId(comment), {
        onError: (error) => {
          recordBranchViewCommentIdentityBlocker({
            comment,
            error,
            identityPrompts,
            surface: "delete",
          });
        },
        onSuccess,
      });
      return;
    }

    deleteConversationMutation.mutate(comment.githubCommentId, {
      onError: (error) => {
        recordBranchViewCommentIdentityBlocker({
          comment,
          error,
          identityPrompts,
          surface: "delete",
        });
      },
      onSuccess,
    });
  }

  function copyCommentLink(comment: BranchViewComment): void {
    copyBranchViewCommentLinkToClipboard(comment);
  }

  function resolveReviewThread(comment: BranchViewComment): void {
    if (!canResolveBranchViewReviewThread(comment)) {
      return;
    }
    resolveReviewThreadMutation.mutate(getReviewThreadActionId(comment), {
      onError: (error) => {
        recordBranchViewCommentIdentityBlocker({
          comment,
          error,
          identityPrompts,
          surface: "resolve",
        });
      },
      onSuccess: handleBranchViewCommentActionResult,
    });
  }

  function unresolveReviewThread(comment: BranchViewComment): void {
    if (!canUnresolveBranchViewReviewThread(comment)) {
      return;
    }
    unresolveReviewThreadMutation.mutate(getReviewThreadActionId(comment), {
      onError: (error) => {
        recordBranchViewCommentIdentityBlocker({
          comment,
          error,
          identityPrompts,
          surface: "unresolve",
        });
      },
      onSuccess: handleBranchViewCommentActionResult,
    });
  }

  function submitReply(): void {
    if (!replyingToCommentId || replyDraft.trim().length === 0) {
      return;
    }
    const comment = comments.find(
      (c) => getBranchViewCommentUiId(c) === replyingToCommentId
    );
    if (!(comment && comment.canReply === true)) {
      return;
    }
    const commentGithubId = getReplyTargetGithubCommentId(comment);
    if (commentGithubId === null) {
      toast.error("Can't reply to this comment — it has no GitHub comment id.");
      return;
    }
    replyMutation.mutate(
      {
        commentGithubId,
        body: replyDraft.trim(),
      },
      {
        onError: (error) => {
          recordBranchViewCommentIdentityBlocker({
            comment,
            error,
            identityPrompts,
            surface: "reply",
          });
        },
        onSuccess: closeReplyComposer,
      }
    );
  }

  const createPrompt = identityPrompts.getCreatePrompt(
    "createConversation",
    commentPromptEligibility?.createConversation
  );

  return (
    <Collapsible onOpenChange={setExpanded} open={expanded}>
      <section className="flex min-w-0 flex-col">
        <div className="flex flex-col gap-2 border-border border-b px-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:py-0">
          <CollapsibleTrigger asChild>
            <button
              className="flex h-10 min-w-0 shrink-0 cursor-pointer items-center gap-1 text-left outline-none hover:bg-accent/30 sm:h-12 [&[data-state=open]]:bg-transparent"
              type="button"
            >
              <span className="font-semibold text-base text-foreground">
                PR Comments
              </span>
              {expanded ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
            </button>
          </CollapsibleTrigger>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Tabs
              className="w-auto"
              onValueChange={(v) => setFilter(v as CommentFilter)}
              value={filter}
            >
              <TabsList>
                <TabsTrigger
                  className="px-2 text-xs sm:px-3 sm:text-sm"
                  value="all"
                >
                  All ({comments.length})
                </TabsTrigger>
                <TabsTrigger
                  className="px-2 text-xs sm:px-3 sm:text-sm"
                  value="inline"
                >
                  Inline ({inlineCommentCount})
                </TabsTrigger>
                <TabsTrigger
                  className="px-2 text-xs sm:px-3 sm:text-sm"
                  value="general"
                >
                  General ({generalCommentCount})
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {resolvableReviewComments.length > 0 ? (
              <Button
                className="h-8 shrink-0 px-3"
                disabled={pendingResolvableCount === 0}
                size="sm"
                type="button"
                variant="secondary"
              >
                <CheckCheck className="mr-1.5 h-4 w-4" />
                Resolve All
              </Button>
            ) : null}
          </div>
        </div>
        <CollapsibleContent>
          <div className="border-border border-t">
            {canCreateConversationComment ? (
              <ConversationComposer
                draft={conversationDraft}
                isPending={createConversationMutation.isPending}
                onChangeDraft={setConversationDraft}
                onSubmit={submitConversationComment}
              />
            ) : (
              <BranchCommentWriteIdentityPrompt prompt={createPrompt} />
            )}
            {threads.length === 0 ? (
              <p className="py-8 text-center text-muted-foreground text-sm">
                {emptyCommentMessage()}
              </p>
            ) : (
              <ScrollArea className="max-h-[420px]">
                <div className="space-y-3 p-3 sm:p-4">
                  {threads.map((thread) => {
                    const rootUiId = getBranchViewCommentUiId(thread.root);
                    const rootActionId = getReviewThreadActionId(thread.root);
                    return (
                      <div className="min-w-0" key={rootUiId}>
                        <ResolvedThreadCollapser
                          commentCount={thread.replies.length + 1}
                          resolved={thread.root.resolved === true}
                          root={thread.root}
                        >
                          <CommentRow
                            comment={thread.root}
                            commentFileTarget={
                              committedCommentTargets.get(rootUiId) ?? null
                            }
                            editDraft={editDraft}
                            finding={findingsByCommentId.get(rootUiId) ?? null}
                            findingAnchor={
                              findingAnchorByCommentId.get(rootUiId) ?? null
                            }
                            isDeleting={
                              deleteConversationMutation.isPending ||
                              editConversationMutation.isPending ||
                              deleteReviewMutation.isPending ||
                              editReviewMutation.isPending
                            }
                            isEditing={editingCommentId === rootUiId}
                            isReplying={replyingToCommentId === rootUiId}
                            isResolving={
                              (resolveReviewThreadMutation.isPending &&
                                resolveReviewThreadMutation.variables ===
                                  rootActionId) ||
                              (unresolveReviewThreadMutation.isPending &&
                                unresolveReviewThreadMutation.variables ===
                                  rootActionId)
                            }
                            isSelected={selectedCommentId === rootUiId}
                            onChangeEditDraft={setEditDraft}
                            onCopyLink={copyCommentLink}
                            onDelete={() =>
                              deleteConversationComment(thread.root)
                            }
                            onEditSubmit={submitEdit}
                            onEditToggle={() => toggleEditComposer(thread.root)}
                            onReplyToggle={() =>
                              thread.root.canReply === true
                                ? toggleReplyComposer(rootUiId)
                                : undefined
                            }
                            onResolveThread={resolveReviewThread}
                            onSelect={() =>
                              onSelectComment(
                                selectedCommentId === rootUiId ? null : rootUiId
                              )
                            }
                            onSelectCommentDiffTarget={
                              onSelectCommentDiffTarget
                            }
                            onUnresolveThread={unresolveReviewThread}
                            replies={thread.replies}
                          />
                          {replyingToCommentId === rootUiId ? (
                            <InlineReplyComposer
                              draft={replyDraft}
                              isPending={replyMutation.isPending}
                              onCancel={closeReplyComposer}
                              onChangeDraft={setReplyDraft}
                              onSubmit={submitReply}
                            />
                          ) : null}
                        </ResolvedThreadCollapser>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/**
 * Copies the API-projected Branch View comment permalink and confirms only
 * after the browser clipboard write succeeds.
 */
export function copyBranchViewCommentLinkToClipboard(
  comment: BranchViewComment
): void {
  if (comment.htmlUrl.trim().length === 0) {
    return;
  }
  if (!globalThis.navigator.clipboard?.writeText) {
    return;
  }
  globalThis.navigator.clipboard
    .writeText(comment.htmlUrl)
    .then(() => toast.success("Copied link"))
    .catch(() => {});
}

/**
 * Collapses a resolved review thread into a one-line summary, mirroring the
 * inline diff view. Unresolved threads render their children unchanged.
 */
function ResolvedThreadCollapser({
  children,
  commentCount,
  resolved,
  root,
}: Readonly<{
  children: ReactNode;
  commentCount: number;
  resolved: boolean;
  root: BranchViewComment;
}>) {
  const [expanded, setExpanded] = useState(false);

  if (!resolved) {
    return <>{children}</>;
  }
  if (!expanded) {
    return (
      <CollapsedResolvedCommentSummary
        commentCount={commentCount}
        onExpand={() => setExpanded(true)}
        root={root}
      />
    );
  }
  return (
    <div className="space-y-2">
      <button
        aria-label="Collapse resolved conversation"
        className="flex items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
        data-comment-control="true"
        onClick={() => setExpanded(false)}
        type="button"
      >
        <ChevronDown className="h-3.5 w-3.5" />
        Collapse resolved conversation
      </button>
      {children}
    </div>
  );
}

function CollapsedResolvedCommentSummary({
  commentCount,
  onExpand,
  root,
}: Readonly<{
  commentCount: number;
  onExpand: () => void;
  root: BranchViewComment;
}>) {
  return (
    <button
      className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-accent/50"
      data-testid={`pr-comment-resolved-summary-${getBranchViewCommentUiId(root)}`}
      onClick={onExpand}
      type="button"
    >
      <CommentAvatar
        author={root.author}
        authorAvatar={root.authorAvatar}
        authorKind={root.authorKind}
        size="sm"
      />
      <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
        <span className="font-medium text-foreground">{root.author}</span>{" "}
        resolved this conversation
        {commentCount > 1 ? ` · ${commentCount} comments` : ""}
      </span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

function resolveBranchViewCommentAction({
  comment,
  isResolving,
  onResolveThread,
  onUnresolveThread,
}: {
  comment: BranchViewComment;
  isResolving: boolean;
  onResolveThread: (comment: BranchViewComment) => void;
  onUnresolveThread: (comment: BranchViewComment) => void;
}): ResolveThreadAction | null {
  if (canResolveBranchViewReviewThread(comment)) {
    return {
      isPending: isResolving,
      label: "Resolve thread",
      onSelect: () => onResolveThread(comment),
    };
  }
  if (canUnresolveBranchViewReviewThread(comment)) {
    return {
      isPending: isResolving,
      label: "Unresolve thread",
      onSelect: () => onUnresolveThread(comment),
    };
  }
  return null;
}
