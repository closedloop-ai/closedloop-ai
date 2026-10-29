import { z } from "zod";
import type { CommentAnchor, CommentAnchorState } from "./comment-anchor.js";
import type { JsonObject } from "./common.js";
import type { BasicUser } from "./user.js";

export const ThreadSource = {
  Native: "NATIVE",
  Liveblocks: "LIVEBLOCKS",
  /** Persisted/shared source for GitHub comment projection rows. */
  Github: "GITHUB",
} as const;
export type ThreadSource = (typeof ThreadSource)[keyof typeof ThreadSource];

export const ThreadStatus = {
  Open: "OPEN",
  Resolved: "RESOLVED",
} as const;
export type ThreadStatus = (typeof ThreadStatus)[keyof typeof ThreadStatus];

export const DocumentThreadAnchorStatus = {
  Anchored: "anchored",
  Floating: "floating",
  ArtifactLevel: "artifact-level",
} as const;
export type DocumentThreadAnchorStatus =
  (typeof DocumentThreadAnchorStatus)[keyof typeof DocumentThreadAnchorStatus];

export type CommentThread = {
  id: string;
  organizationId: string;
  source: ThreadSource;
  externalId: string | null;
  roomId: string | null;
  artifactId: string | null;
  status: ThreadStatus;
  metadata: JsonObject | null;
  createdAtVersion: number | null;
  resolvedAt: Date | null;
  resolvedById: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * PLN-2187 T-7.3: the typed anchor and its placement, on the reads that
   * carry them (the T-7.2 document-thread adapter). Absent on the Liveblocks
   * read, so a reader falls back to `metadata`.
   */
  anchor?: CommentAnchor | null;
  anchorState?: CommentAnchorState | null;
};

export type CommentThreadWithComments = CommentThread & {
  comments: Comment[];
  resolvedBy: BasicUser | null;
  createdBy: BasicUser | null;
};

export type Comment = {
  id: string;
  threadId: string;
  authorId: string;
  body: JsonObject;
  plainText: string | null;
  externalId: string | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  author?: BasicUser | null;
  reactions?: CommentReaction[];
  attachments?: CommentAttachment[];
};

export type CommentReaction = {
  id: string;
  commentId: string;
  userId: string;
  emoji: string;
  createdAt: Date;
};

export type CommentAttachment = {
  id: string;
  commentId: string;
  externalId: string | null;
  name: string;
  size: number | null;
  mimeType: string | null;
  url: string | null;
  createdAt: Date;
};

export const CommentTargetType = {
  Session: "session",
  Branch: "branch",
  Document: "document",
} as const;
export type CommentTargetType =
  (typeof CommentTargetType)[keyof typeof CommentTargetType];

export const CommentSurface = {
  SessionDetail: "session_detail",
  BranchDetail: "branch_detail",
  BranchTimeline: "branch_timeline",
  DocumentDetail: "document_detail",
} as const;
export type CommentSurface =
  (typeof CommentSurface)[keyof typeof CommentSurface];

/** Optional Branch collection scope; omission preserves Branch-detail behavior. */
export const branchTraceCommentCollectionQuerySchema = z
  .object({
    surface: z
      .union([
        z.literal(CommentSurface.BranchDetail),
        z.literal(CommentSurface.BranchTimeline),
      ])
      .optional(),
  })
  .strict();
export type BranchTraceCommentCollectionQuery = z.infer<
  typeof branchTraceCommentCollectionQuerySchema
>;

/**
 * Classification of a trace comment (FEA-4171). Additive and optional: a comment
 * with no `kind` (older clients, or any ordinary comment) is treated as
 * {@link TraceCommentKind.Comment}. `ParsingBug` flags a comment that reports a
 * parsing/data bug in how the session was collected — the input the golden-dataset
 * CANDIDATE pipeline surfaces for a human to promote into an oracle entry. This is
 * a classification only; it never auto-writes any golden-sessions oracle file.
 */
export const TraceCommentKind = {
  Comment: "comment",
  ParsingBug: "parsing_bug",
} as const;
export type TraceCommentKind =
  (typeof TraceCommentKind)[keyof typeof TraceCommentKind];

