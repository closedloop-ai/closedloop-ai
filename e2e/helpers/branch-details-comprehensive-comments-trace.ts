import {
  BranchCommentsBudget,
  BranchCommentsState,
  type BranchPrComment,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  type BranchTraceResponse,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import {
  ThreadStatus,
  type TraceComment,
  TraceCommentKind,
  TraceCommentSurface,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import {
  BRANCH_ID,
  HISTORICAL_PR,
  REPOSITORY,
} from "./branch-details-comprehensive-data";

export const ACTIVE_COMMENT =
  "P1 Badge Only the active pull request says this beta";
export const HISTORICAL_COMMENT = "Only the historical pull request says this";
export const DETAILS_NATIVE_COMMENT = "Native Branch details comment";
export const TIMELINE_NATIVE_COMMENT = "Native Branch timeline comment";
export const SESSION_NATIVE_COMMENT = "Rendered Session native comment";
export const DETAILS_REPLY_DRAFT = "Draft survives a tab scope change";
export const PROVIDER_ROOT_AUTHOR = "Review User · @reviewer";
export const PROVIDER_REPLY_AUTHOR = "@reply-reviewer";
export const PROVIDER_OMITTED_DISCLOSURE =
  "3 GitHub comments are omitted from this bounded result.";
export const PROVIDER_BODY_DISCLOSURE =
  "2 GitHub comment bodies are shortened.";

export function commentsFor(prNumber: number): BranchPrCommentsResponse {
  return {
    branchId: BRANCH_ID,
    repositoryFullName: REPOSITORY,
    state: BranchCommentsState.StaleMixed,
    comments: commentsForPullRequest(prNumber),
    budget: {
      maxComments: BranchCommentsBudget.MaxComments,
      pageSize: BranchCommentsBudget.PageSize,
      maxBodyBytes: BranchCommentsBudget.MaxBodyBytes,
      maxResponseBytes: BranchCommentsBudget.MaxResponseBytes,
      providerTruncated: true,
      responseTruncated: true,
      omittedComments: 3,
      bodyTruncatedCount: 2,
    },
    providerProofedAt: "2026-08-01T12:00:00.000Z",
    stale: true,
    mixedProjection: true,
    prNumber,
    prUrl: `https://github.com/${REPOSITORY}/pull/${prNumber}`,
  };
}

function commentsForPullRequest(prNumber: number): BranchPrComment[] {
  const isHistorical = prNumber === HISTORICAL_PR;
  const root = comment(
    prNumber,
    isHistorical ? HISTORICAL_COMMENT : "Review thread root"
  );
  if (isHistorical) {
    return [root];
  }
  return [
    {
      ...root,
      kind: BranchPrCommentKind.Review,
    },
    {
      ...root,
      id: `reply-${prNumber}`,
      providerNodeId: `provider-reply-node-${prNumber}`,
      providerCommentId: `provider-reply-comment-${prNumber}`,
      inReplyToId: root.id,
      kind: BranchPrCommentKind.ReviewReply,
      body: "<sub><sub>P1 Badge</sub></sub> Only the active pull request says this <sup>beta</sup>",
      author: {
        login: "reply-reviewer",
        displayName: null,
        avatarUrl: null,
        profileUrl: "https://github.com/reply-reviewer",
      },
      line: 43,
      providerUrl: `https://github.com/${REPOSITORY}/pull/${prNumber}#discussion_r${prNumber}2`,
      resolved: true,
    },
  ];
}

function comment(prNumber: number, body: string): BranchPrComment {
  return {
    id: `comment-${prNumber}`,
    providerNodeId: `provider-node-${prNumber}`,
    providerCommentId: `provider-comment-${prNumber}`,
    threadId: `thread-${prNumber}`,
    inReplyToId: null,
    kind: BranchPrCommentKind.Issue,
    body,
    author: {
      login: "reviewer",
      displayName: "Review User",
      avatarUrl: null,
      profileUrl: null,
    },
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: null,
    path: "packages/app/branches/components/comments/branch-comment-card.tsx",
    line: 42,
    resolved: false,
    providerUrl: `https://github.com/${REPOSITORY}/pull/${prNumber}#discussion_r${prNumber}1`,
    stale: true,
    bodyTruncated: true,
  };
}

export function nativeComment(surface: TraceCommentSurface): TraceComment {
  const isTimeline = surface === TraceCommentSurface.BranchTimeline;
  const anchorLabel = isTimeline ? "Timeline anchor" : "Details anchor";
  return {
    id: isTimeline ? "timeline-comment" : "details-comment",
    threadId: isTimeline ? "timeline-thread" : "details-thread",
    target: { type: TraceCommentTargetType.Branch, id: BRANCH_ID },
    artifactId: BRANCH_ID,
    surface,
    kind: TraceCommentKind.Comment,
    status: ThreadStatus.Open,
    anchor: {
      traceId: BRANCH_ID,
      turnId: isTimeline ? "timeline-turn" : "details-turn",
      row: isTimeline ? 2 : 1,
      selectedText: anchorLabel,
      sourceText: anchorLabel,
      startOffset: 0,
      endOffset: anchorLabel.length,
    },
    body: isTimeline ? TIMELINE_NATIVE_COMMENT : DETAILS_NATIVE_COMMENT,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    editedAt: null,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    resolvedByAvatarUrl: null,
    authorId: "native-author",
    authorName: "Native Reviewer",
    authorAvatarUrl: null,
    canEdit: true,
    canDelete: true,
    replies: [],
  };
}

export function sessionNativeComment(): TraceComment {
  return {
    ...nativeComment(TraceCommentSurface.SessionDetail),
    id: "session-build-comment",
    threadId: "session-build-thread",
    target: {
      type: TraceCommentTargetType.Session,
      id: "session-build",
    },
    artifactId: "session-build",
    body: SESSION_NATIVE_COMMENT,
  };
}
export function traceResponse(): BranchTraceResponse {
  const items: BranchTraceResponse["items"] = [
    {
      type: "sessionstart",
      sessionId: "session-build",
      t: "2026-08-01T10:00:00.000Z",
      actor: { name: "Ada Lovelace", harness: "codex" },
    },
    {
      type: "prompt",
      sessionId: "session-build",
      t: "2026-08-01T10:01:00.000Z",
      tMs: Date.parse("2026-08-01T10:01:00.000Z"),
      cumCostUsd: 2,
      actorName: "Ada Lovelace",
      text: "Implement selector propagation",
    },
    {
      type: "event",
      sessionId: "session-build",
      t: "2026-08-01T10:02:00.000Z",
      dot: "g",
      text: "Pull request merged",
    },
    { type: "end", sessionId: "session-build", text: "Session complete" },
  ];
  return {
    branchId: BRANCH_ID,
    viewerScope: BranchViewerScope.Organization,
    items,
    hasMore: false,
    traceState: {
      sessions: [
        {
          identity: {
            artifactId: "session-build",
            name: "Build session",
            slug: "session-build",
            navigableRef: "session-build",
          },
          state: BranchTraceSessionHydrationState.Loaded,
        },
      ],
      qualifyingSessionCount: 1,
      completeness: { state: BranchTraceCompletenessState.Complete },
      aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
    },
  };
}

/** Complete hydration fixture for the timing-completeness regression. */
export function timingIncompleteTraceResponse(): BranchTraceResponse {
  const response = traceResponse();
  const traceState = response.traceState;
  if (!traceState) {
    throw new Error("Branch Details timing fixture requires trace state");
  }
  return {
    ...response,
    items: [
      {
        type: "end",
        sessionId: "session-build",
        text: "Build session complete",
      },
      {
        type: "end",
        sessionId: "session-review",
        text: "Review session complete",
      },
      {
        type: "end",
        sessionId: "session-rework",
        text: "Rework session complete",
      },
    ],
    traceState: {
      ...traceState,
      qualifyingSessionCount: 3,
      sessions: ["build", "review", "rework"].map((phase) => ({
        identity: {
          artifactId: `session-${phase}`,
          name: `${phase[0]!.toUpperCase()}${phase.slice(1)} session`,
          navigableRef: `session-${phase}`,
          slug: `session-${phase}`,
        },
        state: BranchTraceSessionHydrationState.Loaded,
      })),
    },
  };
}

/** Settled failed-read fixture that retains all linked Session identities. */
export function unavailableTraceResponse(): BranchTraceResponse {
  return {
    branchId: BRANCH_ID,
    viewerScope: BranchViewerScope.Organization,
    items: [],
    hasMore: false,
    traceState: {
      sessions: ["build", "review", "rework"].map((phase) => ({
        identity: {
          artifactId: `session-${phase}`,
          name: `${phase[0]!.toUpperCase()}${phase.slice(1)} session`,
          navigableRef: `session-${phase}`,
          slug: `session-${phase}`,
        },
        reason: BranchTraceUnavailableReason.PageFailure,
        state: BranchTraceSessionHydrationState.Unavailable,
      })),
      qualifyingSessionCount: 3,
      completeness: {
        reason: BranchTraceUnavailableReason.PageFailure,
        state: BranchTraceCompletenessState.Unavailable,
      },
      aggregateCompleteness: {
        reason: BranchTraceUnavailableReason.PageFailure,
        state: BranchTraceCompletenessState.Unavailable,
      },
    },
  };
}
