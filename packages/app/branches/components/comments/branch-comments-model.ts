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