export const TRACE_COMMENT_METADATA_KIND = "trace_comment" as const;
export const TRACE_COMMENT_SCHEMA_VERSION = 1 as const;
export const TRACE_COMMENT_BODY_MAX_LENGTH = 10_000;
/**
 * Upper bound on the number of distinct @-mentioned user IDs a single trace
 * comment (or reply / edit) may carry (FEA-3490). Keeps a mention payload from
 * unbounded growth independent of the body length; well above any realistic org
 * tag list. Persistence additionally filters the list to org members, so an
 * over-long or cross-org list is dropped rather than trusted.
 */
export const TRACE_COMMENT_MENTIONS_MAX = 50;
export const TRACE_COMMENT_ANCHOR_TEXT_MAX_LENGTH = 5000;
export const TRACE_COMMENT_ID_MAX_LENGTH = 500;
export const TRACE_COMMENT_REQUEST_MAX_BYTES = 32_768;
/** Raw request byte cap for POST /documents/:id/threads (anchored or unanchored). */
export const DOCUMENT_THREAD_REQUEST_MAX_BYTES = 32_768;

export type TraceCommentTarget = {
  type: CommentTargetType;
  /**
   * Surface identity from the caller. Web session/branch routes normally pass a
   * cloud artifact id; desktop may pass a local external session id or encoded
   * branch id, which the API resolves to the same artifact before persistence.
   */
  id: string;
};

export type TraceTextAnchor = {
  /** Stable trace identity derived from the rendered producer and row. */
  traceId: string;
  /** Stable turn identity used to reject stale row-only highlight matches. */
  turnId: string;
  row: number;
  selectedText: string;
  sourceText: string;
  startOffset: number;
  endOffset: number;
  sessionId?: string | null;
  actor?: {
    name: string | null;
    human: string | null;
  } | null;
};

/**
 * Distinct user IDs @-mentioned in a trace comment body (FEA-3490). Optional and
 * additive: older clients omit it, and the body text stays a plain string. The
 * API persists only the subset of these IDs that belong to the caller's org.
 */
export type TraceCommentMentions = string[];

/** Draft emitted by the trace renderer when a selected passage is submitted. */
export type TraceCommentDraft = {
  anchor: TraceTextAnchor;
  body: string;
  /** @-mentioned user IDs (FEA-3490); omitted by clients that predate mentions. */
  mentions?: TraceCommentMentions;
  /**
   * Stable client-supplied idempotency id (FEA-3598). The desktop local-first
   * store sends its durable local row id here so a create that is retried after
   * a lost response (network timeout, or the app killed before the row was
   * marked uploaded) dedups server-side onto the same thread instead of minting
   * a duplicate. Omitted by web (which POSTs directly with no retry queue) and
   * by clients that predate the field.
   */
  clientId?: string;
  /**
   * Comment classification (FEA-4171). Optional and additive: omitted by older
   * clients and treated as {@link TraceCommentKind.Comment}. When
   * {@link TraceCommentKind.ParsingBug}, the comment flags a parsing/data bug and
   * feeds the golden-dataset CANDIDATE pipeline.
   */
  kind?: TraceCommentKind;
};

/** Body-only payload for replying to an anchored trace comment thread. */
export type TraceCommentReplyDraft = {
  body: string;
  /** @-mentioned user IDs (FEA-3490); omitted by clients that predate mentions. */
  mentions?: TraceCommentMentions;
  /**
   * Stable client-supplied idempotency id for a retried reply (FEA-3598); see
   * {@link TraceCommentDraft.clientId}.
   */
  clientId?: string;
};

/** Body-only edit payload for an existing trace comment. */
export type TraceCommentUpdate = {
  body: string;
  /** @-mentioned user IDs (FEA-3490); omitted by clients that predate mentions. */
  mentions?: TraceCommentMentions;
};

/** Delete response for a trace comment mutation. */
export type TraceCommentDeleteResult = {
  deleted: true;
};

