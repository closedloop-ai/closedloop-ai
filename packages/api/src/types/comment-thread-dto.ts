import { z } from "zod";
import type { BranchPrCommentAuthor } from "./branch.ts";
import {
  CommentSurface,
  normalizeTraceCommentKind,
  ThreadSource,
  ThreadStatus,
  TRACE_COMMENT_BODY_MAX_LENGTH,
  TRACE_COMMENT_ID_MAX_LENGTH,
  TraceCommentKind,
  type TraceCommentMentions,
  traceCommentClientIdSchema,
  traceCommentDraftKindSchema,
  traceCommentMentionsSchema,
} from "./comment.ts";
import {
  type CommentAnchor,
  type CommentAnchorState,
  commentAnchorSchema,
  commentAnchorStateSchema,
} from "./comment-anchor.ts";
import { CommentAnchorKind } from "./comment-anchor-kind.ts";
import {
  type CollectionCapabilities,
  CommentCapability,
  type ItemPermissions,
} from "./comment-capabilities.ts";
import { normalizeGitHubActorType } from "./github-actor.ts";

/**
 * Format of the stored `Comment.body` JSON. `LIVEBLOCKS_V1` is transitional:
 * Liveblocks bodies convert to `RICH_V1` in the documents phase.
 */
export const CommentBodyFormat = {
  RichV1: "RICH_V1",
  Markdown: "MARKDOWN",
  LiveblocksV1: "LIVEBLOCKS_V1",
} as const;
export type CommentBodyFormat =
  (typeof CommentBodyFormat)[keyof typeof CommentBodyFormat];

export const CommentSyncProvider = {
  Desktop: "DESKTOP",
  Github: "GITHUB",
  Liveblocks: "LIVEBLOCKS",
} as const;
export type CommentSyncProvider =
  (typeof CommentSyncProvider)[keyof typeof CommentSyncProvider];

export const CommentSyncDirection = {
  Inbound: "INBOUND",
  Outbound: "OUTBOUND",
  Both: "BOTH",
} as const;
export type CommentSyncDirection =
  (typeof CommentSyncDirection)[keyof typeof CommentSyncDirection];

export const CommentSyncStatus = {
  Synced: "SYNCED",
  Pending: "PENDING",
  Failed: "FAILED",
  Abandoned: "ABANDONED",
} as const;
export type CommentSyncStatus =
  (typeof CommentSyncStatus)[keyof typeof CommentSyncStatus];

export const commentBodyFormatSchema = z.enum(CommentBodyFormat);
export const commentSyncProviderSchema = z.enum(CommentSyncProvider);
export const commentSyncDirectionSchema = z.enum(CommentSyncDirection);
export const commentSyncStatusSchema = z.enum(CommentSyncStatus);

export type CommentThreadSyncDto = {
  provider: CommentSyncProvider;
  direction: CommentSyncDirection;
  state: CommentSyncStatus;
};

export type CommentThreadProviderDto = {
  linkOut?: string;
  /** The provider login is `author.login`. */
  author?: BranchPrCommentAuthor;
  /**
   * GitHub threads only (Kerensa, 2026-10-05): a comment on the thread has an
   * unconfirmed sync, or its pull request's latest reconcile attempt failed.
   */
  stale?: boolean;
  /**
   * GitHub threads only: the number of the Branch pull request the thread is
   * on. Absent from servers that predate it.
   */
  pullRequestNumber?: number;
  /**
   * GitHub threads only: that pull request's repository, `owner/name` as the
   * selected-PR identity spells it. Absent when the server cannot name it or
   * predates it.
   */
  repositoryFullName?: string;
};

export type CommentAuthorDto = {
  id: string;
  name: string | null;
  avatarUrl: string | null;
};

export type CommentDto = {
  id: string;
  threadId: string;
  author: CommentAuthorDto;
  /**
   * `Comment.plainText`: the typed text for `RICH_V1`, the markdown source for
   * `MARKDOWN`, the extracted text for `LIVEBLOCKS_V1`. Only `MARKDOWN` renders
   * as markdown.
   */
  body: string;
  bodyFormat: CommentBodyFormat;
  mentions: TraceCommentMentions;
  revision: number;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  permissions: ItemPermissions;
  /** Absent from servers that predate reactions (PLN-2187 T-1.4). */
  reactions?: CommentReactionDto[];
  /** Absent from servers that predate attachments (PLN-2187 T-1.4). */
  attachments?: CommentAttachmentDto[];
};

