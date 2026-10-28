"use client";

import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import {
  CommentSurface,
  CommentTargetType,
  ThreadSource,
  TraceCommentKind,
  type TraceTextAnchor,
} from "@repo/api/src/types/comment";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import {
  CapabilityGrant,
  COMMENT_SOURCE_POLICIES,
  type CollectionCapabilities,
  CommentPolicyKey,
} from "@repo/api/src/types/comment-capabilities";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
// The Session trace rail's order, so a Session's comments read the same on
// the Branch timeline.
import { sortByCreatedAtThenId } from "@repo/app/agents/components/detail/comment-sort";
import {
  createArtifactAnchorAdapter,
  createCodeAnchorAdapter,
  createCommentAnchorRegistry,
  createTraceAnchorAdapter,
} from "@repo/app/shared/comments/comment-anchor-adapters";
import type { CommentsDataSource } from "@repo/app/shared/comments/comments-data-source";
import type { ArtifactCommentWrites } from "@repo/app/shared/comments/use-artifact-comment-writes";
import {
  type ArtifactComments,
  NO_COLLECTION_CAPABILITIES,
  useArtifactComments,
  useHttpCommentsDataSource,
} from "@repo/app/shared/comments/use-artifact-comments";
import { CommentsPane } from "@repo/app/shared/components/comments/comments-pane";
import {
  COMMENTS_NARROW_QUERY,
  type CommentsPaneBranchScope,
  CommentsPaneLoadStatus,
  NO_ANCHOR_STATE_LABELS,
} from "@repo/app/shared/components/comments/comments-pane-model";
import { useCommentsPaneDrafts } from "@repo/app/shared/components/comments/use-comments-pane-drafts";
import {
  useCommentsPaneVisibility,
  useCommentsPaneWidth,
  useEndCommentsPaneTransient,
} from "@repo/app/shared/components/comments/use-comments-pane-state";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
// The mention composer reads the organization's members, which the users
// slice owns; the comments channel is addressed by the viewer's organization.
import { renderOrgMentionPaneComposer } from "@repo/app/users/components/org-mention-composer";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import { useMediaQuery } from "@repo/design-system/hooks/use-media-query";
import type { RefObject } from "react";
import { useMemo, useState } from "react";
import { PrCommentMarkdown } from "../pr-comment-markdown";
import {
  BRANCH_COMMENTS_PANE_KEYS,
  type BranchCommentDraftTarget,
  type BranchRenderedSessions,
  branchCommentsScopeForTab,
  DEFAULT_COMMENTS_WIDTH,
} from "./branch-comments-model";
import {
  type BranchSessionComments,
  type BranchSessionCommentsReports,
  BranchSessionCommentsSources,
  useBranchSessionCommentsReports,
} from "./branch-session-comments-sources";
import { useBranchAddressedThread } from "./use-branch-addressed-thread";

type BranchCommentsScope = CommentsPaneBranchScope["tab"];

export type BranchCommentsPaneProps = {
  /** The Branch artifact the unified API addresses; null for a local branch, which has none. */
  branchArtifactId: string | null;
  /** The shell tab on screen: Artifact (Branch details) and Sessions show the pane. */
  activeTab: ArtifactDetailTab;
  selectedPullRequestKey: string | null;
  renderedSessions: BranchRenderedSessions;
  /** The timeline selection a new thread anchors to. */
  composerTarget: BranchCommentDraftTarget | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** The shell's ISS-10795 reveal: the Sessions tab is selected before the jump. */
  selectTabThenReveal: (
    tab: typeof ArtifactDetailTab.Sessions,
    reveal: () => void
  ) => void;
  /** Scrolls the Sessions timeline to the anchor's row. */
  onRevealTraceAnchor: (anchor: TraceTextAnchor) => void;
  /**
   * The thread a `?comment=` link addressed, null while the URL names none
   * (ISS-10980). The pane opens for it and scrolls to it, the same contract
   * `SessionCommentsPane` holds for the Session Activity tab's links.
   */
  addressedThreadId?: string | null;
  /**
   * Selects a pull request on Branch details. An addressed GitHub thread on
   * another pull request is switched to through it, since the pane lists only
   * the selected one's (ISS-10980).
   */
  onSelectPullRequest?: (selection: BranchSelectedPullRequestIdentity) => void;
};

/**
 * PLN-2162 M6.2: Branch comments on the unified API, mounted in the Branch
 * shell's `comments` slot, with decision 5's reads per tab.
 */