/** Persisted reply in an anchored trace comment thread. */
export type TraceCommentReply = {
  id: string;
  threadId: string;
  body: string;
  /**
   * @-mentioned user IDs on this reply (FEA-3490). Always present on freshly
   * mapped rows (possibly empty); older cached payloads may omit it, so
   * consumers normalize a missing value to an empty array.
   */
  mentions?: TraceCommentMentions;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  authorId: string;
  authorName: string | null;
  authorAvatarUrl: string | null;
  canEdit: boolean;
  canDelete: boolean;
};

/**
 * Persisted trace comment returned by the REST API. Anchor metadata lives on the
 * backing thread; the text body lives on the root comment, with replies stored
 * as subsequent native comments in the same thread.
 */
export type TraceComment = TraceCommentDraft & {
  id: string;
  threadId: string;
  target: TraceCommentTarget;
  artifactId: string;
  surface: CommentSurface;
  /**
   * Classification of this comment (FEA-4171). Always present on a freshly mapped
   * row (defaulting to {@link TraceCommentKind.Comment} when the stored metadata
   * predates the field); narrows the `kind?` inherited from the draft.
   */
  kind: TraceCommentKind;
  status: ThreadStatus;
  resolvedAt: string | null;
  resolvedById: string | null;
  resolvedByName: string | null;
  resolvedByAvatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  authorId: string;
  authorName: string | null;
  authorAvatarUrl: string | null;
  canEdit: boolean;
  canDelete: boolean;
  /**
   * First-level replies. Older clients and cached payloads may omit this field,
   * so consumers must normalize missing replies to an empty array.
   */
  replies?: TraceCommentReply[];
  /**
   * ISS-8597 (PRD-699 §5 D2): this comment's delivery to the cloud was
   * permanently rejected and the desktop lane has stopped retrying it, so the
   * author is the only one who can move it.
   *
   * OMITTED rather than `false` on every other row, and optional so an older
   * payload or a source that cannot know says nothing instead of claiming
   * delivery. Every reader must treat absence as "not abandoned", never as
   * "unknown".
   *
   * ISS-10382 gave it a SECOND writer and a cloud representation. It is no
   * longer desktop-only: the API persists it on the comment's thread metadata
   * and serves it here, so a shell with no local queue can show its author a
   * dead-lettered comment and offer the door. The two writers describe different
   * rows — the desktop store answers for a row its own queue dead-lettered, the
   * cloud for one it holds and was asked to mark — and each is cleared by a
   * retry aimed at ITS OWN store.
   *
   * ISS-10827 GAVE IT ITS PRODUCER: the desktop lane of builds older than
   * ISS-11213 reports every dead letter it has not yet reported through
   * `traceCommentSyncAbandonedPath`, driven by its own store-wide sweep rather
   * than by any renderer, and the verdict it reports is the one its SQL reached —
   * the cloud stores it and never re-derives it. ISS-11213 deleted that lane from
   * this tree, so those older installed builds are now the only producer.
   *
   * IN THOSE OLDER BUILDS THE TWO WRITERS ARE KEPT IN STEP, in one direction
   * each. Up: the desktop reports. Down: the desktop's reconcile of the cloud LIST
   * re-pends a row whose marker its author cleared here, so a web retry genuinely
   * returns that row to the desktop drain. What the desktop CANNOT do is act on a
   * cloud copy that has moved on — a later `update` clears this marker too, and the two are
   * indistinguishable by absence alone, so the desktop compares generations and
   * declines rather than overwrite a newer edit with the local one it still owes.
   *
   * IT IS STILL GATED, and the gate is the desktop terminal write's
   * `trace-comment-sync-abandoned` key. This used to add that no PostHog flag
   * carried that key (ISS-10531), so the field stayed absent in production;
   * that was false when written — the flag was created 2026-09-16, a day before
   * ISS-10531 recorded it absent, and is active at 100% behind a property
   * filter. So the field DOES arrive in production for a reader that filter
   * selects. It is still closed by construction rather than by a second read on
   * this side: no row reaches `abandoned` while the gate is closed for its
   * writer. The declaring module carries the correction.
   *
   * IT IS ALSO SERVED TO EVERY VIEWER of the thread, not only the author, so a
   * reader can see a failure they cannot act on. Authorship used to be implicit
   * — a local queue holds only its own user's outgoing rows — and is now
   * explicit: both shells gate the retry affordance on `canEdit`, and the API
   * answers `forbidden` to anyone else.
   *
   * WHAT THE CLOUD CANNOT REPRESENT, and why that is a boundary rather than a
   * gap: a dead-lettered CREATE never reached the cloud, so no row exists here to
   * carry this field and no cloud-backed shell can ever render it. The web shell
   * therefore sees this only on a comment whose root already landed — an
   * abandoned UPDATE. That is a property of where the row is, not of which shell
   * is asking, so no implementation on this side can widen it.
   *
   * TWO THINGS CLEAR THE CLOUD COPY: a retry, and a later `update` that lands.
   * The marker is a fact about the last delivery attempt, so a successful edit
   * of the same row is evidence it is stale — without that, the badge would go
   * on asserting a failure that is no longer true until its author clicked Retry
   * on a comment with nothing left to retry.
   */
  syncAbandoned?: boolean;
};