export type CommentThreadDto = {
  id: string;
  artifactId: string;
  source: ThreadSource;
  /** `null` until the source's anchors are backfilled into the typed column. */
  anchor: CommentAnchor | null;
  anchorState: CommentAnchorState | null;
  status: ThreadStatus;
  resolvedAt: string | null;
  resolvedBy: CommentAuthorDto | null;
  revision: number;
  sync: CommentThreadSyncDto | null;
  permissions: ItemPermissions;
  provider: CommentThreadProviderDto;
  kind: TraceCommentKind;
  surface?: CommentSurface;
  createdAt: string;
  comments: CommentDto[];
};

export type ArtifactCommentsResponse = {
  /**
   * The artifact the list resolved, which names its realtime channel even when
   * the list was addressed by a session id or is empty (PLN-2162 decision 1).
   * Absent from servers that predate it.
   */
  artifactId?: string;
  capabilities: CollectionCapabilities;
  threads: CommentThreadDto[];
  nextCursor: string | null;
};

export type CreateCommentThreadRequest = {
  anchor: CommentAnchor;
  body: string;
  mentions?: TraceCommentMentions;
  surface?: CommentSurface;
  kind?: TraceCommentKind;
  clientId: string;
};

export type ReplyToCommentThreadRequest = {
  body: string;
  mentions?: TraceCommentMentions;
  clientId: string;
};

export type EditCommentRequest = {
  body: string;
  mentions?: TraceCommentMentions;
  expectedRevision: number;
};

export type ListArtifactCommentsQuery = {
  surface?: CommentSurface;
  cursor?: string;
  status?: ThreadStatus;
  /** Clamped to `[1, 100]` by the read; 50 when omitted. */
  limit?: number;
  /** Scopes a desktop external session id to one owned device, as the legacy session route does. */
  computeTargetId?: string;
};

const commentBodySchema = z.string().min(1).max(TRACE_COMMENT_BODY_MAX_LENGTH);
const traceCommentSurfaceSchema = z.enum(CommentSurface);

const createCommentThreadRequestShape = {
  anchor: commentAnchorSchema,
  body: commentBodySchema,
  mentions: traceCommentMentionsSchema.optional(),
  surface: traceCommentSurfaceSchema.optional(),
  kind: traceCommentDraftKindSchema.optional(),
  clientId: traceCommentClientIdSchema,
} satisfies Record<keyof CreateCommentThreadRequest, z.ZodTypeAny>;

export const createCommentThreadRequestSchema: z.ZodType<CreateCommentThreadRequest> =
  z.object(createCommentThreadRequestShape);

const replyToCommentThreadRequestShape = {
  body: commentBodySchema,
  mentions: traceCommentMentionsSchema.optional(),
  clientId: traceCommentClientIdSchema,
} satisfies Record<keyof ReplyToCommentThreadRequest, z.ZodTypeAny>;

export const replyToCommentThreadRequestSchema: z.ZodType<ReplyToCommentThreadRequest> =
  z.object(replyToCommentThreadRequestShape);

const editCommentRequestShape = {
  body: commentBodySchema,
  mentions: traceCommentMentionsSchema.optional(),
  expectedRevision: z.number().int().nonnegative(),
} satisfies Record<keyof EditCommentRequest, z.ZodTypeAny>;

export const editCommentRequestSchema: z.ZodType<EditCommentRequest> = z.object(
  editCommentRequestShape
);

const listArtifactCommentsQueryShape = {
  surface: traceCommentSurfaceSchema.optional(),
  cursor: z.string().min(1).max(TRACE_COMMENT_ID_MAX_LENGTH).optional(),
  status: z.enum(ThreadStatus).optional(),
  limit: z.coerce.number().int().optional(),
  computeTargetId: z.uuid().optional(),
} satisfies Record<keyof ListArtifactCommentsQuery, z.ZodTypeAny>;

/**
 * Strict: an unknown filter is rejected, never dropped. `limit` is not bounded
 * here: the read clamps it to `[1, 100]` (PLN-2121, Reads).
 */
export const listArtifactCommentsQuerySchema: z.ZodType<ListArtifactCommentsQuery> =
  z.object(listArtifactCommentsQueryShape).strict();

const itemPermissionsShape = {
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  canResolve: z.boolean(),
  canReopen: z.boolean(),
  canRetrySync: z.boolean(),
} satisfies Record<keyof ItemPermissions, z.ZodTypeAny>;

const commentAuthorDtoShape = {
  id: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
} satisfies Record<keyof CommentAuthorDto, z.ZodTypeAny>;

const commentAuthorDtoSchema = z.object(commentAuthorDtoShape);

const providerAuthorShape = {
  login: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  profileUrl: z.string().nullable(),
  actorType: z.unknown().transform(normalizeGitHubActorType).optional(),
} satisfies Record<keyof BranchPrCommentAuthor, z.ZodTypeAny>;

