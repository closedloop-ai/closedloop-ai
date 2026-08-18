"use client";

import { BranchCommentsState } from "@repo/api/src/types/branch";
import {
  type BranchTraceCommentCollectionQuery,
  TraceCommentSurface,
  type TraceCommentTarget,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import { MessageSquareIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useMemo, useRef, useState } from "react";
import {
  BranchCommentCard,
  BranchCommentComposerKind,
  type BranchCommentComposerMode,
} from "./branch-comment-card";
import {
  type BranchCommentAnchor,
  BranchCommentSource,
  BranchCommentsTab,
  type BranchCommentsWorkspaceProps,
  type BranchCommentThread,
} from "./branch-comments-model";
import { BranchCommentsRail } from "./branch-comments-rail";
import { BranchProviderAvailability } from "./branch-provider-availability";

/**
 * Shared Branch-owned comments workspace for web and Desktop. It owns only
 * page-lifetime presentation state; comment reads and native persistence stay
 * behind injected callbacks, and provider comments are always view-only.
 */
export function BranchCommentsWorkspace({
  activeTab,
  branchId,
  comments,
  composerTarget,
  coverageNote,
  hasError = false,
  isLoading = false,
  onClose,
  onCreate,
  onDeleteReply,
  onDeleteThread,
  onEditRoot,
  onJump,
  onReply,
  onWidthChange,
  open,
  providerAvailability,
  railId,
  renderBody,
  renderedSessionIds,
  returnFocusRef,
  selectedPullRequestKey,
  width,
}: Readonly<BranchCommentsWorkspaceProps>) {
  const generatedId = useId();
  const resolvedRailId = railId ?? `branch-comments-${generatedId}`;
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  const [composerModes, setComposerModes] = useState<
    ReadonlyMap<string, BranchCommentComposerMode>
  >(() => new Map());
  const [pendingDrafts, setPendingDrafts] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [draftBranchId, setDraftBranchId] = useState(branchId);
  const currentBranchIdRef = useRef(branchId);
  const branchGenerationRef = useRef(0);
  currentBranchIdRef.current = branchId;
  if (branchId !== draftBranchId) {
    branchGenerationRef.current += 1;
    setDraftBranchId(branchId);
    setDrafts(new Map());
    setComposerModes(new Map());
    setPendingDrafts(new Set());
  }
  const renderedSessionSet = useMemo(
    () => new Set(renderedSessionIds),
    [renderedSessionIds]
  );
  const visibleComments = useMemo(
    () =>
      comments.filter((comment) =>
        isCommentInScope({
          activeTab,
          branchId,
          comment,
          renderedSessionIds: renderedSessionSet,
          selectedPullRequestKey,
        })
      ),
    [activeTab, branchId, comments, renderedSessionSet, selectedPullRequestKey]
  );
  const composerTargetInScope = composerTarget
    ? isDraftTargetInScope({
        activeTab,
        branchId,
        composerTarget,
        renderedSessionIds: renderedSessionSet,
      })
    : false;
  const rootDraftKey =
    composerTarget && composerTargetInScope
      ? draftKey(
          activeTab,
          composerTarget.target,
          composerTarget.collectionQuery,
          composerTarget.anchor,
          "root"
        )
      : null;
  const scopeAnnouncement = makeScopeAnnouncement(
    activeTab,
    selectedPullRequestKey,
    renderedSessionIds.length
  );
  const commentsHeading =
    activeTab === BranchCommentsTab.Details
      ? "PR Comments"
      : "Session Comments";
  const commentsCount =
    activeTab === BranchCommentsTab.Details
      ? visibleComments.reduce(
          (count, comment) =>
            comment.source === BranchCommentSource.Provider
              ? count + 1 + comment.replies.length
              : count,
          0
        )
      : visibleComments.length;
  const commentsCountLabel = makeCommentsCountLabel({
    count: commentsCount,
    hasError,
    incomplete: Boolean(
      coverageNote || hasIncompleteProviderCoverage(providerAvailability)
    ),
    isLoading,
  });

  const updateDraft = (key: string, value: string) => {
    setDrafts((current) => mapWith(current, key, value));
  };

  const clearDraftAfter = (
    key: string,
    operation: Promise<void> | void,
    onSuccess?: () => void
  ) => {
    const operationBranchId = branchId;
    const operationGeneration = branchGenerationRef.current;
    setPendingDrafts((current) => setWith(current, key));
    Promise.resolve(operation).then(
      () => {
        if (
          currentBranchIdRef.current !== operationBranchId ||
          branchGenerationRef.current !== operationGeneration
        ) {
          return;
        }
        setDrafts((current) => mapWithout(current, key));
        setPendingDrafts((current) => setWithout(current, key));
        onSuccess?.();
      },
      () => {
        if (
          currentBranchIdRef.current === operationBranchId &&
          branchGenerationRef.current === operationGeneration
        ) {
          setPendingDrafts((current) => setWithout(current, key));
        }
      }
    );
  };

  let commentsContent: ReactNode;
  if (isLoading && visibleComments.length === 0) {
    commentsContent = (
      <p className="p-3 text-muted-foreground text-sm" role="status">
        Loading comments…
      </p>
    );
  } else if (hasError && visibleComments.length === 0) {
    commentsContent = (
      <p className="p-3 text-destructive text-sm" role="alert">
        Comments are unavailable in this view.
      </p>
    );
  } else if (visibleComments.length === 0) {
    commentsContent = <EmptyComments activeTab={activeTab} />;
  } else {
    commentsContent = (
      <div className="flex flex-col gap-3">
        {visibleComments.map((thread) => {
          const scopeKey = threadScopeKey(thread);
          const mode = composerModes.get(scopeKey);
          return (
            <BranchCommentCard
              canEditRoot={Boolean(onEditRoot)}
              canReply={Boolean(onReply)}
              draftFor={(kind) => drafts.get(threadDraftKey(thread, kind))}
              isPending={(kind) =>
                pendingDrafts.has(threadDraftKey(thread, kind))
              }
              key={thread.id}
              mode={mode}
              onCancelComposer={() =>
                setComposerModes((current) => mapWithout(current, scopeKey))
              }
              onDeleteReply={onDeleteReply}
              onDeleteThread={onDeleteThread}
              onJump={onJump}
              onOpenComposer={(nextMode) =>
                setComposerModes((current) =>
                  mapWith(current, scopeKey, nextMode)
                )
              }
              onSubmitComposer={(kind, body) => {
                const key = threadDraftKey(thread, kind);
                const operation =
                  kind === BranchCommentComposerKind.Edit
                    ? onEditRoot?.(
                        thread.id,
                        thread.target,
                        thread.collectionQuery,
                        body
                      )
                    : onReply?.(
                        thread.id,
                        thread.target,
                        thread.collectionQuery,
                        body
                      );
                clearDraftAfter(key, operation, () =>
                  setComposerModes((current) => mapWithout(current, scopeKey))
                );
              }}
              onUpdateDraft={(kind, value) =>
                updateDraft(threadDraftKey(thread, kind), value)
              }
              renderBody={renderBody}
              thread={thread}
            />
          );
        })}
      </div>
    );
  }

  return (
    <BranchCommentsRail
      activeTab={activeTab}
      onClose={onClose}
      onWidthChange={onWidthChange}
      open={open}
      returnFocusRef={returnFocusRef}
      width={width}
    >
      <section
        aria-label="Branch comments"
        className="flex min-h-0 flex-1 flex-col"
        id={resolvedRailId}
      >
        <div className="flex h-11 shrink-0 items-center border-b px-3">
          <h2 className="font-semibold text-sm">
            {commentsHeading}{" "}
            <span className="font-normal text-muted-foreground">
              {commentsCountLabel}
            </span>
          </h2>
        </div>
        <p aria-live="polite" className="sr-only">
          {scopeAnnouncement}
        </p>
        {coverageNote ? (
          <p className="border-b bg-muted/30 px-4 py-2 text-muted-foreground text-xs">
            {coverageNote}
          </p>
        ) : null}
        {providerAvailability ? (
          <BranchProviderAvailability availability={providerAvailability} />
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {commentsContent}
        </div>
        <div className="shrink-0 border-t p-3">
          {composerTarget && rootDraftKey && onCreate ? (
            <CommentComposer
              ariaLabel={`Comment on ${composerTarget.anchor.label}`}
              clearOnSubmit={false}
              helperText={
                <p className="truncate text-muted-foreground text-xs">
                  Commenting on {composerTarget.anchor.label}
                </p>
              }
              isPending={pendingDrafts.has(rootDraftKey)}
              minHeightClassName="min-h-20"
              onSubmit={(body) =>
                clearDraftAfter(
                  rootDraftKey,
                  onCreate({
                    anchor: composerTarget.anchor,
                    body,
                    collectionQuery: composerTarget.collectionQuery,
                    tab: activeTab,
                    target: composerTarget.target,
                  })
                )
              }
              onValueChange={(value) => updateDraft(rootDraftKey, value)}
              placeholder="Add a trace comment..."
              value={drafts.get(rootDraftKey) ?? ""}
            />
          ) : (
            <div className="flex items-start gap-2 text-muted-foreground text-xs">
              <MessageSquareIcon
                aria-hidden
                className="mt-0.5 size-4 shrink-0"
              />
              <p>Select an eligible trace row or range to add a comment.</p>
            </div>
          )}
        </div>
      </section>
    </BranchCommentsRail>
  );
}

function EmptyComments({
  activeTab,
}: Readonly<{ activeTab: BranchCommentsTab }>) {
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/25 p-3">
      <MessageSquareIcon
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div>
        <p className="font-medium text-sm">No comments in this view</p>
        <p className="mt-0.5 text-muted-foreground text-xs">
          {activeTab === BranchCommentsTab.Details
            ? "Branch comments and selected pull request comments appear here."
            : "Timeline comments and comments from rendered Sessions appear here."}
        </p>
      </div>
    </div>
  );
}

function isCommentInScope({
  activeTab,
  branchId,
  comment,
  renderedSessionIds,
  selectedPullRequestKey,
}: {
  activeTab: BranchCommentsTab;
  branchId: string;
  comment: BranchCommentThread;
  renderedSessionIds: ReadonlySet<string>;
  selectedPullRequestKey?: string | null;
}): boolean {
  if (comment.tab !== activeTab) {
    return false;
  }
  if (comment.source === BranchCommentSource.Provider) {
    return (
      activeTab === BranchCommentsTab.Details &&
      Boolean(selectedPullRequestKey) &&
      comment.pullRequestKey === selectedPullRequestKey
    );
  }
  if (comment.target.type === TraceCommentTargetType.Branch) {
    const surface =
      comment.collectionQuery?.surface ?? TraceCommentSurface.BranchDetail;
    const expectedSurface =
      activeTab === BranchCommentsTab.Details
        ? TraceCommentSurface.BranchDetail
        : TraceCommentSurface.BranchTimeline;
    return comment.target.id === branchId && surface === expectedSurface;
  }
  return (
    activeTab === BranchCommentsTab.Sessions &&
    renderedSessionIds.has(comment.target.id)
  );
}

function isDraftTargetInScope({
  activeTab,
  branchId,
  composerTarget,
  renderedSessionIds,
}: {
  activeTab: BranchCommentsTab;
  branchId: string;
  composerTarget: NonNullable<BranchCommentsWorkspaceProps["composerTarget"]>;
  renderedSessionIds: ReadonlySet<string>;
}): boolean {
  if (composerTarget.target.type === TraceCommentTargetType.Session) {
    return (
      activeTab === BranchCommentsTab.Sessions &&
      renderedSessionIds.has(composerTarget.target.id)
    );
  }
  if (composerTarget.target.id !== branchId) {
    return false;
  }
  const surface =
    composerTarget.collectionQuery?.surface ?? TraceCommentSurface.BranchDetail;
  return activeTab === BranchCommentsTab.Details
    ? surface === TraceCommentSurface.BranchDetail
    : surface === TraceCommentSurface.BranchTimeline;
}

function draftKey(
  tab: BranchCommentsTab,
  target: TraceCommentTarget,
  collectionQuery: BranchTraceCommentCollectionQuery | undefined,
  anchor: BranchCommentAnchor | null | undefined,
  purpose: string
): string {
  return [
    tab,
    collectionQuery?.surface ??
      (target.type === TraceCommentTargetType.Session
        ? TraceCommentSurface.SessionDetail
        : TraceCommentSurface.BranchDetail),
    target.type,
    target.id,
    anchor?.id ?? "unanchored",
    purpose,
  ].join(":");
}

function threadDraftKey(
  thread: BranchCommentThread,
  kind: BranchCommentComposerKind
): string {
  return draftKey(
    thread.tab,
    thread.target,
    thread.collectionQuery,
    thread.anchor,
    `${kind}:${thread.id}`
  );
}

function threadScopeKey(thread: BranchCommentThread): string {
  return draftKey(
    thread.tab,
    thread.target,
    thread.collectionQuery,
    thread.anchor,
    `mode:${thread.id}`
  );
}

function makeScopeAnnouncement(
  tab: BranchCommentsTab,
  selectedPullRequestKey: string | null | undefined,
  renderedSessionCount: number
): string {
  if (tab === BranchCommentsTab.Details) {
    return selectedPullRequestKey
      ? `Comments updated for Branch details and pull request ${selectedPullRequestKey}.`
      : "Comments updated for Branch details. No pull request is selected.";
  }
  return `Comments updated for Sessions and timeline. ${renderedSessionCount} rendered Sessions included.`;
}

function makeCommentsCountLabel({
  count,
  hasError,
  incomplete,
  isLoading,
}: {
  count: number;
  hasError: boolean;
  incomplete: boolean;
  isLoading: boolean;
}): string | number {
  if (isLoading || hasError) {
    return "Unavailable";
  }
  return incomplete ? `${count} shown` : count;
}

function hasIncompleteProviderCoverage(
  availability: BranchCommentsWorkspaceProps["providerAvailability"]
): boolean {
  return Boolean(
    availability &&
      (availability.stale ||
        availability.state === BranchCommentsState.StaleMixed ||
        availability.state === BranchCommentsState.OverLimitTruncated ||
        availability.mixedProjection ||
        availability.providerTruncated ||
        availability.responseTruncated ||
        availability.omittedComments > 0 ||
        availability.bodyTruncatedCount > 0)
  );
}

function mapWith<K, V>(
  current: ReadonlyMap<K, V>,
  key: K,
  value: V
): ReadonlyMap<K, V> {
  const next = new Map(current);
  next.set(key, value);
  return next;
}

function mapWithout<K, V>(
  current: ReadonlyMap<K, V>,
  key: K
): ReadonlyMap<K, V> {
  const next = new Map(current);
  next.delete(key);
  return next;
}

function setWith<T>(current: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(current);
  next.add(value);
  return next;
}

function setWithout<T>(current: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(current);
  next.delete(value);
  return next;
}