/** Default page size for the org-scoped aggregate `GET /trace-comments` (FEA-3550). */
export const TRACE_COMMENT_LIST_DEFAULT_LIMIT = 50;
/** Upper bound on a single aggregate trace-comment page (FEA-3550). */
export const TRACE_COMMENT_LIST_MAX_LIMIT = 100;
/**
 * ISS-8734: ceiling on the `offset` accepted by `GET /trace-comments`. Level
 * with `SESSION_LIST_MAX_OFFSET` and its siblings; rejected at the schema,
 * never clamped.
 */
export const TRACE_COMMENT_LIST_MAX_OFFSET = 10_000;

/**
 * Paginated response for the aggregate `GET /trace-comments` endpoint (FEA-3550).
 *
 * Each item is a full `TraceComment` — it already carries `target` (type + parent
 * artifact id) and `artifactId`, so a caller can deep-link back to the
 * session/branch and reply without a second lookup. `total` is the full
 * org-scoped match count for the applied filters. `nextCursor` is an opaque
 * offset token to pass back as `cursor` for the next page — `null` when the
 * result set is exhausted, and equally when the next offset would exceed
 * {@link TRACE_COMMENT_LIST_MAX_OFFSET}, because the schema rejects a `cursor`
 * past that ceiling and minting one would answer 400 to a token this endpoint
 * issued. `total` still reports the whole population, so more-rows-than-returned
 * with no cursor means the pagination cannot reach the rest, not that there are
 * none. Newest-first ordering means it is a simple offset, not a
 * keyset, so a page boundary can shift under concurrent writes — fine for the
 * "sweep all open comments" use case, not a stable snapshot.
 */
export type TraceCommentListResponse = {
  items: TraceComment[];
  total: number;
  nextCursor: string | null;
};

/**
 * The one constraint a trace-comment target id must satisfy, on any transport.
 * Deliberately NOT a UUID: per {@link TraceCommentTarget.id} the API resolves
 * either a cloud artifact id or a desktop-local external session id against the
 * same artifact, so a client that demands a UUID rejects input the API would
 * have served (ISS-6468). Import this wherever a target id is validated rather
 * than restating a shape. Note what is NOT a target id and correctly stays
 * UUID-typed: the `/sessions/{uuid}` canonical URL, and the `sessionId` FILTER
 * on `GET /trace-comments`, which matches the `artifactId` column directly.
 *
 * Declared above {@link traceCommentTargetSchema} because that schema is
 * evaluated at module load and would hit the temporal dead zone otherwise.
 */
export const traceCommentTargetIdSchema = z
  .string()
  .min(1)
  .max(TRACE_COMMENT_ID_MAX_LENGTH);

/**
 * Shared target validator for trace comment transports. Keeping this beside the
 * wire type prevents web, API, and desktop IPC from accepting different target
 * discriminators or unbounded ids.
 */
const traceCommentTargetShape = {
  type: z.union([
    z.literal(CommentTargetType.Session),
    z.literal(CommentTargetType.Branch),
  ]),
  id: traceCommentTargetIdSchema,
} satisfies Record<keyof TraceCommentTarget, z.ZodTypeAny>;

