"use client";

import {
  type BranchViewComment,
  type BranchViewCommentCreatePromptEligibility,
  CommentKind,
  FileChangeStatus,
  GitHubDiffSide,
} from "@repo/api/src/types/branch-view";
import { branchDiffViewerStyles } from "@repo/app/branches/components/diff/branch-diff-viewer-theme";
import {
  BranchFileDiffViewer,
  type BranchFileDiffViewerProps,
} from "@repo/app/branches/components/diff/branch-file-diff-viewer";
import {
  useBranchViewFileDiff,
  useCreateBranchViewInlineComment,
  useReplyToComment,
  useResolveBranchViewReviewThread,
  useUnresolveBranchViewReviewThread,
} from "@repo/app/documents/hooks/use-branch-view";
import { parseBranchViewCommentIdentityBlocker } from "@repo/app/github/lib/branch-view-comment-identity-blocker";
import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useCopyToClipboard } from "@repo/design-system/hooks/use-copy-to-clipboard";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageSquare,
} from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { CommentMarkdown } from "@/lib/markdown";
import {
  getReplyTargetGithubCommentId,
  getReviewThreadActionId,
} from "../comment-resolution";
import { fetchBranchLocalDiff } from "../local-branch-changes";
import {
  type BranchViewFileDiff,
  type ChangedFileEntry,
  FileSection,
} from "../types";
import { handleBranchViewCommentActionResult } from "./branch-comment-action-result";
import { BranchCommentWriteIdentityPrompt } from "./branch-comment-write-identity-prompt";
import {
  clampRangeToContiguous,
  collectRenderedLineNumbers,
  findRenderedRightLineRow,
  findScrollAreaViewport,
  getLeftLineHighlightId,
  getRenderedSplitRowHighlightIds,
  getRightLineHighlightId,
  hasRenderedDiffRows,
  parseRenderedDiffLineAnchor,
  type RenderedDiffLineAnchor,
  scrollRowIntoDiffViewport,
} from "./branch-diff-target";
import {
  type BranchReviewFinding,
  type BranchReviewFindingAnchorClassification,
  BranchReviewFindingAnchorStatus,
  classifyBranchReviewFindingAnchor,
  getBranchReviewFindingAnchorStatusLabel,
  getBranchReviewFindingMarkerLabel,
  getBranchReviewFindingSeverityClassName,
  getBranchReviewFindingSeverityLabel,
  isBranchReviewFinding,
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
import { buildCommentThreads, type CommentThread } from "./comment-threads";
import { WhyThisChangePopover } from "./why-this-change-popover";

const MAX_TARGET_NAVIGATION_FRAMES = 60;
const LEFT_DIFF_PREFIX = "L";
// Branch target navigation uses GitHub-like attention colors instead of the
// shared neutral diff highlight, which reads as an ambiguous transient grey.
const branchTargetDiffViewerStyles = {
  ...branchDiffViewerStyles,
  variables: {
    light: {
      ...branchDiffViewerStyles.variables.light,
      highlightBackground: "color-mix(in oklch, #facc15 30%, transparent)",
      highlightGutterBackground:
        "color-mix(in oklch, #facc15 48%, transparent)",
    },
    dark: {
      ...branchDiffViewerStyles.variables.dark,
      highlightBackground: "color-mix(in oklch, #fb923c 34%, transparent)",
      highlightGutterBackground:
        "color-mix(in oklch, #fb923c 52%, transparent)",
    },
  },
};

function statusLabel(status: ChangedFileEntry["file"]["status"]): string {
  if (status === FileChangeStatus.Added) {
    return "Added";
  }
  if (status === FileChangeStatus.Removed) {
    return "Removed";
  }
  if (status === FileChangeStatus.Renamed) {
    return "Renamed";
  }
  return "Modified";
}

type BranchDiffViewProps = {
  allFiles: ChangedFileEntry[];
  externalLinkId: string;
  localDiffContext?:
    | (Omit<
        Parameters<typeof fetchBranchLocalDiff>[0],
        "path" | "previousPath"
      > & {
        routingKey: string;
      })
    | null;
  onClose: () => void;
  onSelectFile: (fileId: string) => void;
  selectedFileId: string;
  targetActivationId: number | null;
  targetLine: number | null;
  canCreateInlineComment?: boolean;
  commentPromptEligibility?: BranchViewCommentCreatePromptEligibility;
  comments?: BranchViewComment[];
  expectedHeadSha?: string | null;
  branchHeadSha?: string | null;
  producedByPlanSlug?: string | null;
  producedByPlanTitle?: string | null;
};

type SelectedFileNavigation = {
  currentEntry: ChangedFileEntry | null;
  hasNext: boolean;
  hasPrev: boolean;
  nextEntry: ChangedFileEntry | null;
  prevEntry: ChangedFileEntry | null;
  safeIndex: number;
  total: number;
};

function getSelectedFileNavigation(
  allFiles: ChangedFileEntry[],
  selectedFileId: string
): SelectedFileNavigation {
  const currentIndex = allFiles.findIndex((f) => f.fileId === selectedFileId);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const currentEntry = currentIndex >= 0 ? allFiles[currentIndex] : null;
  const total = allFiles.length;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < total - 1;

  return {
    currentEntry,
    hasNext,
    hasPrev,
    nextEntry: hasNext ? allFiles[safeIndex + 1] : null,
    prevEntry: hasPrev ? allFiles[safeIndex - 1] : null,
    safeIndex,
    total,
  };
}

type TargetLineNavigationParams = {
  diffError: unknown;
  diffRootRef: RefObject<HTMLDivElement | null>;
  isBinary: boolean | undefined;
  isDiffLoading: boolean;
  newContent: string | undefined;
  oldContent: string | undefined;
  selectedFileId: string;
  setSelectedLineHighlightIds: (lineIds: string[]) => void;
  targetActivationId: number | null;
  targetLine: number | null;
};

function scrollMissingTargetToTop(root: HTMLDivElement): void {
  const viewport = findScrollAreaViewport(root);
  if (viewport && typeof viewport.scrollTo === "function") {
    viewport.scrollTo({ top: 0 });
    return;
  }
  if (viewport) {
    viewport.scrollTop = 0;
  }
}

function requestFrame(callback: FrameRequestCallback): number {
  const request =
    globalThis.requestAnimationFrame ??
    ((frameCallback: FrameRequestCallback) =>
      globalThis.setTimeout(() => frameCallback(performance.now()), 0));
  return request(callback);
}

function cancelFrame(id: number): void {
  const cancel =
    globalThis.cancelAnimationFrame ??
    ((frameId: number) => globalThis.clearTimeout(frameId));
  try {
    cancel(id);
  } catch {
    globalThis.clearTimeout(id);
  }
}

function useTargetLineNavigation({
  diffError,
  diffRootRef,
  isBinary,
  isDiffLoading,
  newContent,
  oldContent,
  selectedFileId,
  setSelectedLineHighlightIds,
  targetActivationId,
  targetLine,
}: TargetLineNavigationParams): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: target navigation must rerun when the selected file, activation id, or rendered diff content changes.
  useEffect(() => {
    if (
      targetLine === null ||
      isDiffLoading ||
      diffError ||
      isBinary ||
      !diffRootRef.current
    ) {
      setSelectedLineHighlightIds([]);
      return;
    }

    let frameId: number | null = null;
    let observer: MutationObserver | null = null;
    let framesWithoutRows = 0;

    const disconnectObserver = () => {
      observer?.disconnect();
      observer = null;
    };

    const runNavigation = () => {
      frameId = null;
      const root = diffRootRef.current;
      if (!root) {
        setSelectedLineHighlightIds([]);
        return;
      }

      const row = findRenderedRightLineRow(root, targetLine);
      if (!row) {
        if (
          !hasRenderedDiffRows(root) &&
          framesWithoutRows < MAX_TARGET_NAVIGATION_FRAMES
        ) {
          framesWithoutRows += 1;
          frameId = requestFrame(runNavigation);
          return;
        }
        scrollMissingTargetToTop(root);
        setSelectedLineHighlightIds([]);
        return;
      }

      if (!scrollRowIntoDiffViewport(root, row)) {
        row.scrollIntoView({ block: "center" });
      }
      setSelectedLineHighlightIds(getRenderedSplitRowHighlightIds(row));
      disconnectObserver();
    };

    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => {
        if (frameId === null) {
          frameId = requestFrame(runNavigation);
        }
      });
      observer.observe(diffRootRef.current, { childList: true, subtree: true });
    }
    frameId = requestFrame(runNavigation);

    return () => {
      disconnectObserver();
      if (frameId !== null) {
        cancelFrame(frameId);
      }
    };
  }, [
    selectedFileId,
    targetLine,
    targetActivationId,
    isDiffLoading,
    diffError,
    isBinary,
    oldContent,
    newContent,
    diffRootRef,
    setSelectedLineHighlightIds,
  ]);
}

