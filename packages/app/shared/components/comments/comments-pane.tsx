"use client";

import { TraceCommentKind } from "@repo/api/src/types/comment";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import type { CollectionCapabilities } from "@repo/api/src/types/comment-capabilities";
import { formatDateTime } from "@repo/app/shared/lib/date-utils";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Label } from "@repo/design-system/components/ui/label";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { MessageSquareIcon, XIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CommentsPaneComposer } from "./comments-pane-composer";
import type {
  CommentsPaneContentProps,
  CommentsPaneProps,
} from "./comments-pane-contract";
import {
  type CommentsPaneFilter,
  CommentsPaneLoadStatus,
  canCreateThread,
  commentsPaneCountLabel,
  commentsPaneFilterLabel,
  commentsPaneFilters,
  commentsScopeAnnouncement,
  isAnchorRevealable,
  isSameAnchor,
  NEW_THREAD_DRAFT_KEY,
  TRACE_COMMENT_SELECTION_GUIDANCE,
  threadInBranchScope,
  threadMatchesFilter,
} from "./comments-pane-model";
import { CommentsPaneThreadCard } from "./comments-pane-thread-card";
import { CommentsRailShell } from "./comments-rail-shell";
import {
  type SubmitWrite,
  usePendingSubmissions,
} from "./use-pending-submissions";

/**
 * The canonical comments pane (ISS-11209): the responsive rail shell around
 * {@link CommentsPaneContent}. Presentational only; the host owns the data,
 * the drafts and every write.
 */
export function CommentsPane({
  availableWidth,
  description,
  layout,
  onOpenChange,
  onWidthChange,
  onWidthCommit,
  open,
  returnFocusRef,
  width,
  ...content
}: Readonly<CommentsPaneProps>) {
  const title = content.title ?? "Comments";
  return (
    <CommentsRailShell
      availableWidth={availableWidth}
      description={description ?? title}
      dismissOnEscape
      hideSheetClose
      keepOpenOnFieldEscape
      label={title}
      layout={layout}
      onClose={() => onOpenChange(false)}
      onWidthChange={onWidthChange}
      onWidthCommit={onWidthCommit}
      open={open}
      returnFocusRef={returnFocusRef}
      width={width}
    >
      <CommentsPaneContent
        {...content}
        onClose={() => {
          onOpenChange(false);
          returnFocusRef?.current?.focus();
        }}
      />
    </CommentsRailShell>
  );
}