export const traceCommentTargetSchema: z.ZodType<TraceCommentTarget> = z.object(
  traceCommentTargetShape
);

/**
 * Shared anchor validator for trace text selections persisted in comment
 * metadata. Bounds keep authenticated writes from storing arbitrarily large
 * trace excerpts while preserving enough context for highlight recovery.
 */
/**
 * Field validators for {@link TraceTextAnchor}, kept as a standalone literal so
 * the keys-covered guard can see them.
 *
 * `satisfies Record<keyof TraceTextAnchor, z.ZodTypeAny>` makes the shape total
 * over the contract's key set: adding a field to `TraceTextAnchor` without
 * teaching it here fails `tsc`. The `z.ZodType<TraceTextAnchor>` annotation
 * alone does NOT do this — zod's `ZodType` is covariant in its output, so a
 * schema omitting an optional key still satisfies it with no error.
 *
 * This object is NOT `.strict()`, which makes the guard MORE valuable here, not
 * less (the FEA-3597 reasoning on `assertWorkerSchemaKeysCovered`): a `.strict()`
 * schema that is one field short rejects loudly and the unit gets retried, while
 * a plain `z.object` silently STRIPS the untaught key, so the anchor persists
 * and round-trips with the field simply gone and every consumer seeing a
 * default. Nothing else would ever surface that.
 *
 * Scope: this proves KEY COVERAGE only. `z.ZodTypeAny` is the top type, so it
 * pins neither a key's bounds nor its optionality — relaxing a `.max()` on an
 * already-covered key still satisfies it.
 */
/**
 * The nested `actor` object needs its OWN keys-covered guard. The parent
 * `Record<keyof TraceTextAnchor, …>` below only proves the `actor` KEY is
 * modelled — it says nothing about the keys inside it, so a new optional member
 * of `actor` would be silently stripped with neither `tsc` nor the round-trip
 * fixture failing. Guards do not recurse; every nested object shape needs one.
 */
const traceTextAnchorActorShape = {
  name: z.string().max(TRACE_COMMENT_ID_MAX_LENGTH).nullable(),
  human: z.string().max(TRACE_COMMENT_ID_MAX_LENGTH).nullable(),
} satisfies Record<keyof NonNullable<TraceTextAnchor["actor"]>, z.ZodTypeAny>;

export const traceTextAnchorShape = {
  traceId: z.string().min(1).max(TRACE_COMMENT_ID_MAX_LENGTH),
  turnId: z.string().min(1).max(TRACE_COMMENT_ID_MAX_LENGTH),
  row: z.number().int().nonnegative(),
  selectedText: z.string().min(1).max(TRACE_COMMENT_ANCHOR_TEXT_MAX_LENGTH),
  sourceText: z.string().max(TRACE_COMMENT_ANCHOR_TEXT_MAX_LENGTH),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  sessionId: z.string().max(TRACE_COMMENT_ID_MAX_LENGTH).nullable().optional(),
  actor: z.object(traceTextAnchorActorShape).nullable().optional(),
} satisfies Record<keyof TraceTextAnchor, z.ZodTypeAny>;

export const TRACE_TEXT_ANCHOR_OFFSET_ORDER_MESSAGE =
  "endOffset must be greater than or equal to startOffset";

export const traceTextAnchorSchema: z.ZodType<TraceTextAnchor> = z
  .object(traceTextAnchorShape)
  .refine(hasTraceTextAnchorOffsetOrder, {
    message: TRACE_TEXT_ANCHOR_OFFSET_ORDER_MESSAGE,
    path: ["endOffset"],
  });

/**
 * Shared validator for the optional @-mention user-ID list on a trace comment
 * transport (FEA-3490). Bounded, de-duplicated, and each id length-capped like
 * other trace ids. Org membership is NOT checked here (the wire type is
 * org-agnostic) — the API filters the list to the caller's organization on
 * persistence, so an id for another org is dropped rather than trusted.
 */
