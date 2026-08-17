"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { toast } from "@repo/design-system/components/ui/sonner";
import { cn } from "@repo/design-system/lib/utils";
import {
  CheckCircle2Icon,
  CheckIcon,
  type LucideIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  XIcon,
} from "lucide-react";
import {
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import type { GenericArtifact } from "../mock";
import {
  type ArtifactCommentAnchor,
  type ArtifactCommentSource,
  type ArtifactCommentStatus,
  commentAnchorType,
} from "./comment-contract";
import {
  CommentThreadCard,
  CommentThreadHeader,
  CommentThreadMain,
  CommentThreadReplies,
} from "./experimental/comment-thread";
import { ExternalSyncIndicator } from "./external-sync-indicator";
import {
  MentionCommentTextarea,
  MentionText,
} from "./mention-comment-textarea";

export type GenericCommentRecord = {
  anchorPreview?: string;
  id: string;
  author: string;
  body: string;
  time: string;
  context: string;
  traceRow?: number;
  anchor?: ArtifactCommentAnchor;
  status?: ArtifactCommentStatus;
  source?: ArtifactCommentSource;
  version?: string;
  /** Replies remain in the same canonical thread regardless of anchor type. */
  parentId?: string;
};

type CommentFilter = "all" | "open" | ArtifactCommentAnchor["type"];

const COMMENT_FILTERS: readonly CommentFilter[] = [
  "all",
  "open",
  "artifact",
  "content",
  "prototype",
  "trace",
  "code",
];

export type ArtifactCommentsPresentation = {
  artifactPlaceholder?: string;
  artifactTitle?: string;
  closeLabel?: string;
  icon?: LucideIcon;
  sessionPlaceholder?: string;
  sessionPromptDescription?: string;
  sessionPromptTitle?: string;
  sessionTitle?: string;
  submitLabel?: string;
};

type DetailTab = "artifact" | "details" | "sessions";
type CommentSetter = Dispatch<SetStateAction<GenericCommentRecord[]>>;
const PERSON_NAME_PARTS_PATTERN = /\s+/;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This shared rail intentionally owns its paired artifact/session variants and resize behavior.
export function ArtifactCommentsRail({
  activeTab,
  animate,
  artifact,
  availableWidth,
  config,
  draftRequest,
  generalComments,
  onOpenChange,
  onSelectArtifactComment,
  onSelectSessionComment,
  open,
  onWidthChange,
  selectionRequest,
  sessionComments,
  setGeneralComments,
  setSessionComments,
  width,
}: {
  activeTab: DetailTab;
  animate: boolean;
  artifact: GenericArtifact;
  availableWidth: number;
  config?: ArtifactCommentsPresentation;
  draftRequest?: {
    anchorPreview: string;
    commentId: string;
    nonce: number;
  } | null;
  generalComments: GenericCommentRecord[];
  onOpenChange: (open: boolean) => void;
  onSelectArtifactComment?: (comment: GenericCommentRecord) => void;
  onSelectSessionComment: (commentId: string, row: number) => void;
  open: boolean;
  onWidthChange: (width: number) => void;
  selectionRequest?: { commentId: string; nonce: number } | null;
  sessionComments: GenericCommentRecord[];
  setGeneralComments: CommentSetter;
  setSessionComments: CommentSetter;
  width: number;
}) {
  const [draft, setDraft] = useState("");
  const [pendingAnchor, setPendingAnchor] = useState<{
    anchorPreview: string;
    commentId: string;
  } | null>(null);
  const [replyingTo, setReplyingTo] = useState<{
    author: string;
    id: string;
  } | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);
  const [commentFilter, setCommentFilter] = useState<CommentFilter>("all");
  const commentRefs = useRef(new Map<string, HTMLElement>());
  const lastDraftRequestNonce = useRef<number | null>(null);
  const showingSessions = activeTab === "sessions";
  const sourceComments = showingSessions ? sessionComments : generalComments;
  const comments = sourceComments.filter((comment) => {
    if (commentFilter === "all") {
      return true;
    }
    if (commentFilter === "open") {
      return comment.status !== "resolved";
    }
    return (
      commentAnchorType(comment.anchor, comment.traceRow) === commentFilter
    );
  });
  const title = showingSessions
    ? (config?.sessionTitle ?? "Session comments")
    : (config?.artifactTitle ?? "Comments");
  const CommentsIcon = config?.icon ?? MessageSquareIcon;
  const commentCount = showingSessions
    ? sessionComments.length
    : artifact.commentCount + Math.max(0, generalComments.length - 2);
  const resolvedWidth = Math.min(width, availableWidth);

  useEffect(() => {
    if (!(open && !showingSessions && selectionRequest)) {
      return;
    }
    const selected = commentRefs.current.get(selectionRequest.commentId);
    if (selected) {
      setActiveCommentId(selectionRequest.commentId);
      requestAnimationFrame(() =>
        selected.scrollIntoView({ behavior: "smooth", block: "center" })
      );
    }
  }, [open, selectionRequest, showingSessions]);

  useEffect(() => {
    if (
      !(open && !showingSessions && draftRequest) ||
      lastDraftRequestNonce.current === draftRequest.nonce
    ) {
      return;
    }
    lastDraftRequestNonce.current = draftRequest.nonce;
    setPendingAnchor({
      anchorPreview: draftRequest.anchorPreview,
      commentId: draftRequest.commentId,
    });
    setReplyingTo(null);
    setReplyDraft("");
  }, [draftRequest, open, showingSessions]);

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = resolvedWidth;
    setResizing(true);
    const onMove = (moveEvent: PointerEvent) => {
      onWidthChange(
        Math.max(
          Math.min(220, availableWidth),
          Math.min(availableWidth, startWidth + startX - moveEvent.clientX)
        )
      );
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const addComment = () => {
    const body = draft.trim();
    if (!body) {
      return;
    }
    let context = "General comment";
    if (pendingAnchor) {
      context = `“${pendingAnchor.anchorPreview}”`;
    }
    let anchor: ArtifactCommentAnchor = { type: "artifact" };
    if (showingSessions) {
      anchor = { type: "trace" };
    } else if (pendingAnchor) {
      anchor = {
        type: "content",
        contentId: pendingAnchor.commentId,
        quote: pendingAnchor.anchorPreview,
      };
    }
    const nextComment: GenericCommentRecord = {
      id: pendingAnchor?.commentId ?? `comment-${Date.now()}`,
      author: "Andrew Eye",
      anchorPreview: pendingAnchor?.anchorPreview,
      body,
      context,
      time: "now",
      anchor,
      status: "open",
      source: { provider: "native" },
    };
    if (showingSessions) {
      setSessionComments((current) => [...current, nextComment]);
    } else {
      setGeneralComments((current) => [...current, nextComment]);
    }
    setDraft("");
    setPendingAnchor(null);
  };

  const addReply = () => {
    const body = replyDraft.trim();
    if (!(body && replyingTo)) {
      return;
    }
    const replyParent = sourceComments.find(
      (comment) => comment.id === replyingTo.id
    );
    if (!replyParent) {
      return;
    }
    const nextReply: GenericCommentRecord = {
      anchor: replyParent.anchor,
      anchorPreview: replyParent.anchorPreview,
      author: "Andrew Eye",
      body,
      context: `Reply to ${replyingTo.author}`,
      id: `comment-reply-${Date.now()}`,
      parentId: replyParent.id,
      source: { provider: "native" },
      status: "open",
      time: "now",
      traceRow: replyParent.traceRow,
    };
    if (showingSessions) {
      setSessionComments((current) => [...current, nextReply]);
    } else {
      setGeneralComments((current) => [...current, nextReply]);
    }
    setReplyDraft("");
    setReplyingTo(null);
    setActiveCommentId(replyParent.id);
  };

  return (
    <aside
      aria-hidden={!open}
      aria-label={`${title} ${commentCount}`}
      className={cn(
        "relative z-20 shrink-0 overflow-hidden bg-background transition-[width,opacity,border-color] ease-out",
        animate && !resizing ? "duration-200" : "duration-0",
        open
          ? "border-l opacity-100"
          : "pointer-events-none border-transparent opacity-0"
      )}
      style={{ width: open ? resolvedWidth : 0 }}
    >
      {open ? (
        <button
          aria-label="Resize comments rail"
          className={cn(
            "absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none hover:bg-primary/25 focus-visible:bg-primary/25 focus-visible:outline-none",
            resizing && "bg-primary/25"
          )}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              onWidthChange(Math.min(availableWidth, resolvedWidth + 24));
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              onWidthChange(
                Math.max(Math.min(220, availableWidth), resolvedWidth - 24)
              );
            } else if (event.key === "Home") {
              event.preventDefault();
              onWidthChange(availableWidth);
            } else if (event.key === "End") {
              event.preventDefault();
              onWidthChange(Math.min(220, availableWidth));
            }
          }}
          onPointerDown={startResize}
          type="button"
        />
      ) : null}
      <div className="flex h-full w-full min-w-0 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <CommentsIcon className="size-4 text-muted-foreground" />
          <h2 className="font-medium text-sm">{title}</h2>
          <Chip className="ml-1" variant="muted">
            {commentCount}
          </Chip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="ml-auto" size="sm" variant="ghost">
                {commentFilterLabel(commentFilter, true)}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {COMMENT_FILTERS.filter(
                (value) =>
                  !showingSessions ||
                  value === "all" ||
                  value === "open" ||
                  value === "trace"
              ).map((value) => (
                <DropdownMenuItem
                  key={value}
                  onSelect={() => setCommentFilter(value)}
                >
                  {commentFilterLabel(value)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            aria-label={config?.closeLabel ?? "Close comments"}
            onClick={() => onOpenChange(false)}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
          {comments
            .filter((comment) => !comment.parentId)
            .map((comment) => {
              let onSelect: (() => void) | undefined;
              if (showingSessions && comment.traceRow != null) {
                onSelect = () =>
                  onSelectSessionComment(comment.id, comment.traceRow ?? 0);
              } else if (
                comment.anchor &&
                comment.anchor.type !== "artifact" &&
                onSelectArtifactComment
              ) {
                onSelect = () => onSelectArtifactComment(comment);
              }
              return (
                <GenericComment
                  active={activeCommentId === comment.id}
                  comment={comment}
                  elementRef={(element) => {
                    if (element) {
                      commentRefs.current.set(comment.id, element);
                    } else {
                      commentRefs.current.delete(comment.id);
                    }
                  }}
                  key={comment.id}
                  onActivate={() => {
                    setActiveCommentId(comment.id);
                    onSelect?.();
                  }}
                  onReplyCancel={() => {
                    setReplyingTo(null);
                    setReplyDraft("");
                  }}
                  onReplyChange={setReplyDraft}
                  onReplyOpen={(replyTarget) => {
                    setActiveCommentId(comment.id);
                    setPendingAnchor(null);
                    setReplyDraft("");
                    setReplyingTo({
                      author: replyTarget.author,
                      id: replyTarget.id,
                    });
                  }}
                  onReplySubmit={addReply}
                  onResolve={() => {
                    const setter = showingSessions
                      ? setSessionComments
                      : setGeneralComments;
                    setter((current) =>
                      current.map((item) =>
                        item.id === comment.id
                          ? {
                              ...item,
                              status:
                                item.status === "resolved"
                                  ? "open"
                                  : "resolved",
                            }
                          : item
                      )
                    );
                  }}
                  replies={comments.filter(
                    (candidate) => candidate.parentId === comment.id
                  )}
                  replyDraft={replyDraft}
                  replying={replyingTo?.id === comment.id}
                  selected={
                    activeCommentId === comment.id ||
                    (!showingSessions &&
                      selectionRequest?.commentId === comment.id)
                  }
                />
              );
            })}
        </div>
        <div className={cn("border-t p-3", !showingSessions && "mb-4")}>
          {showingSessions ? (
            <div className="mb-3">
              <p className="font-medium text-sm">
                {config?.sessionPromptTitle ?? "How did this AI session go?"}
              </p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                {config?.sessionPromptDescription ??
                  "Add context about what worked well or could be improved."}
              </p>
            </div>
          ) : null}
          {pendingAnchor ? (
            <div className="mb-2 rounded-md border-primary border-l-2 bg-muted/50 px-3 py-2 text-xs">
              <p className="font-medium text-muted-foreground">Commenting on</p>
              <p className="mt-0.5 line-clamp-2">
                “{pendingAnchor.anchorPreview}”
              </p>
            </div>
          ) : null}
          <MentionCommentTextarea
            ariaLabel={`Add a ${showingSessions ? "session " : ""}comment`}
            autoFocus={Boolean(pendingAnchor)}
            className="min-h-20 resize-none text-sm"
            key={pendingAnchor?.commentId ?? "comment-draft"}
            onChange={setDraft}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                addComment();
              }
            }}
            placeholder={
              showingSessions
                ? (config?.sessionPlaceholder ??
                  "Share feedback and @mention someone…")
                : (config?.artifactPlaceholder ??
                  "Add a comment and @mention someone…")
            }
            value={draft}
          />
          <div className="mt-2 flex justify-end">
            <Button disabled={!draft.trim()} onClick={addComment} size="sm">
              {config?.submitLabel ?? "Comment"}
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function CommentContextHeader({ comment }: { comment: GenericCommentRecord }) {
  if (!(comment.context || comment.source?.externalSync || comment.version)) {
    return null;
  }

  return (
    <div className="border-b bg-muted/20 px-3 py-1.5 text-muted-foreground text-xs">
      {comment.context || comment.version ? (
        <div className="flex min-h-5 min-w-0 items-center gap-1.5">
          {comment.context ? (
            <span className="min-w-0 flex-1 truncate">{comment.context}</span>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          {comment.version ? (
            <Chip variant="muted">{comment.version}</Chip>
          ) : null}
        </div>
      ) : null}
      {comment.source?.externalSync ? (
        <ExternalSyncIndicator
          className="mt-0.5 w-full"
          relationship={comment.source.externalSync}
        />
      ) : null}
    </div>
  );
}

function GenericComment({
  active,
  comment,
  elementRef,
  onActivate,
  onReplyCancel,
  onReplyChange,
  onReplyOpen,
  onReplySubmit,
  onResolve,
  replyDraft,
  replies,
  replying,
  selected = false,
}: {
  active: boolean;
  comment: GenericCommentRecord;
  elementRef?: (element: HTMLElement | null) => void;
  onActivate: () => void;
  onReplyCancel: () => void;
  onReplyChange: (value: string) => void;
  onReplyOpen: (comment: GenericCommentRecord) => void;
  onReplySubmit: () => void;
  onResolve: () => void;
  replyDraft: string;
  replies: GenericCommentRecord[];
  replying: boolean;
  selected?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const showThreadActions = active || selected || hovered;
  const showReplyAffordance = active || selected;
  const resolveLabel =
    comment.status === "resolved" ? "Reopen comment" : "Resolve comment";
  const resolve = () => {
    onResolve();
    toast.success(
      comment.status === "resolved" ? "Comment reopened" : "Comment resolved"
    );
  };

  return (
    <div ref={elementRef}>
      <CommentThreadCard
        className="group bg-card"
        interactive
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("[data-comment-control]")) {
            return;
          }
          onActivate();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onActivate();
          }
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        role="group"
        selected={selected}
        tabIndex={0}
      >
        <CommentContextHeader comment={comment} />
        <CommentThreadMain
          actions={
            <div
              className={cn(
                "flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
                showThreadActions && "opacity-100"
              )}
              data-comment-control
            >
              <Button
                aria-label={resolveLabel}
                className={cn(
                  "text-muted-foreground hover:text-primary",
                  comment.status === "resolved" && "text-success"
                )}
                onClick={resolve}
                size="icon-sm"
                title={resolveLabel}
                type="button"
                variant="ghost"
              >
                {comment.status === "resolved" ? (
                  <CheckCircle2Icon />
                ) : (
                  <CheckIcon />
                )}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label={`More actions for ${comment.author}'s comment`}
                    className="text-muted-foreground"
                    size="icon-sm"
                    variant="ghost"
                  >
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => toast.success("Comment link copied")}
                  >
                    Copy link
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={resolve}>
                    {comment.status === "resolved" ? "Reopen" : "Resolve"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          }
          avatar={
            <Avatar className="size-8">
              <AvatarFallback className="text-[10px]">
                {personInitials(comment.author)}
              </AvatarFallback>
            </Avatar>
          }
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-3 sm:gap-x-3"
          content={
            <>
              <CommentThreadHeader
                author={
                  <span className="font-medium text-sm">{comment.author}</span>
                }
                className="col-start-2 row-start-1 self-center"
                metadata={
                  <span className="text-muted-foreground text-xs">
                    {comment.time}
                  </span>
                }
              />
              <p className="col-span-3 row-start-2 text-sm leading-5">
                <MentionText text={comment.body} />
              </p>
            </>
          }
          contentClassName="contents"
        />
        {replies.length > 0 ? (
          <CommentThreadReplies
            className="border-l-0 bg-transparent px-3 pt-0 pb-3 sm:px-4"
            showDivider={false}
          >
            {replies.map((reply) => (
              <CommentThreadMain
                avatar={
                  <Avatar className="size-7">
                    <AvatarFallback className="text-[9px]">
                      {personInitials(reply.author)}
                    </AvatarFallback>
                  </Avatar>
                }
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-3 p-0 sm:gap-x-3 sm:p-0"
                content={
                  <>
                    <CommentThreadHeader
                      author={
                        <span className="font-medium text-sm">
                          {reply.author}
                        </span>
                      }
                      className="col-start-2 row-start-1 self-center"
                      metadata={
                        <span className="text-muted-foreground text-xs">
                          {reply.time}
                        </span>
                      }
                    />
                    <p className="col-span-3 row-start-2 text-sm leading-5">
                      <MentionText text={reply.body} />
                    </p>
                  </>
                }
                contentClassName="contents"
                key={reply.id}
              />
            ))}
          </CommentThreadReplies>
        ) : null}
        {showReplyAffordance && !replying ? (
          <div className="px-3 pb-3 sm:px-4 sm:pb-4" data-comment-control>
            <button
              className="w-full rounded-full border px-3 py-2 text-left text-muted-foreground text-sm transition-colors hover:border-foreground/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onReplyOpen(comment)}
              type="button"
            >
              Reply or add others with @
            </button>
          </div>
        ) : null}
        {replying ? (
          <div className="px-3 pb-3 sm:px-4 sm:pb-4" data-comment-control>
            <MentionCommentTextarea
              ariaLabel={`Reply to ${comment.author}`}
              autoFocus
              className="min-h-16 resize-none rounded-2xl text-sm"
              onChange={onReplyChange}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  onReplySubmit();
                }
              }}
              placeholder="Reply or add others with @"
              value={replyDraft}
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button onClick={onReplyCancel} size="sm" variant="ghost">
                Cancel
              </Button>
              <Button
                disabled={!replyDraft.trim()}
                onClick={onReplySubmit}
                size="sm"
              >
                Reply
              </Button>
            </div>
          </div>
        ) : null}
      </CommentThreadCard>
    </div>
  );
}

function commentFilterLabel(filter: CommentFilter, compact = false) {
  if (filter === "all") {
    return compact ? "All" : "All comments";
  }
  if (filter === "open") {
    return compact ? "Open" : "Open comments";
  }
  const label =
    filter === "prototype"
      ? "Prototype"
      : filter[0].toUpperCase() + filter.slice(1);
  return compact ? label : `${label} comments`;
}

function personInitials(name: string) {
  return name
    .split(PERSON_NAME_PARTS_PATTERN)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