type ReplyToInlineThreadHandler = (
  root: BranchViewComment,
  body: string,
  onDone: () => void
) => void;

type BranchDiffContentProps = {
  diffData: BranchViewFileDiff | undefined;
  diffError: unknown;
  expandedFindingId: string | null;
  inlineComposer: ReactNode;
  inlineComposerAnchor: RenderedDiffLineAnchor | null;
  inlineThreads: CommentThread[];
  inlineFindings: ClassifiedBranchReviewFinding[];
  isDiffLoading: boolean;
  isReplyPending: boolean;
  onSelectRenderedLine: (
    lineId: string,
    event: MouseEvent<HTMLTableCellElement>
  ) => void;
  onReplyInlineThread: ReplyToInlineThreadHandler;
  onResolveInlineThread: (comment: BranchViewComment) => void;
  onToggleFinding: (findingId: string) => void;
  onUnresolveInlineThread: (comment: BranchViewComment) => void;
  selectedLineHighlightIds: string[];
  targetLine: number | null;
  unplacedFindings: ClassifiedBranchReviewFinding[];
};

type BranchFileDiffViewerRenderGutterData = Parameters<
  NonNullable<
    NonNullable<BranchFileDiffViewerProps["viewerProps"]>["renderGutter"]
  >
>[0];

type ClassifiedBranchReviewFinding = {
  classification: BranchReviewFindingAnchorClassification;
  finding: BranchReviewFinding;
};

/** A single-line or multi-line inline selection. `startLine === endLine` for single line. */
type LineSelection = {
  side: GitHubDiffSide;
  startLine: number;
  endLine: number;
};

type InlineComposerProps = {
  selection: LineSelection;
  draft: string;
  isPending: boolean;
  onCancel: () => void;
  onChangeDraft: (value: string) => void;
  onSubmit: () => void;
};

const EMPTY_THREADS: readonly CommentThread[] = [];
const EMPTY_FINDINGS: readonly ClassifiedBranchReviewFinding[] = [];

/** Stable key for a gutter row, shared by the lookup maps and the gutter lookup. */
function gutterRowKey(
  side: GitHubDiffSide | null,
  line: number | null
): string {
  return `${side}:${line}`;
}

/** Group inline threads by their root's (side, line) anchor for O(1) gutter lookup. */
function buildThreadsByRow(
  threads: CommentThread[]
): Map<string, CommentThread[]> {
  const map = new Map<string, CommentThread[]>();
  for (const thread of threads) {
    const key = gutterRowKey(thread.root.side ?? null, thread.root.line);
    const existing = map.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      map.set(key, [thread]);
    }
  }
  return map;
}