export const traceCommentMentionsSchema: z.ZodType<TraceCommentMentions> = z
  .array(z.string().min(1).max(TRACE_COMMENT_ID_MAX_LENGTH))
  .max(TRACE_COMMENT_MENTIONS_MAX)
  .transform((ids) => [...new Set(ids)]);

/**
 * Validates the optional stable client-supplied idempotency id on a trace
 * comment/reply create (FEA-3598). Length-capped like other trace ids. The API
 * dedups a retried desktop create onto the same server row via this id, so it
 * only needs to be stable per local row — the wire type does not constrain its
 * format.
 */
export const traceCommentClientIdSchema: z.ZodType<string> = z
  .string()
  .min(1)
  .max(TRACE_COMMENT_ID_MAX_LENGTH);

/**
 * Validates a known trace comment classification (FEA-4171) for internal/read
 * contexts where the value is already one of the known kinds. A missing value is
 * left absent; an unknown value is rejected. Do NOT use this at the external
 * write boundary — a newer client sending a future `kind` would then get the
 * whole POST rejected. Use {@link traceCommentDraftKindSchema} there, which
 * degrades an unknown classification to {@link TraceCommentKind.Comment} so a
 * classification-only version skew never blocks creating the underlying comment.
 */
export const traceCommentKindSchema: z.ZodType<TraceCommentKind> = z.union([
  z.literal(TraceCommentKind.Comment),
  z.literal(TraceCommentKind.ParsingBug),
]);

/**
 * Resolve a trace comment classification to a concrete {@link TraceCommentKind}
 * (FEA-4171). An absent value (a version-skewed older server or draft that
 * predates the field) or an unrecognized string defaults to
 * {@link TraceCommentKind.Comment}, so a value a consumer predates never surfaces
 * as a spurious parsing-bug candidate. This is the SSOT for the "missing/unknown
 * → Comment" default shared by EVERY boundary: the write draft schema below, the
 * API read mapper (`apps/api` trace-comments), and the desktop local store.
 */
export function normalizeTraceCommentKind(value: unknown): TraceCommentKind {
  return value === TraceCommentKind.ParsingBug
    ? TraceCommentKind.ParsingBug
    : TraceCommentKind.Comment;
}

/**
 * Tolerant classification validator for the external write boundary (the POST
 * draft; FEA-4171). Per the cross-repo compatibility contract, an unknown/future
 * `kind` from a newer client must degrade to a safe default rather than reject
 * the core flow. Delegates to {@link normalizeTraceCommentKind} (the SSOT) so the
 * write and read boundaries can never drift: a recognized kind passes through,
 * anything else becomes {@link TraceCommentKind.Comment}. A truly absent value
 * stays absent via `.optional()` at the use site.
 */
export const traceCommentDraftKindSchema: z.ZodType<TraceCommentKind> = z
  .unknown()
  .transform(normalizeTraceCommentKind);

/**
 * Field validators for the trace comment WRITE payloads, kept as standalone
 * literals so the keys-covered guard can see them. The rationale is the one
 * spelled out on {@link traceTextAnchorShape} above and is not repeated per
 * schema: `z.ZodType<T>` is covariant in its output, so the annotation alone
 * lets a schema omit an optional key of `T` with no error, and because these are
 * plain `z.object`s rather than `.strict()` the untaught key is silently
 * STRIPPED rather than rejected.
 *
 * On these three that lands on user content: a field added to
 * {@link TraceCommentDraft} but never taught here is dropped from every POST
 * body before persistence, so the comment is created without it and the client
 * sees a 201. `satisfies` makes that a `tsc` failure instead.
 */
const traceCommentDraftShape = {
  anchor: traceTextAnchorSchema,
  body: z.string().min(1).max(TRACE_COMMENT_BODY_MAX_LENGTH),
  mentions: traceCommentMentionsSchema.optional(),
  clientId: traceCommentClientIdSchema.optional(),
  kind: traceCommentDraftKindSchema.optional(),
} satisfies Record<keyof TraceCommentDraft, z.ZodTypeAny>;

