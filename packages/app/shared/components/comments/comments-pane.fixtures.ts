// gardener-support: test and story data, not shipped
import {
  ThreadSource,
  ThreadStatus,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import {
  CodeCommentSide,
  type CommentAnchor,
  CommentAnchorState,
  type CommentAnchorTrace,
} from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import {
  CapabilityGrant,
  COMMENT_SOURCE_POLICIES,
  type CollectionCapabilities,
  type CommentPolicyKey,
  type ItemPermissions,
} from "@repo/api/src/types/comment-capabilities";
import {
  CommentBodyFormat,
  type CommentDto,
  CommentSyncDirection,
  CommentSyncProvider,
  CommentSyncStatus,
  type CommentThreadDto,
} from "@repo/api/src/types/comment-thread-dto";

/**
 * Story and test fixtures in the unified thread shape. Capabilities are read
 * from the shipped source-policy table, so a story per source shows exactly
 * what that source grants a viewer.
 */

export const ALL_PERMISSIONS: ItemPermissions = {
  canDelete: true,
  canEdit: true,
  canReopen: true,
  canResolve: true,
  canRetrySync: true,
};

export const NO_PERMISSIONS: ItemPermissions = {
  canDelete: false,
  canEdit: false,
  canReopen: false,
  canResolve: false,
  canRetrySync: false,
};

/** A viewer's capabilities under one source policy; `staff` unlocks staff-only kinds. */
export function capabilitiesFor(
  policyKey: CommentPolicyKey,
  { staff = false }: { staff?: boolean } = {}
): CollectionCapabilities {
  const policy = COMMENT_SOURCE_POLICIES[policyKey];
  const granted = (grant: CapabilityGrant) =>
    grant !== CapabilityGrant.None &&
    (staff || grant !== CapabilityGrant.Staff);
  return {
    anchorKinds: policy.anchorKinds,
    attach: granted(policy.capabilities.attach),
    commentKinds: (
      Object.entries(policy.commentKinds) as [
        TraceCommentKind,
        CapabilityGrant,
      ][]
    )
      .filter(([, grant]) => granted(grant))
      .map(([kind]) => kind),
    createThread: granted(policy.capabilities.createThread),
    delete: granted(policy.capabilities.delete),
    edit: granted(policy.capabilities.edit),
    linkOut: granted(policy.capabilities.linkOut),
    mention: granted(policy.capabilities.mention),
    react: granted(policy.capabilities.react),
    reopen: granted(policy.capabilities.reopen),
    reply: granted(policy.capabilities.reply),
    resolve: granted(policy.capabilities.resolve),
    retrySync: granted(policy.capabilities.retrySync),
  };
}

/** Every capability on, for the states that exercise the whole card. */
export const FULL_CAPABILITIES: CollectionCapabilities = {
  anchorKinds: [
    CommentAnchorKind.Artifact,
    CommentAnchorKind.Trace,
    CommentAnchorKind.Code,
  ],
  attach: false,
  commentKinds: [TraceCommentKind.Comment],
  createThread: true,
  delete: true,
  edit: true,
  linkOut: true,
  mention: false,
  react: false,
  reopen: true,
  reply: true,
  resolve: true,
  retrySync: true,
};

export const READ_ONLY_CAPABILITIES: CollectionCapabilities = {
  ...FULL_CAPABILITIES,
  createThread: false,
  delete: false,
  edit: false,
  linkOut: false,
  reopen: false,
  reply: false,
  resolve: false,
  retrySync: false,
};

export function traceAnchor(
  selectedText: string,
  overrides: { row?: number; sessionId?: string } = {}
): CommentAnchorTrace {
  return {
    endOffset: selectedText.length,
    kind: CommentAnchorKind.Trace,
    row: overrides.row ?? 4,
    selectedText,
    sessionId: overrides.sessionId ?? "session-a",
    sourceText: selectedText,
    startOffset: 0,
    traceId: "trace-1",
    turnId: `turn-${overrides.row ?? 4}`,
  };
}

export function codeAnchor(
  path: string,
  endLine: number | null
): CommentAnchor {
  return {
    commitSha: "a".repeat(40),
    endLine,
    kind: CommentAnchorKind.Code,
    path,
    repository: "closedloop-ai/closedloop-ai",
    side: CodeCommentSide.Right,
  };
}

let commentSequence = 0;

export function makeComment(
  overrides: Partial<CommentDto> & { body: string }
): CommentDto {
  commentSequence += 1;
  return {
    author: { avatarUrl: null, id: "user-jordan", name: "Jordan Lee" },
    bodyFormat: CommentBodyFormat.Markdown,
    createdAt: "2026-09-30T14:05:00.000Z",
    editedAt: null,
    id: `comment-${commentSequence}`,
    mentions: [],
    permissions: ALL_PERMISSIONS,
    revision: 1,
    threadId: "thread",
    updatedAt: "2026-09-30T14:05:00.000Z",
    ...overrides,
  };
}

export function makeThread(
  overrides: Partial<CommentThreadDto> & { id: string }
): CommentThreadDto {
  const comments = overrides.comments ?? [
    makeComment({ body: `Body of ${overrides.id}`, threadId: overrides.id }),
  ];
  return {
    anchor: traceAnchor("Added the variant and a focused unit test:"),
    anchorState: CommentAnchorState.Anchored,
    artifactId: "artifact-1",
    createdAt: "2026-09-30T14:05:00.000Z",
    kind: TraceCommentKind.Comment,
    permissions: ALL_PERMISSIONS,
    provider: {},
    resolvedAt: null,
    resolvedBy: null,
    revision: 1,
    source: ThreadSource.Native,
    status: ThreadStatus.Open,
    sync: null,
    ...overrides,
    comments,
  };
}

export function githubThread(
  id: string,
  overrides: Partial<CommentThreadDto> = {}
): CommentThreadDto {
  return makeThread({
    anchor: codeAnchor(
      "packages/app/shared/components/comments/comments-pane.tsx",
      42
    ),
    comments: [
      makeComment({
        author: { avatarUrl: null, id: "gh-octo", name: "octocat" },
        body: "Should this guard the empty anchor case too?",
        permissions: NO_PERMISSIONS,
        threadId: id,
      }),
    ],
    id,
    permissions: NO_PERMISSIONS,
    provider: {
      linkOut: `https://github.com/closedloop-ai/closedloop-ai/pull/1#discussion_${id}`,
    },
    source: ThreadSource.Github,
    sync: {
      direction: CommentSyncDirection.Inbound,
      provider: CommentSyncProvider.Github,
      state: CommentSyncStatus.Synced,
    },
    ...overrides,
  });
}

export function desktopSync(state: CommentSyncStatus) {
  return {
    direction: CommentSyncDirection.Outbound,
    provider: CommentSyncProvider.Desktop,
    state,
  };
}

export const SESSION_THREADS: CommentThreadDto[] = [
  makeThread({
    comments: [
      makeComment({
        body: "The revision session accounts for most of the rework cost in this trace.",
        threadId: "session-thread-1",
      }),
      makeComment({
        author: { avatarUrl: null, id: "user-sam", name: "Sam Chen" },
        body: "Agreed — the second pass re-ran the whole suite.",
        createdAt: "2026-09-30T14:20:00.000Z",
        permissions: NO_PERMISSIONS,
        threadId: "session-thread-1",
      }),
    ],
    id: "session-thread-1",
  }),
  makeThread({
    anchor: traceAnchor("pnpm turbo typecheck --concurrency=2", { row: 9 }),
    comments: [
      makeComment({
        author: { avatarUrl: null, id: "user-pascoe", name: "Pascoe Birchall" },
        body: "This step dominates the wall clock.",
        permissions: { ...NO_PERMISSIONS },
        threadId: "session-thread-2",
      }),
    ],
    id: "session-thread-2",
    permissions: NO_PERMISSIONS,
  }),
];