/** Group current-anchored findings by (side, line) for O(1) gutter lookup. */
function buildFindingsByRow(
  findings: ClassifiedBranchReviewFinding[]
): Map<string, ClassifiedBranchReviewFinding[]> {
  const map = new Map<string, ClassifiedBranchReviewFinding[]>();
  for (const item of findings) {
    if (
      item.classification.status !== BranchReviewFindingAnchorStatus.Current
    ) {
      continue;
    }
    const key = gutterRowKey(
      item.classification.side,
      item.classification.line
    );
    const existing = map.get(key);
    if (existing) {
      existing.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

/**
 * Expand multi-line comment ranges into a per-(side, line) bracket lookup so the
 * gutter resolves bracket state in O(1) instead of scanning every range per row.
 * First range covering a line wins, matching the prior linear-scan behavior.
 */
function buildBracketByRow(
  ranges: InlineCommentRange[]
): Map<string, LineBracketInfo> {
  const map = new Map<string, LineBracketInfo>();
  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLine; line++) {
      const key = gutterRowKey(range.side, line);
      if (!map.has(key)) {
        map.set(key, {
          isEnd: line === range.endLine,
          isStart: line === range.startLine,
        });
      }
    }
  }
  return map;
}

function BranchDiffContent({
  diffData,
  diffError,
  expandedFindingId,
  inlineComposer,
  inlineComposerAnchor,
  inlineThreads,
  inlineFindings,
  isDiffLoading,
  isReplyPending,
  onReplyInlineThread,
  onResolveInlineThread,
  onSelectRenderedLine,
  onToggleFinding,
  onUnresolveInlineThread,
  selectedLineHighlightIds,
  targetLine,
  unplacedFindings,
}: Readonly<BranchDiffContentProps>) {
  // Index threads/findings by (side, line) once per change so each gutter row
  // does an O(1) lookup instead of a full scan (the gutter renders once per
  // rendered line on both sides, so the scans were O(renderedLines × items)).
  const threadsByRow = useMemo(
    () => buildThreadsByRow(inlineThreads),
    [inlineThreads]
  );
  const findingsByRow = useMemo(
    () => buildFindingsByRow(inlineFindings),
    [inlineFindings]
  );
  const bracketByRow = useMemo(
    () => buildBracketByRow(getInlineCommentRanges(inlineThreads)),
    [inlineThreads]
  );

  if (isDiffLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (diffError) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Failed to load diff
      </div>
    );
  }

  if (diffData?.isBinary) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Binary file not shown
      </div>
    );
  }

  function renderInlineGutter(data: BranchFileDiffViewerRenderGutterData) {
    const side =
      data.prefix === LEFT_DIFF_PREFIX
        ? GitHubDiffSide.Left
        : GitHubDiffSide.Right;
    const line = data.lineNumber;
    const rowKey = gutterRowKey(side, line);
    const rowThreads = threadsByRow.get(rowKey) ?? EMPTY_THREADS;
    const rowFindings = findingsByRow.get(rowKey) ?? EMPTY_FINDINGS;
    const rowComposer =
      inlineComposerAnchor?.side === side && inlineComposerAnchor.line === line
        ? inlineComposer
        : null;
    const bracketInfo = bracketByRow.get(rowKey) ?? null;

    return (
      <td
        className="relative align-top"
        data-testid={`inline-gutter-${side}-${line ?? "empty"}`}
      >
        {bracketInfo ? <RangeBracket info={bracketInfo} /> : null}
        <InlineCommentRowSlot
          composer={rowComposer}
          expandedFindingId={expandedFindingId}
          findings={rowFindings}
          isReplyPending={isReplyPending}
          line={line}
          onReply={onReplyInlineThread}
          onResolve={onResolveInlineThread}
          onToggleFinding={onToggleFinding}
          onUnresolve={onUnresolveInlineThread}
          side={side}
          threads={rowThreads}
        />
      </td>
    );
  }

  return (
    <BranchFileDiffViewer
      binaryFallback={
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          Binary file not shown
        </div>
      }
      diffData={diffData}
      diffError={diffError}
      errorFallback={
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          Failed to load diff
        </div>
      }
      isDiffLoading={isDiffLoading}
      leadingContent={
        unplacedFindings.length > 0 ? (
          <UnplacedReviewFindings findings={unplacedFindings} />
        ) : null
      }
      loadingFallback={
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
      scrollAreaClassName="h-full"
      viewerProps={{
        alwaysShowLines:
          targetLine == null ? [] : [getRightLineHighlightId(targetLine)],
        hideLineNumbers: false,
        highlightLines: selectedLineHighlightIds,
        onLineNumberClick: onSelectRenderedLine,
        renderGutter: renderInlineGutter,
        splitView: true,
        styles: branchTargetDiffViewerStyles,
      }}
    />
  );
}

function InlineCommentRowSlot({
  composer,
  expandedFindingId,
  findings,
  isReplyPending,
  line,
  onReply,
  onResolve,
  onToggleFinding,
  onUnresolve,
  side,
  threads,
}: Readonly<{
  composer: ReactNode;
  expandedFindingId: string | null;
  findings: readonly ClassifiedBranchReviewFinding[];
  isReplyPending: boolean;
  line: number | null;
  onReply: ReplyToInlineThreadHandler;
  onResolve: (comment: BranchViewComment) => void;
  onToggleFinding: (findingId: string) => void;
  onUnresolve: (comment: BranchViewComment) => void;
  side: GitHubDiffSide;
  threads: readonly CommentThread[];
}>) {
  if (threads.length === 0 && findings.length === 0 && !composer) {
    return <div aria-hidden className="min-h-5 w-10" />;
  }

  return (
    <div
      className="w-[22rem] max-w-[calc(100vw-3rem)] space-y-2 py-1 pr-2 sm:max-w-[42vw]"
      data-testid={`inline-comment-row-${side}-${line ?? "empty"}`}
    >
      {composer}
      {findings.map(({ finding }) => (
        <InlineReviewFinding
          expanded={expandedFindingId === finding.id}
          finding={finding}
          key={finding.id}
          onToggle={() => onToggleFinding(finding.id)}
        />
      ))}
      {threads.map((thread) => (
        <InlineCommentThread
          isReplyPending={isReplyPending}
          key={thread.root.id}
          onReply={onReply}
          onResolve={onResolve}
          onUnresolve={onUnresolve}
          thread={thread}
        />
      ))}
    </div>
  );
}

function InlineCommentBody({
  comment,
  lineLabel,
}: Readonly<{ comment: BranchViewComment; lineLabel?: string | null }>) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground text-xs">
          {comment.author}
        </span>
        <time className="shrink-0 text-[11px] text-muted-foreground">
          {formatRelativeTime(comment.createdAt)}
        </time>
      </div>
      {lineLabel ? (
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {lineLabel}
        </div>
      ) : null}
      <CommentMarkdown className="mt-1 break-words text-card-foreground">
        {comment.body}
      </CommentMarkdown>
    </div>
  );
}