export function CommentsPaneContent(props: Readonly<CommentsPaneContentProps>) {
  const {
    activeAnchor,
    anchorStateLabels,
    branchScope,
    capabilities,
    drafts,
    formatTimestamp = formatDateTime,
    loadState,
    notice,
    onClose,
    renderBody,
    revealableAnchorKinds = [],
    selectedThreadId,
    threads,
    title = "Comments",
  } = props;
  const headingId = useId();
  const [chosenFilter, setFilter] = useState<CommentsPaneFilter>("all");
  // The pane is not remounted when the host's capabilities change (Artifact ↔
  // Sessions in the prototype), so a pick the new capabilities no longer offer
  // falls back to "all" instead of silently hiding every thread.
  const filter = commentsPaneFilters(capabilities).includes(chosenFilter)
    ? chosenFilter
    : "all";
  const { isPending, submit } = usePendingSubmissions({
    externalPending: props.pendingDraftKeys,
    identity: props.identity,
    onDraftChange: props.onDraftChange,
    onWriteError: props.onWriteError,
  });
  const threadRefs = useRef(new Map<string, HTMLElement>());
  const scopedThreads = useMemo(
    () => threads.filter((thread) => threadInBranchScope(thread, branchScope)),
    [branchScope, threads]
  );
  const visibleThreads = scopedThreads.filter((thread) =>
    threadMatchesFilter(thread, filter)
  );
  const countLabel = commentsPaneCountLabel(loadState, scopedThreads.length);
  const loading = loadState.status === CommentsPaneLoadStatus.Loading;
  const failed = loadState.status === CommentsPaneLoadStatus.Error;
  const partialAndEmpty =
    loadState.status === CommentsPaneLoadStatus.Partial &&
    scopedThreads.length === 0;
  const coverageNote = notice ?? branchScope?.coverageNote ?? null;
  // An empty partial read is not "no comments": only the note speaks for it.
  const showEmpty =
    !(loading || failed || partialAndEmpty) && visibleThreads.length === 0;

  useEffect(() => {
    if (!selectedThreadId) {
      return;
    }
    threadRefs.current
      .get(selectedThreadId)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selectedThreadId]);

  return (
    <section
      aria-busy={loading}
      aria-labelledby={headingId}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <MessageSquareIcon
          aria-hidden
          className="size-4 text-muted-foreground"
        />
        <h2 className="font-medium text-sm" id={headingId}>
          {title}{" "}
          <span className="font-normal text-muted-foreground">
            {countLabel}
          </span>
        </h2>
        {loading ? (
          <Skeleton aria-hidden className="h-3.5 w-4 rounded-sm" />
        ) : null}
        <FilterMenu
          capabilities={capabilities}
          disabled={loading || failed}
          filter={filter}
          onFilterChange={setFilter}
        />
        {onClose ? (
          <Button
            aria-label="Close comments"
            onClick={onClose}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden />
          </Button>
        ) : null}
      </div>
      {branchScope ? (
        <p aria-live="polite" className="sr-only">
          {commentsScopeAnnouncement(branchScope)}
        </p>
      ) : null}
      {coverageNote ? (
        <p
          className="border-b bg-muted/30 px-4 py-2 text-muted-foreground text-xs"
          role="status"
        >
          {coverageNote}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {failed ? <LoadFailure onRetryLoad={props.onRetryLoad} /> : null}
        {loading ? (
          <p className="text-muted-foreground text-sm" role="status">
            Loading comments…
          </p>
        ) : null}
        {showEmpty ? <EmptyComments /> : null}
        {loading
          ? null
          : visibleThreads.map((thread) => (
              <CommentsPaneThreadCard
                anchorActive={isSameAnchor(thread.anchor, activeAnchor)}
                anchorStateLabels={anchorStateLabels}
                callbacks={props}
                capabilities={
                  props.threadCapabilities?.(thread) ?? capabilities
                }
                drafts={drafts}
                elementRef={(element) => {
                  if (element) {
                    threadRefs.current.set(thread.id, element);
                  } else {
                    threadRefs.current.delete(thread.id);
                  }
                }}
                formatTimestamp={formatTimestamp}
                isPending={isPending}
                key={thread.id}
                renderBody={renderBody}
                renderComposer={props.renderComposer}
                revealable={isAnchorRevealable(thread, revealableAnchorKinds)}
                selected={thread.id === selectedThreadId}
                submit={submit}
                thread={thread}
              />
            ))}
      </div>
      <NewThreadComposer
        {...props}
        disabled={loading || failed}
        isPending={isPending}
        submit={submit}
      />
    </section>
  );
}

function FilterMenu({
  capabilities,
  disabled,
  filter,
  onFilterChange,
}: Readonly<{
  capabilities: CollectionCapabilities;
  disabled: boolean;
  filter: CommentsPaneFilter;
  onFilterChange: (filter: CommentsPaneFilter) => void;
}>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="ml-auto"
          disabled={disabled}
          size="sm"
          type="button"
          variant="ghost"
        >
          {commentsPaneFilterLabel(filter, true)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {commentsPaneFilters(capabilities).map((value) => (
          <DropdownMenuItem key={value} onSelect={() => onFilterChange(value)}>
            {commentsPaneFilterLabel(value)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A failed read is an alert with a way back, never an empty list. */
function LoadFailure({ onRetryLoad }: Readonly<{ onRetryLoad?: () => void }>) {
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md border border-destructive/25 bg-destructive/5 p-3"
      role="alert"
    >
      <p className="text-destructive text-sm">
        Comments are unavailable in this view.
      </p>
      {onRetryLoad ? (
        <Button onClick={onRetryLoad} size="sm" type="button" variant="outline">
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function EmptyComments() {
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/25 p-3">
      <MessageSquareIcon
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <p className="font-medium text-sm">No comments in this view</p>
    </div>
  );
}

function NewThreadComposer({
  capabilities,
  composerPlaceholder,
  composerTarget,
  disabled,
  drafts,
  isPending,
  onCreateThread,
  onDraftChange,
  renderComposer,
  submit,
}: Readonly<
  CommentsPaneContentProps & {
    disabled: boolean;
    isPending: (key: string) => boolean;
    submit: SubmitWrite;
  }
>) {
  const parsingBugId = useId();
  if (!(capabilities.createThread && onCreateThread)) {
    return null;
  }
  if (!canCreateThread(capabilities, composerTarget)) {
    // Only a source that anchors to the trace waits for a selection.
    return capabilities.anchorKinds.includes(CommentAnchorKind.Trace) ? (
      <div className="flex shrink-0 items-start gap-2 border-t p-3 text-muted-foreground text-xs">
        <MessageSquareIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <p>{TRACE_COMMENT_SELECTION_GUIDANCE}</p>
      </div>
    ) : null;
  }
  const draft = drafts[NEW_THREAD_DRAFT_KEY];
  const canFlagParsingBug = capabilities.commentKinds.includes(
    TraceCommentKind.ParsingBug
  );
  const flagged = draft?.kind === TraceCommentKind.ParsingBug;
  return (
    <div className="shrink-0 border-t p-3">
      <CommentsPaneComposer
        ariaLabel={
          composerTarget.label
            ? `Comment on ${composerTarget.label}`
            : "Add a comment"
        }
        disabled={disabled}
        helperText={
          composerTarget.label ? (
            <p className="truncate text-muted-foreground text-xs">
              Commenting on {composerTarget.label}
            </p>
          ) : null
        }
        initialMentions={draft?.mentions}
        isPending={isPending(NEW_THREAD_DRAFT_KEY)}
        leadingActions={
          canFlagParsingBug ? (
            <div className="flex items-center gap-2" data-comment-control>
              <Checkbox
                checked={flagged}
                id={parsingBugId}
                onCheckedChange={(checked) =>
                  onDraftChange(NEW_THREAD_DRAFT_KEY, {
                    ...draft,
                    body: draft?.body ?? "",
                    kind:
                      checked === true
                        ? TraceCommentKind.ParsingBug
                        : TraceCommentKind.Comment,
                  })
                }
              />
              <Label className="cursor-pointer text-sm" htmlFor={parsingBugId}>
                Flag as parsing/data bug
              </Label>
            </div>
          ) : null
        }
        minHeightClassName="min-h-20 max-h-60"
        onSubmit={({ body, mentions }) =>
          submit(NEW_THREAD_DRAFT_KEY, () =>
            onCreateThread({
              anchor: composerTarget.anchor,
              body,
              ...(canFlagParsingBug && flagged
                ? { kind: TraceCommentKind.ParsingBug }
                : {}),
              ...(mentions ? { mentions } : {}),
            })
          )
        }
        onValueChange={(body, mentions) =>
          onDraftChange(NEW_THREAD_DRAFT_KEY, {
            ...draft,
            body,
            ...(mentions ? { mentions } : {}),
          })
        }
        placeholder={composerPlaceholder}
        renderComposer={renderComposer}
        value={draft?.body ?? ""}
      />
    </div>
  );
}