export function BranchCommentsPane(props: BranchCommentsPaneProps) {
  const dataSource = useHttpCommentsDataSource();
  const organizationId = useCurrentUser().data?.organizationId;
  return (
    <BranchCommentsPaneContent
      {...props}
      dataSource={dataSource}
      organizationId={organizationId}
    />
  );
}

export function BranchCommentsPaneContent({
  activeTab,
  branchArtifactId,
  composerTarget,
  dataSource,
  onRevealTraceAnchor,
  onSelectPullRequest,
  organizationId,
  renderedSessions,
  returnFocusRef,
  addressedThreadId,
  selectTabThenReveal,
  selectedPullRequestKey,
}: BranchCommentsPaneProps & {
  dataSource: CommentsDataSource;
  organizationId: string | null | undefined;
}) {
  const visibleScope = branchCommentsScopeForTab(activeTab);
  // Off the two tabs the pane stays on the last one's collection, so a visit
  // to Details neither drops it nor reads another.
  const [scope, setScope] = useState<BranchCommentsScope>(
    visibleScope ?? "details"
  );
  if (visibleScope && visibleScope !== scope) {
    setScope(visibleScope);
  }
  const keys = BRANCH_COMMENTS_PANE_KEYS[scope];
  const { hideTransiently, open, setOpen, showTransiently } =
    useCommentsPaneVisibility(keys.open);
  useEndCommentsPaneTransient(keys.open, branchArtifactId);
  const { commitWidth, setLiveWidth, width } = useCommentsPaneWidth(
    keys.width,
    DEFAULT_COMMENTS_WIDTH
  );
  const branch = useArtifactComments(
    {
      id: branchArtifactId ?? "",
      ...(scope === "sessions"
        ? { surface: CommentSurface.BranchTimeline }
        : {}),
    },
    // A closed pane reads nothing, like the legacy rail.
    { dataSource, organizationId, enabled: branchArtifactId !== null && open }
  );
  const [sessionReports, reportSession] = useBranchSessionCommentsReports();
  const sessionIds =
    open && scope === "sessions" ? renderedSessions.sessionIds : NO_SESSION_IDS;
  const detailsDrafts = useCommentsPaneDrafts(`${branchArtifactId}:details`);
  const sessionsDrafts = useCommentsPaneDrafts(`${branchArtifactId}:sessions`);
  const { drafts, onDraftChange } =
    scope === "sessions" ? sessionsDrafts : detailsDrafts;
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const narrow = useMediaQuery(COMMENTS_NARROW_QUERY);
  const composerTrace =
    scope === "sessions" ? (composerTarget?.anchor.trace ?? null) : null;
  const registry = useMemo(
    () =>
      createCommentAnchorRegistry([
        createArtifactAnchorAdapter(),
        createCodeAnchorAdapter(),
        createTraceAnchorAdapter({
          captureSelection: () => composerTrace,
          jumpToRow: (_row, anchor) =>
            selectTabThenReveal(ArtifactDetailTab.Sessions, () =>
              onRevealTraceAnchor(anchor)
            ),
        }),
      ]),
    [composerTrace, onRevealTraceAnchor, selectTabThenReveal]
  );
  const sessions = sessionIds.flatMap((sessionId) => {
    const comments = sessionReports.get(sessionId);
    return comments ? [{ sessionId, comments }] : [];
  });
  const merged = mergeBranchComments({
    branch,
    hasArtifact: branchArtifactId !== null,
    scope,
    sessionCount: sessionIds.length,
    sessions: sessions.map(({ comments }) => comments),
  });
  const branchScope: CommentsPaneBranchScope = {
    coverageNote: scope === "sessions" ? renderedSessions.coverageNote : null,
    renderedSessionIds: sessionIds,
    selectedPullRequestKey,
    tab: scope,
  };
  useBranchAddressedThread({
    addressedThreadId,
    branchScope,
    onReveal: showTransiently,
    onSelect: setSelectedThreadId,
    onSelectPullRequest,
    open,
    scoped: visibleScope !== null,
    threads: merged.threads,
  });
  const writes = routeBranchWrites({
    branch,
    composerTarget,
    scope,
    sessionReports,
    sessions: sessions.map(({ comments }) => comments),
  });
  const composerAnchor = registry.capture(CommentAnchorKind.Trace);
  const capabilities = branch.capabilities ?? NO_COLLECTION_CAPABILITIES;
  const githubThreadIds = new Set(
    merged.threads.flatMap((thread) =>
      thread.source === ThreadSource.Github ? [thread.id] : []
    )
  );

  return (
    <>
      <BranchSessionCommentsSources
        dataSource={dataSource}
        onReport={reportSession}
        organizationId={organizationId}
        reports={sessionReports}
        sessionIds={sessionIds}
      />
      {visibleScope ? (
        <CommentsPane
          anchorStateLabels={NO_ANCHOR_STATE_LABELS}
          branchScope={branchScope}
          capabilities={capabilities}
          composerTarget={
            composerAnchor && composerTarget
              ? { anchor: composerAnchor, label: composerTarget.anchor.label }
              : null
          }
          drafts={drafts}
          identity={`${branchArtifactId}:${scope}`}
          loadState={{ status: merged.status }}
          onDraftChange={onDraftChange}
          onOpenChange={setOpen}
          {...writes}
          {...(branchArtifactId === null
            ? {}
            : {
                onRetryLoad: () => {
                  branch.onRetryLoad();
                  for (const { comments } of sessions) {
                    comments.retry();
                  }
                },
              })}
          onRevealAnchor={(thread) => {
            setSelectedThreadId(thread.id);
            // The narrow pane is a Sheet over the timeline; it steps aside.
            if (registry.reveal(thread) && narrow) {
              hideTransiently();
            }
          }}
          onSelectThread={setSelectedThreadId}
          onWidthChange={setLiveWidth}
          onWidthCommit={commitWidth}
          open={open}
          pendingDraftKeys={merged.pendingDraftKeys}
          // The legacy rail's GitHub bodies: links and fenced code render.
          renderBody={(body, comment) =>
            githubThreadIds.has(comment.threadId) ? (
              <PrCommentMarkdown className="text-sm" text={body} />
            ) : (
              body
            )
          }
          renderComposer={renderOrgMentionPaneComposer}
          returnFocusRef={returnFocusRef}
          revealableAnchorKinds={registry.revealableAnchorKinds}
          selectedThreadId={selectedThreadId}
          threadCapabilities={(thread) => {
            if (thread.source === ThreadSource.Github) {
              return GITHUB_THREAD_CAPABILITIES;
            }
            // A rendered Session's thread answers to native_session, which
            // grants resolve and reopen where native_branch does not.
            const session = sessions.find(({ comments }) =>
              comments.threads.some(({ id }) => id === thread.id)
            );
            return session?.comments.capabilities ?? capabilities;
          }}
          threads={merged.threads}
          width={width}
        />
      ) : null}
    </>
  );
}