/** Label for a comment anchored to a multi-line range; null for single-line. */
function commentRangeLabel(comment: BranchViewComment): string | null {
  if (
    comment.startLine == null ||
    comment.line == null ||
    comment.startLine >= comment.line
  ) {
    return null;
  }
  const noun =
    comment.side === GitHubDiffSide.Left ? "Original lines" : "Lines";
  return `${noun} ${comment.startLine} to ${comment.line}`;
}

function InlineCommentThread({
  isReplyPending,
  onReply,
  onResolve,
  onUnresolve,
  thread,
}: Readonly<{
  isReplyPending: boolean;
  onReply: ReplyToInlineThreadHandler;
  onResolve: (comment: BranchViewComment) => void;
  onUnresolve: (comment: BranchViewComment) => void;
  thread: CommentThread;
}>) {
  const { root, replies } = thread;
  const identityPrompts = useBranchViewCommentIdentityBlockers();
  const [replyDraft, setReplyDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const canResolve = canResolveBranchViewReviewThread(root);
  const canUnresolve = canUnresolveBranchViewReviewThread(root);
  const canReply =
    root.kind === CommentKind.ReviewComment && root.canReply === true;
  const isResolved = root.resolved === true;
  const collapsed = isResolved && !expanded;
  const replyPrompt = identityPrompts.getActionPrompt(root, ["reply"]);
  const managementPrompt = identityPrompts.getActionPrompt(root, [
    "resolve",
    "unresolve",
  ]);

  function submitReply() {
    const body = replyDraft.trim();
    if (body.length === 0) {
      return;
    }
    onReply(root, body, () => setReplyDraft(""));
  }

  if (collapsed) {
    return (
      <CollapsedResolvedThread
        commentCount={replies.length + 1}
        onExpand={() => setExpanded(true)}
        root={root}
      />
    );
  }

  return (
    <div
      className={cn(INLINE_REVIEW_CARD_SURFACE_CLASS_NAME)}
      data-testid={`inline-comment-${root.side}-${root.line}`}
    >
      <div className="space-y-3 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <CommentAvatar
            author={root.author}
            authorAvatar={root.authorAvatar}
            authorKind={root.authorKind}
            size="xs"
          />
          <InlineCommentBody
            comment={root}
            lineLabel={commentRangeLabel(root)}
          />
          {isResolved ? (
            <ResolvedThreadToggle
              expanded={expanded}
              onToggle={() => setExpanded((value) => !value)}
            />
          ) : null}
        </div>
        {replies.length > 0 ? (
          <div className="ml-[9px] space-y-2.5 rounded-md rounded-l-none border-border/70 border-l-2 bg-muted/40 py-2.5 pr-2.5 pl-3.5">
            <div className="font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
              {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
            </div>
            {replies.map((reply) => (
              <div className="flex items-start gap-2" key={reply.id}>
                <CommentAvatar
                  author={reply.author}
                  authorAvatar={reply.authorAvatar}
                  authorKind={reply.authorKind}
                  size="xs"
                />
                <InlineCommentBody comment={reply} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {canReply ? (
        <div className="border-border/70 border-t bg-muted/30 px-3 py-2.5">
          <Textarea
            aria-label="Reply to comment"
            className="min-h-[60px] resize-y bg-background text-sm"
            disabled={isReplyPending}
            onChange={(event) => setReplyDraft(event.target.value)}
            placeholder="Reply..."
            value={replyDraft}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <InlineThreadResolveButton
              canResolve={canResolve}
              canUnresolve={canUnresolve}
              comment={root}
              onResolve={onResolve}
              onUnresolve={onUnresolve}
            />
            <Button
              className="h-7 px-2.5 text-xs"
              disabled={replyDraft.trim().length === 0 || isReplyPending}
              onClick={submitReply}
              size="sm"
              type="button"
            >
              {isReplyPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
              )}
              Reply
            </Button>
          </div>
        </div>
      ) : (
        <InlineThreadResolveFooter
          canResolve={canResolve}
          canUnresolve={canUnresolve}
          comment={root}
          onResolve={onResolve}
          onUnresolve={onUnresolve}
        />
      )}
      <BranchCommentWriteIdentityPrompt prompt={replyPrompt} />
      <BranchCommentWriteIdentityPrompt prompt={managementPrompt} />
    </div>
  );
}

function CollapsedResolvedThread({
  commentCount,
  onExpand,
  root,
}: Readonly<{
  commentCount: number;
  onExpand: () => void;
  root: BranchViewComment;
}>) {
  return (
    <div
      className={cn(INLINE_REVIEW_CARD_SURFACE_CLASS_NAME)}
      data-testid={`inline-comment-${root.side}-${root.line}`}
    >
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        data-testid={`inline-comment-resolved-summary-${root.side}-${root.line}`}
        onClick={onExpand}
        type="button"
      >
        <CommentAvatar
          author={root.author}
          authorAvatar={root.authorAvatar}
          authorKind={root.authorKind}
          size="xs"
        />
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          <span className="font-medium text-foreground">{root.author}</span>{" "}
          resolved this conversation
          {commentCount > 1 ? ` · ${commentCount} comments` : ""}
        </span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
    </div>
  );
}

function ResolvedThreadToggle({
  expanded,
  onToggle,
}: Readonly<{ expanded: boolean; onToggle: () => void }>) {
  return (
    <Badge
      asChild
      className="shrink-0 gap-0.5 px-1.5 text-[10px] uppercase tracking-wide"
      variant="success"
    >
      <button
        aria-expanded={expanded}
        aria-label={
          expanded
            ? "Collapse resolved conversation"
            : "Expand resolved conversation"
        }
        onClick={onToggle}
        type="button"
      >
        Resolved
        <ChevronRight className={cn("h-3 w-3", expanded && "rotate-90")} />
      </button>
    </Badge>
  );
}

function InlineThreadResolveFooter({
  canResolve,
  canUnresolve,
  comment,
  onResolve,
  onUnresolve,
}: Readonly<{
  canResolve: boolean;
  canUnresolve: boolean;
  comment: BranchViewComment;
  onResolve: (comment: BranchViewComment) => void;
  onUnresolve: (comment: BranchViewComment) => void;
}>) {
  if (!(canResolve || canUnresolve)) {
    return null;
  }
  return (
    <div className="border-border/70 border-t bg-muted/30 px-3 py-2">
      <InlineThreadResolveButton
        canResolve={canResolve}
        canUnresolve={canUnresolve}
        comment={comment}
        onResolve={onResolve}
        onUnresolve={onUnresolve}
      />
    </div>
  );
}

function InlineThreadResolveButton({
  canResolve,
  canUnresolve,
  comment,
  onResolve,
  onUnresolve,
}: Readonly<{
  canResolve: boolean;
  canUnresolve: boolean;
  comment: BranchViewComment;
  onResolve: (comment: BranchViewComment) => void;
  onUnresolve: (comment: BranchViewComment) => void;
}>) {
  if (!(canResolve || canUnresolve)) {
    return <span aria-hidden />;
  }
  return (
    <Button
      className="h-7 px-2.5 text-xs"
      onClick={() => (canResolve ? onResolve(comment) : onUnresolve(comment))}
      size="sm"
      type="button"
      variant="outline"
    >
      {canResolve ? "Resolve conversation" : "Unresolve conversation"}
    </Button>
  );
}

function InlineReviewFinding({
  expanded,
  finding,
  onToggle,
}: Readonly<{
  expanded: boolean;
  finding: BranchReviewFinding;
  onToggle: () => void;
}>) {
  const markerLabel = getBranchReviewFindingMarkerLabel(finding);
  return (
    <div
      className={INLINE_REVIEW_CARD_SURFACE_CLASS_NAME}
      data-testid={`inline-finding-${finding.comment.side}-${finding.comment.line}`}
    >
      <Button
        aria-expanded={expanded}
        aria-label={`AI review finding ${markerLabel}`}
        className={cn(
          "h-7 min-w-10 gap-1 rounded-md border px-2 font-semibold text-xs",
          getBranchReviewFindingSeverityClassName(finding.severity)
        )}
        data-testid={`inline-finding-marker-${finding.comment.side}-${finding.comment.line}`}
        onClick={onToggle}
        size="sm"
        type="button"
        variant="outline"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        {finding.priority ??
          getBranchReviewFindingSeverityLabel(finding.severity)}
      </Button>
      {expanded ? (
        <div className="space-y-2 border-border border-t px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
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
            <span className="font-medium text-foreground text-xs">
              {finding.title}
            </span>
          </div>
          <FindingMetadata finding={finding} />
          <CommentMarkdown className="text-muted-foreground text-xs">
            {finding.comment.body}
          </CommentMarkdown>
        </div>
      ) : null}
    </div>
  );
}

function FindingMetadata({
  finding,
}: Readonly<{ finding: BranchReviewFinding }>) {
  const items = [
    finding.confidence ? `Confidence: ${finding.confidence}` : null,
    finding.suggestion ? `Suggestion: ${finding.suggestion}` : null,
    finding.locSavings ? `LOC savings: ${finding.locSavings}` : null,
    finding.isMetadataTruncated
      ? "Metadata parsed from the bounded prefix"
      : null,
  ].filter((item): item is string => item !== null);
  if (items.length === 0) {
    return null;
  }
  return (
    <ul className="space-y-1 text-muted-foreground text-xs">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function UnplacedReviewFindings({
  findings,
}: Readonly<{ findings: ClassifiedBranchReviewFinding[] }>) {
  return (
    <div
      className="m-3 space-y-2 rounded-md border border-border bg-muted/30 p-3"
      data-testid="unplaced-review-findings"
    >
      <div className="font-medium text-foreground text-sm">
        Outdated or unplaced findings
      </div>
      {findings.map(({ classification, finding }) => (
        <div
          className="flex min-w-0 items-start gap-2 text-sm"
          data-testid={`unplaced-finding-${classification.status}`}
          key={finding.id}
        >
          <Badge
            className={cn(
              "mt-0.5 rounded-sm border px-1.5 py-0 font-semibold text-[11px]",
              getBranchReviewFindingSeverityClassName(finding.severity)
            )}
            variant="outline"
          >
            {finding.priority ??
              getBranchReviewFindingSeverityLabel(finding.severity)}
          </Badge>
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">
              {finding.title}
            </div>
            <div className="text-muted-foreground text-xs">
              {getBranchReviewFindingAnchorStatusLabel(classification.status)}
              {classification.reasonLabel
                ? `: ${classification.reasonLabel}`
                : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function InlineCommentComposer({
  selection,
  draft,
  isPending,
  onCancel,
  onChangeDraft,
  onSubmit,
}: Readonly<InlineComposerProps>) {
  return (
    <div
      className={cn(INLINE_REVIEW_CARD_SURFACE_CLASS_NAME, "px-3 py-2.5")}
      data-testid="inline-comment-composer"
    >
      <div className="mb-2 font-medium text-muted-foreground text-xs">
        {inlineComposerLineLabel(selection)}
      </div>
      <Textarea
        aria-label="Inline comment"
        className="min-h-[84px] resize-y bg-background text-sm"
        disabled={isPending}
        onChange={(event) => onChangeDraft(event.target.value)}
        placeholder="Write an inline comment..."
        value={draft}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          disabled={isPending}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button
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

function canUseInlineAnchor(input: {
  canCreateInlineComment: boolean;
  diffData: BranchViewFileDiff | undefined;
  diffError: unknown;
  expectedHeadSha: string | null;
  filePath: string | null;
  isCommitted: boolean;
  isDiffLoading: boolean;
}): boolean {
  return Boolean(
    input.canCreateInlineComment &&
      input.isCommitted &&
      !input.diffData?.isBinary &&
      !input.isDiffLoading &&
      !input.diffError &&
      input.filePath &&
      input.expectedHeadSha
  );
}

function getCurrentFileInlineComments(
  comments: BranchViewComment[],
  path: string
): BranchViewComment[] {
  return comments.filter(
    (comment) =>
      comment.kind === CommentKind.ReviewComment &&
      !isBranchReviewFinding(comment) &&
      comment.path === path &&
      // Roots must carry a side/line anchor to place inline; replies inherit
      // their root's placement and are grouped into its thread.
      (comment.inReplyToId != null ||
        (comment.side != null && comment.line != null))
  );
}

function getSelectedFileReviewFindings(
  comments: BranchViewComment[],
  path: string,
  previousPath: string | null
): BranchReviewFinding[] {
  return comments.flatMap((comment) => {
    const finding = parseBranchReviewFinding(comment);
    if (!finding) {
      return [];
    }
    if (
      comment.path === null ||
      comment.path === path ||
      comment.path === previousPath
    ) {
      return [finding];
    }
    return [];
  });
}

export function BranchDiffView({
  selectedFileId,
  ...props
}: Readonly<BranchDiffViewProps>) {
  return (
    <BranchDiffViewStateful
      key={selectedFileId}
      selectedFileId={selectedFileId}
      {...props}
    />
  );
}

function useSelectedBranchDiff(input: {
  currentEntry: ChangedFileEntry | null;
  externalLinkId: string;
  localDiffContext: BranchDiffViewProps["localDiffContext"];
}) {
  const isCommitted = input.currentEntry?.section === FileSection.Committed;
  const isLocal = input.currentEntry?.section === FileSection.Local;
  const filePath = isCommitted ? (input.currentEntry?.file.path ?? null) : null;
  const previousPath = isCommitted
    ? (input.currentEntry?.file.previousPath ?? undefined)
    : undefined;
  const {
    data: committedDiffData,
    isLoading: isCommittedDiffLoading,
    error: committedDiffError,
  } = useBranchViewFileDiff(input.externalLinkId, filePath, previousPath);
  const localFilePath = isLocal
    ? (input.currentEntry?.file.path ?? null)
    : null;
  const localPreviousPath = isLocal
    ? (input.currentEntry?.file.previousPath ?? null)
    : null;
  const localDiffContext = input.localDiffContext;
  const localDiffQuery = useQuery({
    queryKey: queryKeys.branchLocalFileDiff(
      localDiffContext?.repoFullName ?? "",
      localDiffContext?.headBranch ?? "",
      localDiffContext?.repoPath ?? "",
      localFilePath ?? "",
      localPreviousPath,
      localDiffContext?.routingKey ?? ""
    ),
    queryFn: () => {
      if (!(localDiffContext && localFilePath)) {
        throw new Error(
          "Local diff query requires local context and file path"
        );
      }
      return fetchBranchLocalDiff({
        ...localDiffContext,
        path: localFilePath,
        previousPath: localPreviousPath,
      });
    },
    enabled: Boolean(localDiffContext && localFilePath),
  });

  return {
    diffData: isLocal ? localDiffQuery.data : committedDiffData,
    diffError: isLocal ? localDiffQuery.error : committedDiffError,
    filePath,
    isCommitted,
    isDiffLoading: isLocal ? localDiffQuery.isLoading : isCommittedDiffLoading,
    isLocal,
  };
}

function BranchDiffViewStateful({
  allFiles,
  externalLinkId,
  localDiffContext = null,
  onClose,
  onSelectFile,
  selectedFileId,
  targetActivationId,
  targetLine,
  canCreateInlineComment = false,
  commentPromptEligibility,
  comments = [],
  expectedHeadSha = null,
  branchHeadSha = null,
  producedByPlanSlug = null,
  producedByPlanTitle = null,
}: Readonly<BranchDiffViewProps>) {
  const diffRootRef = useRef<HTMLDivElement | null>(null);
  const [selectedLineHighlightIds, setSelectedLineHighlightIds] = useState<
    string[]
  >([]);
  const [selectedSelection, setSelectedSelection] =
    useState<LineSelection | null>(null);
  const [selectionPivotLine, setSelectionPivotLine] = useState<number | null>(
    null
  );
  const [expandedFindingId, setExpandedFindingId] = useState<string | null>(
    null
  );
  const [pathCopied, copyPath] = useCopyToClipboard();
  const [inlineDraft, setInlineDraft] = useState("");
  const identityPrompts = useBranchViewCommentIdentityBlockers();
  const createInlineMutation = useCreateBranchViewInlineComment(externalLinkId);
  const replyMutation = useReplyToComment(externalLinkId);
  const resolveReviewThreadMutation =
    useResolveBranchViewReviewThread(externalLinkId);
  const unresolveReviewThreadMutation =
    useUnresolveBranchViewReviewThread(externalLinkId);
  const {
    currentEntry,
    hasNext,
    hasPrev,
    nextEntry,
    prevEntry,
    safeIndex,
    total,
  } = getSelectedFileNavigation(allFiles, selectedFileId);

  const { diffData, diffError, filePath, isCommitted, isDiffLoading } =
    useSelectedBranchDiff({
      currentEntry,
      externalLinkId,
      localDiffContext,
    });

  useTargetLineNavigation({
    diffError,
    diffRootRef,
    isBinary: diffData?.isBinary,
    isDiffLoading,
    newContent: diffData?.newContent,
    oldContent: diffData?.oldContent,
    selectedFileId,
    setSelectedLineHighlightIds,
    targetActivationId,
    targetLine: currentEntry ? targetLine : null,
  });

  // Memoize the committed-file list: it is rebuilt every render and scanned
  // (path + previousPath) once per finding inside classifyBranchReviewFindingAnchor.
  const committedFiles = useMemo(
    () =>
      allFiles
        .filter((entry) => entry.section === FileSection.Committed)
        .map((entry) => entry.file),
    [allFiles]
  );

  // Classifying findings re-splits and re-diffs the whole selected file once per
  // finding; memoize so it only recomputes when the findings or file content change.
  const classifiedFindings = useMemo(() => {
    if (!currentEntry) {
      return [] as ClassifiedBranchReviewFinding[];
    }
    const { file } = currentEntry;
    const findings = isCommitted
      ? getSelectedFileReviewFindings(
          comments,
          file.path,
          file.previousPath ?? null
        )
      : [];
    return findings.map((finding) => ({
      classification: classifyBranchReviewFindingAnchor({
        comment: finding.comment,
        committedFiles,
        fileCacheHeadSha: expectedHeadSha,
        headSha: branchHeadSha,
        isDeleted: diffData?.isDeleted ?? false,
        isNew: diffData?.isNew ?? false,
        newContent: diffData?.newContent ?? null,
        oldContent: diffData?.oldContent ?? null,
        selectedFilePath: file.path,
        selectedFileSection: currentEntry.section,
      }),
      finding,
    }));
  }, [
    currentEntry,
    isCommitted,
    comments,
    committedFiles,
    expectedHeadSha,
    branchHeadSha,
    diffData?.isDeleted,
    diffData?.isNew,
    diffData?.newContent,
    diffData?.oldContent,
  ]);

  function clearLineSelection() {
    setSelectedSelection(null);
    setSelectionPivotLine(null);
    setSelectedLineHighlightIds([]);
    setInlineDraft("");
  }

  function canAnchorInlineComment(): boolean {
    return canUseInlineAnchor({
      canCreateInlineComment,
      diffData,
      diffError,
      expectedHeadSha,
      filePath,
      isCommitted,
      isDiffLoading,
    });
  }

  function extendLineSelectionTo(anchor: RenderedDiffLineAnchor): boolean {
    if (
      !(selectedSelection && selectionPivotLine !== null) ||
      selectedSelection.side !== anchor.side
    ) {
      return false;
    }
    // Clamp to the contiguous rendered hunk so a range cannot cross a fold,
    // which GitHub rejects for multi-line comments.
    const rendered = diffRootRef.current
      ? collectRenderedLineNumbers(diffRootRef.current, anchor.side)
      : new Set<number>();
    const { startLine, endLine } = clampRangeToContiguous(
      rendered,
      selectionPivotLine,
      anchor.line
    );
    const range: LineSelection = { endLine, side: anchor.side, startLine };
    setSelectedSelection(range);
    setSelectedLineHighlightIds(rangeLineHighlightIds(range));
    return true;
  }

  function handleSelectRenderedLine(
    lineId: string,
    event: MouseEvent<HTMLTableCellElement>
  ) {
    const anchor = parseRenderedDiffLineAnchor(lineId);
    const canAnchor = canAnchorInlineComment();

    // Shift-click extends the current selection into a multi-line range.
    if (
      event.shiftKey &&
      anchor &&
      canAnchor &&
      extendLineSelectionTo(anchor)
    ) {
      return;
    }

    const row = event.currentTarget.closest("tr");
    const rowHighlightIds =
      row instanceof HTMLTableRowElement
        ? getRenderedSplitRowHighlightIds(row)
        : [];
    const nextHighlightIds =
      rowHighlightIds.length > 0 ? rowHighlightIds : [lineId];

    // Tapping the already-selected line clears the selection (toggle off).
    if (areSameLineSelection(selectedLineHighlightIds, nextHighlightIds)) {
      clearLineSelection();
      return;
    }

    if (canAnchor && anchor) {
      setSelectedSelection({
        side: anchor.side,
        startLine: anchor.line,
        endLine: anchor.line,
      });
      setSelectionPivotLine(anchor.line);
    } else {
      setSelectedSelection(null);
      setSelectionPivotLine(null);
    }
    setSelectedLineHighlightIds(nextHighlightIds);
  }

  async function handleCopyPath() {
    if (!currentEntry) {
      return;
    }
    await copyPath(currentEntry.file.path);
  }

  function submitInlineComment(): void {
    const body = inlineDraft.trim();
    if (!(body && selectedSelection && filePath && expectedHeadSha)) {
      return;
    }
    const isRange = selectedSelection.startLine !== selectedSelection.endLine;
    createInlineMutation.mutate(
      {
        body,
        expectedHeadSha,
        line: selectedSelection.endLine,
        path: filePath,
        side: selectedSelection.side,
        ...(isRange
          ? {
              startLine: selectedSelection.startLine,
              startSide: selectedSelection.side,
            }
          : {}),
      },
      {
        onError: (error) => {
          const identityBlocker = parseBranchViewCommentIdentityBlocker(error);
          if (identityBlocker) {
            identityPrompts.recordIdentityBlocker({
              identityBlocker,
              surface: "createInline",
            });
          }
        },
        onSuccess: (result) => {
          handleBranchViewCommentActionResult(result);
          if (result.success) {
            clearLineSelection();
          }
        },
      }
    );
  }

  function resolveInlineThread(comment: BranchViewComment): void {
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

  function unresolveInlineThread(comment: BranchViewComment): void {
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

  function replyToInlineThread(
    root: BranchViewComment,
    body: string,
    onDone: () => void
  ): void {
    if (!(root.canReply === true && body.trim().length > 0)) {
      return;
    }
    const commentGithubId = getReplyTargetGithubCommentId(root);
    if (commentGithubId === null) {
      return;
    }
    replyMutation.mutate(
      { body: body.trim(), commentGithubId },
      {
        onError: (error) => {
          recordBranchViewCommentIdentityBlocker({
            comment: root,
            error,
            identityPrompts,
            surface: "reply",
          });
        },
        onSuccess: onDone,
      }
    );
  }

  if (!currentEntry) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground text-sm">
        {total > 0
          ? "Selected file is no longer available in this branch."
          : "No file selected"}
      </div>
    );
  }

  const { file } = currentEntry;
  const additions = file.additions ?? 0;
  const deletions = file.deletions ?? 0;
  const inlineComments = isCommitted
    ? getCurrentFileInlineComments(comments, file.path)
    : [];
  const inlineThreads = buildCommentThreads(inlineComments);
  const inlineFindings = classifiedFindings.filter(
    (item) =>
      item.classification.status === BranchReviewFindingAnchorStatus.Current
  );
  const unplacedFindings = classifiedFindings.filter(
    (item) =>
      item.classification.status !== BranchReviewFindingAnchorStatus.Current
  );
  const showInlineComposer =
    selectedSelection !== null &&
    canUseInlineAnchor({
      canCreateInlineComment,
      diffData,
      diffError,
      expectedHeadSha,
      filePath,
      isCommitted,
      isDiffLoading,
    });
  const inlineComposerAnchor: RenderedDiffLineAnchor | null = selectedSelection
    ? { line: selectedSelection.endLine, side: selectedSelection.side }
    : null;
  const inlineComposer =
    showInlineComposer && selectedSelection ? (
      <InlineCommentComposer
        draft={inlineDraft}
        isPending={createInlineMutation.isPending}
        onCancel={clearLineSelection}
        onChangeDraft={setInlineDraft}
        onSubmit={submitInlineComment}
        selection={selectedSelection}
      />
    ) : null;
  const createInlinePrompt = identityPrompts.getCreatePrompt(
    "createInline",
    commentPromptEligibility?.createInline
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Back nav */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-border border-b px-6 py-2.5">
        <Button
          className="bg-transparent dark:bg-transparent"
          onClick={onClose}
          size="sm"
          variant="outline"
        >
          <ChevronLeft className="mr-1.5 h-4 w-4" />
          Back
        </Button>
        <div className="flex items-center gap-1">
          <Button
            aria-label="Previous file"
            className="bg-transparent dark:bg-transparent"
            disabled={!hasPrev}
            onClick={() => prevEntry && onSelectFile(prevEntry.fileId)}
            size="icon-sm"
            variant="outline"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[4rem] text-center font-medium text-muted-foreground text-sm">
            {safeIndex + 1} / {total}
          </span>
          <Button
            aria-label="Next file"
            className="bg-transparent dark:bg-transparent"
            disabled={!hasNext}
            onClick={() => nextEntry && onSelectFile(nextEntry.fileId)}
            size="icon-sm"
            variant="outline"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* File header */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-border border-b px-6 py-2.5">
        <span className="min-w-0 truncate font-mono text-foreground text-sm">
          {file.path}
        </span>
        <Badge variant="secondary">{statusLabel(file.status)}</Badge>
        <div className="flex items-center gap-2 font-mono font-semibold text-sm">
          {additions > 0 ? (
            <span className="text-success">+{additions}</span>
          ) : null}
          {deletions > 0 ? (
            <span className="text-destructive">-{deletions}</span>
          ) : null}
        </div>
        <div className="min-w-0 flex-1" />
        <WhyThisChangePopover
          filePath={file.path}
          planSlug={producedByPlanSlug}
          planTitle={producedByPlanTitle}
        />
        <Button
          className="bg-transparent dark:bg-transparent"
          onClick={handleCopyPath}
          size="sm"
          variant="outline"
        >
          {pathCopied ? "Copied" : "Copy Path"}
        </Button>
      </div>
      {canCreateInlineComment ? null : (
        <BranchCommentWriteIdentityPrompt prompt={createInlinePrompt} />
      )}

      {/* Diff content */}
      <div
        className="min-h-0 flex-1 overflow-hidden border-border"
        ref={diffRootRef}
      >
        <BranchDiffContent
          diffData={diffData}
          diffError={diffError}
          expandedFindingId={expandedFindingId}
          inlineComposer={inlineComposer}
          inlineComposerAnchor={
            showInlineComposer ? inlineComposerAnchor : null
          }
          inlineFindings={inlineFindings}
          inlineThreads={inlineThreads}
          isDiffLoading={isDiffLoading}
          isReplyPending={replyMutation.isPending}
          onReplyInlineThread={replyToInlineThread}
          onResolveInlineThread={resolveInlineThread}
          onSelectRenderedLine={handleSelectRenderedLine}
          onToggleFinding={(findingId) =>
            setExpandedFindingId((current) =>
              current === findingId ? null : findingId
            )
          }
          onUnresolveInlineThread={unresolveInlineThread}
          selectedLineHighlightIds={selectedLineHighlightIds}
          targetLine={targetLine}
          unplacedFindings={unplacedFindings}
        />
      </div>
    </div>
  );
}

function areSameLineSelection(current: string[], next: string[]): boolean {
  return (
    current.length > 0 &&
    current.length === next.length &&
    current.every((id, index) => id === next[index])
  );
}

function inlineComposerLineLabel(selection: LineSelection): string {
  const noun =
    selection.side === GitHubDiffSide.Left ? "original line" : "line";
  if (selection.startLine === selection.endLine) {
    return `Commenting on ${noun} ${selection.endLine}`;
  }
  return `Commenting on ${noun}s ${selection.startLine} to ${selection.endLine}`;
}

/** Highlight ids for every line in a single-side selection range. */
function rangeLineHighlightIds(selection: LineSelection): string[] {
  const makeId =
    selection.side === GitHubDiffSide.Left
      ? getLeftLineHighlightId
      : getRightLineHighlightId;
  const ids: string[] = [];
  for (let line = selection.startLine; line <= selection.endLine; line++) {
    ids.push(makeId(line));
  }
  return ids;
}

type InlineCommentRange = {
  side: GitHubDiffSide;
  startLine: number;
  endLine: number;
};

type LineBracketInfo = { isStart: boolean; isEnd: boolean };

/** Multi-line spans for existing range comments, keyed off their start/end anchors. */
function getInlineCommentRanges(
  threads: CommentThread[]
): InlineCommentRange[] {
  const ranges: InlineCommentRange[] = [];
  for (const { root } of threads) {
    const side = root.startSide ?? root.side;
    if (
      side &&
      root.startLine != null &&
      root.line != null &&
      root.startLine < root.line
    ) {
      ranges.push({ endLine: root.line, side, startLine: root.startLine });
    }
  }
  return ranges;
}

function RangeBracket({ info }: Readonly<{ info: LineBracketInfo }>) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute left-1 w-0.5 bg-primary/50",
        info.isStart ? "top-1.5 rounded-t-full" : "top-0",
        info.isEnd ? "bottom-1.5 rounded-b-full" : "bottom-0"
      )}
      data-testid="inline-comment-range-bracket"
    />
  );
}

const INLINE_REVIEW_CARD_SURFACE_CLASS_NAME =
  "relative z-10 overflow-hidden rounded-md border border-border/80 bg-card text-card-foreground shadow-[0_10px_24px_rgb(15_23_42_/_0.14)] ring-1 ring-background/95 dark:shadow-[0_10px_26px_rgb(0_0_0_/_0.45)]";
