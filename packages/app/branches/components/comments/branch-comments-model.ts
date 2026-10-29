import type {
  BranchCommentsState,
  BranchPrCommentKind,
} from "@repo/api/src/types/branch";
import {
  type BranchTraceCommentCollectionQuery,
  ThreadSource,
  type TraceCommentTarget,
  type TraceTextAnchor,
} from "@repo/api/src/types/comment";
import {
  CommentsPaneOpenKey,
  CommentsPaneWidthKey,
} from "@repo/app/shared/components/comments/use-comments-pane-state";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { formatRelativeTimeOrFallback } from "@repo/app/shared/lib/date-utils";
/*
  BranchTraceCommentCollectionQuery,
  TraceCommentTarget,
  TraceTextAnchor,
*/
import type { ReactNode, RefObject } from "react";

export const BranchCommentsTab = {
  Details: "details",
  Sessions: "sessions",
} as const;

export type BranchCommentsTab =
  (typeof BranchCommentsTab)[keyof typeof BranchCommentsTab];

export const BranchCommentSource = {
  Platform: ThreadSource.Native,
  Provider: ThreadSource.Github,
} as const;

export type BranchCommentSource =
  (typeof BranchCommentSource)[keyof typeof BranchCommentSource];

export type BranchCommentAnchor = {
  id: string;
  label: string;
  trace: TraceTextAnchor;
};

export type BranchCommentAuthor = {
  avatarUrl?: string | null;
  id: string;
  name: string;
};

export type BranchCommentReply = {
  author: BranchCommentAuthor;
  body: string;
  canDelete: boolean;
  createdAtLabel: string;
  id: string;
  provider?: BranchProviderCommentProvenance | null;
};

/** Presentation-safe GitHub evidence carried by provider roots and replies. */
export type BranchProviderCommentProvenance = {
  bodyTruncated: boolean;
  inReplyToId: string | null;
  kind: BranchPrCommentKind;
  line: number | null;
  login: string;
  path: string | null;
  providerUrl: string | null;
  resolved: boolean | null;
  stale: boolean;
  threadId: string | null;
};

/** Independent bounded-availability facts for the selected provider result. */
export type BranchProviderCommentsAvailability = {
  bodyTruncatedCount: number;
  mixedProjection: boolean;
  omittedComments: number;
  providerTruncated: boolean;
  responseTruncated: boolean;
  stale: boolean;
  state: BranchCommentsState;
};

type BranchCommentThreadBase = {
  anchor?: BranchCommentAnchor | null;
  author: BranchCommentAuthor;
  body: string;
  canDeleteThread: boolean;
  canEditRoot: boolean;
  canReply: boolean;
  createdAtLabel: string;
  id: string;
  provider?: BranchProviderCommentProvenance | null;
  pullRequestKey?: string | null;
  replies: readonly BranchCommentReply[];
  source: BranchCommentSource;
  /**
   * ISS-10383: whether THIS row's source can re-pend it — per COLLECTION, not per
   * source, so it is resolved once where the source lives. A surface asking only
   * whether `retrySync` exists renders a door that throws on a Branch-timeline
   * row.
   */
  canRetrySync?: boolean;
  /**
   * ISS-10383: this comment's cloud delivery was permanently rejected. Only the
   * flag-gated terminal write sets it, so its presence IS the gate and this
   * surface reads no key (ISS-8597, ruling 2026-09-16). Absent and `false` both
   * mean "not abandoned" — `packages/api/src/types/comment.ts` forbids a third
   * "unknown" reading.
   */
  syncAbandoned?: boolean;
  tab: BranchCommentsTab;
};

type BranchCommentRouting = {
  collectionQuery?: BranchTraceCommentCollectionQuery;
  target: TraceCommentTarget;
};

export type BranchCommentThread = BranchCommentThreadBase &
  BranchCommentRouting;

export type BranchCommentDraftTarget = BranchCommentRouting & {
  anchor: BranchCommentAnchor;
};