const NO_SESSION_IDS: readonly string[] = [];

/**
 * The list read names only the native policy's capabilities; its GitHub
 * threads answer to `github_branch`, which it applies to their permissions
 * alone. A mirrored grant is the provider's own state, which no viewer writes,
 * as the server decides it.
 */
const GITHUB_THREAD_CAPABILITIES = policyCapabilities(
  CommentPolicyKey.GithubBranch
);

function policyCapabilities(
  policyKey: CommentPolicyKey
): CollectionCapabilities {
  const policy = COMMENT_SOURCE_POLICIES[policyKey];
  const granted = (grant: CapabilityGrant) =>
    grant !== CapabilityGrant.None &&
    grant !== CapabilityGrant.Mirrored &&
    grant !== CapabilityGrant.Staff;
  const can = policy.capabilities;
  return {
    anchorKinds: policy.anchorKinds,
    attach: granted(can.attach),
    commentKinds: Object.values(TraceCommentKind).filter((kind) =>
      granted(policy.commentKinds[kind])
    ),
    createThread: granted(can.createThread),
    delete: granted(can.delete),
    edit: granted(can.edit),
    linkOut: granted(can.linkOut),
    mention: granted(can.mention),
    react: granted(can.react),
    reopen: granted(can.reopen),
    reply: granted(can.reply),
    resolve: granted(can.resolve),
    retrySync: granted(can.retrySync),
  };
}

/**
 * Decision 5's list for one tab. Branch details: GitHub threads plus the
 * native threads written there. Sessions: the timeline's own threads plus
 * every rendered Session's, oldest first. The list is partial while a
 * Session's read is out or failed, never empty for it: once every read has
 * landed, a failed one with nothing to show is the pane's failed read.
 */