const traceCommentReplyDraftShape = {
  body: z.string().min(1).max(TRACE_COMMENT_BODY_MAX_LENGTH),
  mentions: traceCommentMentionsSchema.optional(),
  clientId: traceCommentClientIdSchema.optional(),
} satisfies Record<keyof TraceCommentReplyDraft, z.ZodTypeAny>;

const traceCommentUpdateShape = {
  body: z.string().min(1).max(TRACE_COMMENT_BODY_MAX_LENGTH),
  mentions: traceCommentMentionsSchema.optional(),
} satisfies Record<keyof TraceCommentUpdate, z.ZodTypeAny>;

/** Validates a new root trace comment payload. */
export const traceCommentDraftSchema: z.ZodType<TraceCommentDraft> = z.object(
  traceCommentDraftShape
);

/** Validates a trace comment reply payload. */
export const traceCommentReplyDraftSchema: z.ZodType<TraceCommentReplyDraft> =
  z.object(traceCommentReplyDraftShape);

/** Validates a trace comment edit payload. */
export const traceCommentUpdateSchema: z.ZodType<TraceCommentUpdate> = z.object(
  traceCommentUpdateShape
);

/** Max plain-text length of a document-thread reply body (FEA-3950). */
export const DOCUMENT_THREAD_REPLY_BODY_MAX_LENGTH = 10_000;

/**
 * Body-only payload for replying to a document comment thread (FEA-3950).
 * Threading is flat: every reply attaches to the thread, so no `parentCommentId`
 * is accepted on the wire. Mirrors {@link TraceCommentReplyDraft} minus the
 * desktop idempotency/mention fields, which arrive in a later slice.
 */
export type DocumentThreadReplyDraft = {
  body: string;
};

const documentThreadReplyDraftShape = {
  body: z.string().min(1).max(DOCUMENT_THREAD_REPLY_BODY_MAX_LENGTH),
} satisfies Record<keyof DocumentThreadReplyDraft, z.ZodTypeAny>;

/** Validates a document-thread reply payload (FEA-3950). */
export const documentThreadReplyDraftSchema: z.ZodType<DocumentThreadReplyDraft> =
  z.object(documentThreadReplyDraftShape);

/** Canonical HTTP collection path for target-scoped trace comments. */
export function traceCommentsPath(target: TraceCommentTarget): string {
  const base = TRACE_COMMENT_COLLECTION_BASES[target.type];
  if (base === null) {
    throw new Error(`No trace-comment route serves a ${target.type} target.`);
  }
  return `${base}/${encodeURIComponent(target.id)}/trace-comments`;
}

/** Canonical HTTP member path for a root comment or reply id. */
export function traceCommentPath(
  target: TraceCommentTarget,
  commentId: string
): string {
  return `${traceCommentsPath(target)}/${encodeURIComponent(commentId)}`;
}

/** Canonical HTTP path for creating first-level replies under a trace comment. */
export function traceCommentRepliesPath(
  target: TraceCommentTarget,
  commentId: string
): string {
  return `${traceCommentPath(target, commentId)}/replies`;
}

/**
 * ISS-10382: canonical HTTP path for the author's recovery door on a
 * dead-lettered trace comment.
 *
 * Its own subpath rather than a field on the PATCH edit, because the two are
 * different acts by different rules. An edit replaces content the author wrote
 * and bumps `editedAt`; this changes only the row's delivery state and must NOT
 * touch the body or the edit stamp — the same reason the desktop store's retry
 * deliberately leaves `updated_at` alone.
 */
export function traceCommentRetrySyncPath(
  target: TraceCommentTarget,
  commentId: string
): string {
  return `${traceCommentPath(target, commentId)}/retry-sync`;
}

/**
 * ISS-10382: canonical HTTP path for reporting that a trace comment's delivery
 * has exhausted its terminal item budget.
 *
 * The producer half of the contract, and the reason the cloud can represent a
 * dead letter at all. A client that owns a delivery queue — today only the
 * desktop lane, which is the only place an item budget is charged — reports the
 * verdict here; the cloud stores it and every shell reading that comment can
 * then show its author the failure and the door.
 */