/** Integration contract for the shared Branch comments workspace. */
export type BranchCommentsWorkspaceProps = {
  activeTab: BranchCommentsTab;
  branchId: string;
  comments: readonly BranchCommentThread[];
  composerTarget?: BranchCommentDraftTarget | null;
  coverageNote?: string | null;
  hasError?: boolean;
  isLoading?: boolean;
  /**
   * ISS-12597: the Branch comment read failed outright (not a partial or
   * GitHub-only failure). With nothing visible, the rail then names the read
   * failure and withholds creation.
   */
  readFailed?: boolean;
  onClose: () => void;
  onCreate?: (input: {
    anchor: BranchCommentAnchor;
    body: string;
    collectionQuery?: BranchTraceCommentCollectionQuery;
    tab: BranchCommentsTab;
    target: TraceCommentTarget;
  }) => Promise<void> | void;
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
  onEditRoot?: (
    threadId: string,
    target: TraceCommentTarget,
    collectionQuery: BranchTraceCommentCollectionQuery | undefined,
    body: string
  ) => Promise<void> | void;
  onJump?: (anchor: BranchCommentAnchor, target: TraceCommentTarget) => void;
  onReply?: (
    threadId: string,
    target: TraceCommentTarget,
    collectionQuery: BranchTraceCommentCollectionQuery | undefined,
    body: string
  ) => Promise<void> | void;
  /** ISS-10383: re-pend a comment this surface's source dead-lettered. */
  onRetrySync?: (
    threadId: string,
    target: TraceCommentTarget,
    collectionQuery?: BranchTraceCommentCollectionQuery
  ) => Promise<void> | void;
  onWidthChange: (width: number) => void;
  open: boolean;
  providerAvailability?: BranchProviderCommentsAvailability | null;
  railId?: string;
  renderBody?: (body: string, thread: BranchCommentThread) => ReactNode;
  renderedSessionIds: readonly string[];
  returnFocusRef: RefObject<HTMLElement | null>;
  selectedPullRequestKey?: string | null;
  width: number;
};

/**
 * The timestamp label for a branch comment, native or provider-mirrored.
 *
 * Both readers render the same rail, so the fallback wording is part of that
 * rail's contract rather than either module's private business — it had been
 * declared identically in both, one edit away from the two halves of one list
 * disagreeing about what a missing timestamp is called.
 */
export function formatBranchCommentTime(value: string): string {
  return formatRelativeTimeOrFallback(value, { fallback: "Unknown time" });
}

/**
 * What the comments rail can truthfully claim about the read behind it. The
 * heading's count slot and the panel body below it both switch on this one
 * value, so they cannot state different things about the same read (ISS-7370).
 */
export const BranchCommentsPanelState = {
  Error: "error",
  Loading: "loading",
  Ready: "ready",
} as const;

export type BranchCommentsPanelState =
  (typeof BranchCommentsPanelState)[keyof typeof BranchCommentsPanelState];

/**
 * A read still in flight is `Loading`, never `Error`: an in-flight read has not
 * failed, and announcing failure over a panel that is about to paint trains
 * readers to stop waiting. Comments already on screen outrank both flags —
 * whatever a background refresh is doing, the rail is showing real content.
 */
export function resolveBranchCommentsPanelState({
  hasError,
  hasVisibleComments,
  isLoading,
}: {
  hasError: boolean;
  hasVisibleComments: boolean;
  isLoading: boolean;
}): BranchCommentsPanelState {
  if (hasVisibleComments) {
    return BranchCommentsPanelState.Ready;
  }
  if (isLoading) {
    return BranchCommentsPanelState.Loading;
  }
  if (hasError) {
    return BranchCommentsPanelState.Error;
  }
  return BranchCommentsPanelState.Ready;
}

export const DEFAULT_COMMENTS_WIDTH = 340;

/** The Sessions the timeline rendered, which scope the Sessions tab's comments. */
export type BranchRenderedSessions = {
  coverageNote: string | null;
  sessionIds: readonly string[];
};

export const BRANCH_COMMENTS_CONTROLS_ID = "branch-comments-workspace";

/** The tab's pane scope; null on a tab that has no pane. */
export function branchCommentsScopeForTab(
  tab: ArtifactDetailTab
): BranchCommentsTab | null {
  if (tab === ArtifactDetailTab.Artifact) {
    return BranchCommentsTab.Details;
  }
  return tab === ArtifactDetailTab.Sessions ? BranchCommentsTab.Sessions : null;
}

/** ISS-12300 D1: the Artifact and Sessions tabs each keep their own pane state. */
export const BRANCH_COMMENTS_PANE_KEYS = {
  [BranchCommentsTab.Details]: {
    open: CommentsPaneOpenKey.BranchArtifact,
    width: CommentsPaneWidthKey.BranchArtifact,
  },
  [BranchCommentsTab.Sessions]: {
    open: CommentsPaneOpenKey.BranchSessions,
    width: CommentsPaneWidthKey.BranchSessions,
  },
} as const satisfies Record<
  BranchCommentsTab,
  { open: CommentsPaneOpenKey; width: CommentsPaneWidthKey }
>;

/**
 * ISS-12597: a failed read names the read failure, and the operator chose this
 * existing string for both the thrown error and the rail notice.
 */
export const BRANCH_COMMENTS_READ_FAILED = "Branch comments could not be read.";