export function mergeBranchComments({
  branch,
  hasArtifact,
  scope,
  sessionCount,
  sessions,
}: {
  branch: Pick<ArtifactComments, "loadState" | "pendingDraftKeys" | "threads">;
  hasArtifact: boolean;
  scope: BranchCommentsScope;
  sessionCount: number;
  sessions: readonly BranchSessionComments[];
}): {
  pendingDraftKeys: readonly string[];
  status: CommentsPaneLoadStatus;
  threads: readonly CommentThreadDto[];
} {
  if (!hasArtifact) {
    return {
      pendingDraftKeys: [],
      status: CommentsPaneLoadStatus.Error,
      threads: [],
    };
  }
  const pendingDraftKeys = [
    ...new Set([
      ...branch.pendingDraftKeys,
      ...sessions.flatMap((session) => session.pendingDraftKeys),
    ]),
  ];
  if (scope === "details") {
    return {
      pendingDraftKeys,
      status: branch.loadState.status,
      threads: branch.threads.filter(
        (thread) =>
          thread.source === ThreadSource.Github ||
          thread.surface === CommentSurface.BranchDetail
      ),
    };
  }
  const byId = new Map<string, CommentThreadDto>();
  for (const thread of [
    ...branch.threads,
    ...sessions.flatMap((session) => session.threads),
  ]) {
    byId.set(thread.id, thread);
  }
  const threads = sortByCreatedAtThenId([...byId.values()]);
  return {
    pendingDraftKeys,
    status: sessionsScopeStatus(
      branch.loadState.status,
      sessionCount,
      sessions,
      threads.length
    ),
    threads,
  };
}

function sessionsScopeStatus(
  branchStatus: CommentsPaneLoadStatus,
  sessionCount: number,
  sessions: readonly BranchSessionComments[],
  threadCount: number
): CommentsPaneLoadStatus {
  if (branchStatus !== CommentsPaneLoadStatus.Ready) {
    return branchStatus;
  }
  const allReported = sessions.length === sessionCount;
  if (
    allReported &&
    sessions.every((session) => session.status === CommentsPaneLoadStatus.Ready)
  ) {
    return CommentsPaneLoadStatus.Ready;
  }
  const settled =
    allReported &&
    sessions.every(
      (session) =>
        session.status === CommentsPaneLoadStatus.Ready ||
        session.status === CommentsPaneLoadStatus.Error
    );
  return settled && threadCount === 0
    ? CommentsPaneLoadStatus.Error
    : CommentsPaneLoadStatus.Partial;
}

/**
 * Each write goes to the collection that holds its thread. A new thread goes
 * where the timeline selection says: a rendered Session's own artifact, or the
 * Branch timeline.
 */
function routeBranchWrites({
  branch,
  composerTarget,
  scope,
  sessionReports,
  sessions,
}: {
  branch: ArtifactComments;
  composerTarget: BranchCommentDraftTarget | null;
  scope: BranchCommentsScope;
  sessionReports: BranchSessionCommentsReports;
  sessions: readonly BranchSessionComments[];
}): ArtifactCommentWrites {
  const owners = [
    { threads: branch.threads, writes: branch },
    ...sessions.map((session) => ({
      threads: session.threads,
      writes: session.writes,
    })),
  ];
  const byThread = (threadId: string): ArtifactCommentWrites =>
    owners.find((owner) =>
      owner.threads.some((thread) => thread.id === threadId)
    )?.writes ?? branch;
  const byComment = (commentId: string): ArtifactCommentWrites =>
    owners.find((owner) =>
      owner.threads.some((thread) =>
        thread.comments.some((comment) => comment.id === commentId)
      )
    )?.writes ?? branch;
  const sessionTarget =
    scope === "sessions" &&
    composerTarget?.target.type === CommentTargetType.Session
      ? sessionReports.get(composerTarget.target.id)?.writes
      : undefined;
  return {
    onCreateThread: (input) => (sessionTarget ?? branch).onCreateThread(input),
    onDelete: (target) => byThread(target.threadId).onDelete(target),
    onEdit: (commentId, input) => byComment(commentId).onEdit(commentId, input),
    onReopen: (threadId) => byThread(threadId).onReopen(threadId),
    onReply: (threadId, input) => byThread(threadId).onReply(threadId, input),
    onResolve: (threadId) => byThread(threadId).onResolve(threadId),
    onRetrySync: (threadId) => byThread(threadId).onRetrySync(threadId),
  };
}