const commentThreadProviderDtoShape = {
  linkOut: z.string().optional(),
  author: z.object(providerAuthorShape).optional(),
  stale: z.boolean().optional(),
  pullRequestNumber: z.number().int().positive().optional(),
  repositoryFullName: z.string().optional(),
} satisfies Record<keyof CommentThreadProviderDto, z.ZodTypeAny>;

const commentThreadSyncDtoShape = {
  provider: commentSyncProviderSchema,
  direction: commentSyncDirectionSchema,
  state: commentSyncStatusSchema,
} satisfies Record<keyof CommentThreadSyncDto, z.ZodTypeAny>;

const commentReactionDtoShape = {
  emoji: z.string(),
  userIds: z.array(z.string()),
  viewerReacted: z.boolean(),
} satisfies Record<keyof CommentReactionDto, z.ZodTypeAny>;

const commentAttachmentDtoShape = {
  id: z.string(),
  name: z.string(),
  mimeType: z.string().nullable(),
  size: z.number().int().nonnegative().nullable(),
  downloadPath: z.string(),
} satisfies Record<keyof CommentAttachmentDto, z.ZodTypeAny>;

const commentDtoShape = {
  id: z.string(),
  threadId: z.string(),
  author: commentAuthorDtoSchema,
  body: z.string(),
  bodyFormat: commentBodyFormatSchema,
  mentions: z.array(z.string()),
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  editedAt: z.string().nullable(),
  permissions: z.object(itemPermissionsShape),
  reactions: z.array(z.object(commentReactionDtoShape)).optional(),
  attachments: z.array(z.object(commentAttachmentDtoShape)).optional(),
} satisfies Record<keyof CommentDto, z.ZodTypeAny>;

export const commentDtoSchema: z.ZodType<CommentDto> =
  z.object(commentDtoShape);

const commentThreadDtoShape = {
  id: z.string(),
  artifactId: z.string(),
  source: z.enum(ThreadSource),
  anchor: commentAnchorSchema.nullable(),
  anchorState: commentAnchorStateSchema.nullable(),
  status: z.enum(ThreadStatus),
  resolvedAt: z.string().nullable(),
  resolvedBy: commentAuthorDtoSchema.nullable(),
  revision: z.number().int().nonnegative(),
  sync: z.object(commentThreadSyncDtoShape).nullable(),
  permissions: z.object(itemPermissionsShape),
  provider: z.object(commentThreadProviderDtoShape),
  // A kind this build predates reads as a plain comment, as on every boundary.
  kind: z.unknown().transform(normalizeTraceCommentKind),
  surface: traceCommentSurfaceSchema.optional(),
  createdAt: z.string(),
  comments: z.array(commentDtoSchema),
} satisfies Record<keyof CommentThreadDto, z.ZodTypeAny>;

/**
 * A unified thread as a client receives it. Unknown keys are dropped, so a
 * newer server's additive fields never fail an older client.
 */
export const commentThreadDtoSchema: z.ZodType<CommentThreadDto> = z.object(
  commentThreadDtoShape
);

const KNOWN_ANCHOR_KINDS: ReadonlySet<string> = new Set(
  Object.values(CommentAnchorKind)
);
const KNOWN_COMMENT_KINDS: ReadonlySet<string> = new Set(
  Object.values(TraceCommentKind)
);

const collectionCapabilitiesShape = {
  [CommentCapability.CreateThread]: z.boolean(),
  [CommentCapability.Reply]: z.boolean(),
  [CommentCapability.Edit]: z.boolean(),
  [CommentCapability.Delete]: z.boolean(),
  [CommentCapability.Resolve]: z.boolean(),
  [CommentCapability.Reopen]: z.boolean(),
  [CommentCapability.React]: z.boolean(),
  [CommentCapability.Attach]: z.boolean(),
  [CommentCapability.Mention]: z.boolean(),
  [CommentCapability.RetrySync]: z.boolean(),
  [CommentCapability.LinkOut]: z.boolean(),
  // A kind this build cannot handle is not offered, rather than failing the list.
  anchorKinds: z
    .array(z.string())
    .transform((kinds) =>
      kinds.filter((kind): kind is CommentAnchorKind =>
        KNOWN_ANCHOR_KINDS.has(kind)
      )
    ),
  commentKinds: z
    .array(z.string())
    .transform((kinds) =>
      kinds.filter((kind): kind is TraceCommentKind =>
        KNOWN_COMMENT_KINDS.has(kind)
      )
    ),
} satisfies Record<keyof CollectionCapabilities, z.ZodTypeAny>;