export function traceCommentSyncAbandonedPath(
  target: TraceCommentTarget,
  commentId: string
): string {
  return `${traceCommentPath(target, commentId)}/sync-abandoned`;
}

/**
 * Narrows an unknown value to a valid {@link DocumentThreadAnchorStatus}, or
 * `null` when it is not one of the known anchor-status literals. Used to
 * validate the explicit `metadata.anchorStatus` field before trusting it.
 */
function parseDocumentThreadAnchorStatus(
  value: unknown
): DocumentThreadAnchorStatus | null {
  if (
    value === DocumentThreadAnchorStatus.Anchored ||
    value === DocumentThreadAnchorStatus.Floating ||
    value === DocumentThreadAnchorStatus.ArtifactLevel
  ) {
    return value;
  }
  return null;
}

/**
 * Shared kernel for the legacy thread-anchor inference used by the document
 * comment feed (web) and the get-document-comments MCP tool. Given a thread's
 * `metadata.anchorStatus` and `metadata.anchorPreview`, it resolves the core
 * anchor status both surfaces agree on:
 *
 * - an explicit, validated `metadata.anchorStatus` wins; otherwise
 * - `anchorPreview` set (any defined value) → {@link DocumentThreadAnchorStatus.Anchored}; otherwise
 * - no signal → `null` (neutral).
 *
 * The `null` neutral is intentional: callers diverge on what "no signal" means
 * (the web feed maps it to `artifact-level`, the MCP tool leaves it `null` and
 * only after a `source === LIVEBLOCKS` gate), so each caller applies its own
 * fallback on top of this kernel rather than baking a fallback in here.
 */
export function resolveAnchorStatusKernel(input: {
  anchorStatus: unknown;
  anchorPreview: unknown;
}): DocumentThreadAnchorStatus | null {
  const explicit = parseDocumentThreadAnchorStatus(input.anchorStatus);
  if (explicit) {
    return explicit;
  }
  return input.anchorPreview === undefined
    ? null
    : DocumentThreadAnchorStatus.Anchored;
}

export function hasTraceTextAnchorOffsetOrder(
  anchor: Pick<TraceTextAnchor, "startOffset" | "endOffset">
): boolean {
  return anchor.endOffset >= anchor.startOffset;
}

/**
 * ISS-11113: canonical HTTP path for reading a target's root trace comment by
 * the `clientId` its create carried (FEA-3598). It answers the target's list
 * narrowed to that key — zero comments or one — and writes nothing, so a client
 * can learn whether a create it never heard back about landed without
 * re-sending it.
 */
export function traceCommentByClientIdPath(
  target: TraceCommentTarget,
  clientId: string
): string {
  return `${traceCommentsPath(target)}/by-client-id/${encodeURIComponent(clientId)}`;
}

/**
 * ISS-11113: the `maxDuration` the trace-comment collection routes declare, so
 * the platform ends a create no later than this after it starts. A client that
 * has stopped sending a create and reads its `clientId` back as absent can
 * believe that answer once it has stayed absent this long.
 */
export const TRACE_COMMENT_CREATE_MAX_DURATION_SECONDS = 300;

/**
 * ISS-11004: query param on a target's trace-comment GET naming one thread to
 * return even when it falls past the collection's thread cap, so an Activity
 * link to that thread still finds its card in the rail.
 */
export const TRACE_COMMENT_INCLUDE_THREAD_PARAM = "includeThreadId";

/** A thread id the {@link TRACE_COMMENT_INCLUDE_THREAD_PARAM} read accepts. */
export const traceCommentIncludeThreadIdSchema = z.uuid();

/** Document comments are served only by the unified routes (PLN-2187). */
const TRACE_COMMENT_COLLECTION_BASES = {
  [CommentTargetType.Session]: "/agent-sessions",
  [CommentTargetType.Branch]: "/branches",
  [CommentTargetType.Document]: null,
} as const satisfies Record<CommentTargetType, string | null>;

/** Whether the legacy trace-comment routes serve this target type. */
export function hasTraceCommentRoutes(type: CommentTargetType): boolean {
  return TRACE_COMMENT_COLLECTION_BASES[type] !== null;
}