const artifactCommentsResponseShape = {
  artifactId: z.string().optional(),
  capabilities: z.object(collectionCapabilitiesShape),
  // Kerensa, 2026-10-06: a thread this build cannot fully read is left out and
  // the rest of the list loads, as the server leaves out a thread whose stored
  // anchor it cannot read. A malformed envelope still fails the page.
  threads: z.array(z.unknown()).transform(readableThreads),
  nextCursor: z.string().nullable(),
} satisfies Record<keyof ArtifactCommentsResponse, z.ZodTypeAny>;

/** One page of `GET /artifacts/:id/comments` as a client receives it (PLN-2162 decision 2). */
export const artifactCommentsResponseSchema: z.ZodType<ArtifactCommentsResponse> =
  z.object(artifactCommentsResponseShape);

/** The unified comment routes' paths, relative to the API base. */
export const commentApiPaths = {
  artifactComments: (artifactId: string) =>
    `/artifacts/${commentPathSegment(artifactId)}/comments`,
  artifactThreads: (artifactId: string) =>
    `/artifacts/${commentPathSegment(artifactId)}/comments/threads`,
  thread: (threadId: string) =>
    `/comments/threads/${commentPathSegment(threadId)}`,
  threadReplies: (threadId: string) =>
    `/comments/threads/${commentPathSegment(threadId)}/replies`,
  threadResolve: (threadId: string) =>
    `/comments/threads/${commentPathSegment(threadId)}/resolve`,
  threadReopen: (threadId: string) =>
    `/comments/threads/${commentPathSegment(threadId)}/reopen`,
  threadRetrySync: (threadId: string) =>
    `/comments/threads/${commentPathSegment(threadId)}/retry-sync`,
  comment: (commentId: string) => `/comments/${commentPathSegment(commentId)}`,
  commentReaction: (commentId: string, emoji: string) =>
    `/comments/${commentPathSegment(commentId)}/reactions/${commentPathSegment(emoji)}`,
  commentAttachments: (commentId: string) =>
    `/comments/${commentPathSegment(commentId)}/attachments`,
  attachment: (attachmentId: string) =>
    `/comments/attachments/${commentPathSegment(attachmentId)}`,
  attachmentComplete: (attachmentId: string) =>
    `/comments/attachments/${commentPathSegment(attachmentId)}/complete`,
} as const;

/**
 * `encodeURIComponent` leaves `.` and `..` as they are, and a URL resolves
 * those segments away, so a path built from one would reach another route.
 */
function commentPathSegment(id: string): string {
  if (id === "." || id === "..") {
    throw new Error(`"${id}" is not a valid path segment.`);
  }
  return encodeURIComponent(id);
}

function readableThreads(candidates: readonly unknown[]): CommentThreadDto[] {
  return candidates.flatMap((candidate) => {
    const threadRead = commentThreadDtoSchema.safeParse(candidate);
    return threadRead.success ? [threadRead.data] : [];
  });
}

/** One emoji on a comment and everyone who reacted with it. */
export type CommentReactionDto = {
  emoji: string;
  userIds: string[];
  viewerReacted: boolean;
};

/** A comment's file; `downloadPath` is {@link commentApiPaths.attachment}. */
export type CommentAttachmentDto = {
  id: string;
  name: string;
  mimeType: string | null;
  size: number | null;
  downloadPath: string;
};

/**
 * PLN-2187 T-2.2: the only reactions a comment accepts, GitHub's eight
 * (operator ruling, PR #8851, 2026-10-15).
 */
export const CommentReactionEmoji = {
  ThumbsUp: "👍",
  ThumbsDown: "👎",
  Laugh: "😄",
  Hooray: "🎉",
  Confused: "😕",
  Heart: "❤️",
  Rocket: "🚀",
  Eyes: "👀",
} as const;
export type CommentReactionEmoji =
  (typeof CommentReactionEmoji)[keyof typeof CommentReactionEmoji];

/**
 * PLN-2187 T-2.2: the `:emoji` segment of the reaction routes, resolved to its
 * canonical form so the same emoji sent with or without VS16 is one reaction.
 */
export const commentReactionEmojiSchema = z
  .string()
  .transform((value, context): CommentReactionEmoji => {
    const emoji = REACTION_EMOJI_BY_BARE_FORM.get(
      value.replace(VARIATION_SELECTOR_16, "")
    );
    if (emoji === undefined) {
      context.addIssue({ code: "custom", input: value });
      return z.NEVER;
    }
    return emoji;
  });

const VARIATION_SELECTOR_16 = /\uFE0F/g;

const REACTION_EMOJI_BY_BARE_FORM: ReadonlyMap<string, CommentReactionEmoji> =
  new Map(
    Object.values(CommentReactionEmoji).map((emoji) => [
      emoji.replace(VARIATION_SELECTOR_16, ""),
      emoji,
    ])
  );
