import { z } from "zod";

/**
 * The API → doc-sync command surface (PLN-2200, ISS-12506): `apps/api` calls
 * `/internal/documents/*` on the service's one port with its Vercel OIDC
 * token. Response schemas are non-strict, so a newer service adding a field
 * never breaks an older API.
 */
export const DocSyncDocumentCommand = {
  Clear: "clear",
  /** POST adds one anchor (ISS-12506); GET reads every mark (PLN-2187 T-3.2). */
  CommentAnchors: "comment-anchors",
  CommentAnchorsPlace: "comment-anchors/place",
  CommentAnchorsRename: "comment-anchors/rename",
  CommentAnchorsRemove: "comment-anchors/remove",
  Text: "text",
  SeedVersion: "seed-version",
  Disconnect: "disconnect",
  FirstOpenSeed: "first-open-seed",
  SeedIfNeverStored: "seed-if-never-stored",
} as const;
export type DocSyncDocumentCommand =
  (typeof DocSyncDocumentCommand)[keyof typeof DocSyncDocumentCommand];

export const DOC_SYNC_INTERNAL_DOCUMENTS_PATH = "/internal/documents";

/**
 * True when `documentName` is one RFC 3986 path segment with no
 * percent-encoding, and not `.` or `..`. The service routes on the raw
 * request path, so a name is never percent-encoded on the wire. A canonical
 * room id (`{orgId}:artifact:{slug}`) always passes.
 */
export function isAddressableDocumentName(documentName: string): boolean {
  return (
    ADDRESSABLE_SEGMENT.test(documentName) &&
    documentName !== "." &&
    documentName !== ".."
  );
}

/** The command path for `documentName`; `undefined` when the name cannot be addressed. */
export function docSyncDocumentPath(
  documentName: string,
  command?: DocSyncDocumentCommand
): string | undefined {
  if (!isAddressableDocumentName(documentName)) {
    return;
  }
  const documentPath = `${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}/${documentName}`;
  return command === undefined ? documentPath : `${documentPath}/${command}`;
}

export const DocSyncInternalErrorCode = {
  InvalidDocumentName: "invalid_document_name",
  DocumentDeleted: "document_deleted",
  AnchorNotFound: "anchor_not_found",
  AnchorAmbiguous: "anchor_ambiguous",
  /**
   * The delete's 503: the document did not unload in time. The name is still
   * tombstoned for the document token's lifetime (`REALTIME_TOKEN_TTL_SECONDS`):
   * connections are refused, stores are dropped and every other command
   * answers 410 `document_deleted`, while the stored row is kept. The caller
   * retries the delete; it never rolls the delete back.
   */
  UnloadTimeout: "unload_timeout",
} as const;
export type DocSyncInternalErrorCode =
  (typeof DocSyncInternalErrorCode)[keyof typeof DocSyncInternalErrorCode];

/** What changed a document: a client connection, or a command's direct connection. */
export const DocSyncChangeSource = {
  Connection: "connection",
  Clear: "clear",
  CommentAnchor: "comment-anchor",
  /** Set by PLN-2190's seed-version command; declared here so the change callback covers it. */
  SeedVersion: "seed-version",
} as const;
export type DocSyncChangeSource =
  (typeof DocSyncChangeSource)[keyof typeof DocSyncChangeSource];

export const DOC_SYNC_LIST_MAX_LIMIT = 1000;
export const DOC_SYNC_LIST_DEFAULT_LIMIT = 500;

export const commentAnchorRequestSchema = z.strictObject({
  threadId: z.string().min(1),
  anchorText: z.string().min(1),
});
export type CommentAnchorRequest = z.infer<typeof commentAnchorRequestSchema>;

export const listDocumentsQuerySchema = z.object({
  after: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(DOC_SYNC_LIST_MAX_LIMIT)
    .default(DOC_SYNC_LIST_DEFAULT_LIMIT),
});
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;

export const clearResponseSchema = z.object({ cleared: z.boolean() });
export type ClearResponse = z.infer<typeof clearResponseSchema>;

export const commentAnchorResponseSchema = z.object({
  anchored: z.literal(true),
});
export type CommentAnchorResponse = z.infer<typeof commentAnchorResponseSchema>;

export const commentAnchorRefusalSchema = z.object({
  code: z.enum([
    DocSyncInternalErrorCode.AnchorNotFound,
    DocSyncInternalErrorCode.AnchorAmbiguous,
  ]),
  matchCount: z.number().int().nonnegative(),
});
export type CommentAnchorRefusal = z.infer<typeof commentAnchorRefusalSchema>;

export const readTextResponseSchema = z.object({ text: z.string() });
export type ReadTextResponse = z.infer<typeof readTextResponseSchema>;

export const deleteResponseSchema = z.object({
  deleted: z.boolean(),
  wasLoaded: z.boolean(),
});
export type DeleteResponse = z.infer<typeof deleteResponseSchema>;

export const listDocumentsResponseSchema = z.object({
  names: z.array(z.string()),
  nextAfter: z.string().nullable(),
});
export type ListDocumentsResponse = z.infer<typeof listDocumentsResponseSchema>;

/**
 * What a seed does with a version equal to the document's last seeded one.
 * `Publish` skips it, so a retried publish whose first attempt landed is a
 * no-op; `Reset` applies it, resetting the draft to the latest version
 * (PLN-2190 T-3.2).
 */
export const SeedVersionMode = { Publish: "publish", Reset: "reset" } as const;
export type SeedVersionMode =
  (typeof SeedVersionMode)[keyof typeof SeedVersionMode];

/** PLN-2190: a published version's markdown, applied to the live document as a diff. */
export const seedVersionRequestSchema = z.strictObject({
  markdown: z.string(),
  version: z.number().int().positive(),
  /** Omitted means `Publish`. */
  mode: z.enum([SeedVersionMode.Publish, SeedVersionMode.Reset]).optional(),
});
export type SeedVersionRequest = z.infer<typeof seedVersionRequestSchema>;

/**
 * `stale` when the document already holds a newer seeded version, or this one
 * outside `Reset` mode, so nothing was applied; `updateBytes` is the size of
 * the Yjs update the seed produced.
 */
export const seedVersionResponseSchema = z.object({
  applied: z.boolean(),
  stale: z.boolean(),
  updateBytes: z.number().int().nonnegative(),
});
export type SeedVersionResponse = z.infer<typeof seedVersionResponseSchema>;

/**
 * ISS-12508 (PLN-2229): the first-open seed's probe answer. The API probes
 * with the room alone, and only on `NeedsSeed` reads the latest version and
 * sends {@link seedIfNeverStoredRequestSchema}. The probe is advisory; the
 * apply re-checks everything.
 */
export const FirstOpenSeedState = {
  Stored: "stored",
  InMemoryNotSeedable: "in-memory-not-seedable",
  NeedsSeed: "needs-seed",
} as const;
export type FirstOpenSeedState =
  (typeof FirstOpenSeedState)[keyof typeof FirstOpenSeedState];

/**
 * `state` is an open string, so a newer service's state never fails an older
 * API; the API narrows it against {@link FirstOpenSeedState} and treats any
 * other value as nothing to seed.
 */
export const firstOpenSeedProbeResponseSchema = z.object({
  state: z.string(),
});
export type FirstOpenSeedProbeResponse = z.infer<
  typeof firstOpenSeedProbeResponseSchema
>;

/** The latest version's markdown, applied only to a document never stored and untouched since its load. */
export const seedIfNeverStoredRequestSchema = z.strictObject({
  markdown: z.string().min(1),
  version: z.number().int().positive(),
});
export type SeedIfNeverStoredRequest = z.infer<
  typeof seedIfNeverStoredRequestSchema
>;

export const seedIfNeverStoredResponseSchema = z.object({
  applied: z.boolean(),
  updateBytes: z.number().int().nonnegative(),
});
export type SeedIfNeverStoredResponse = z.infer<
  typeof seedIfNeverStoredResponseSchema
>;

/**
 * PLN-2201: the revoke's path. Its body is `internalRevokeBodySchema` from
 * `./internal`, realtime's own, so the API can send one target to both services.
 */
export const DOC_SYNC_REVOKE_PATH = "/internal/revoke";

/** What a revoke or a forced disconnect closed. */
export const closedConnectionsResponseSchema = z.object({
  closedConnections: z.number().int().nonnegative(),
});
export type ClosedConnectionsResponse = z.infer<
  typeof closedConnectionsResponseSchema
>;

/**
 * PLN-2200 T-7.1: the doc-sync → API change callback, posted after each
 * successful store. The API answers it 202 with the `callbackId`.
 */
export const DOC_SYNC_CHANGES_PATH = "/doc-sync/changes";

export const DOC_SYNC_CALLBACK_MAX_EDITORS = 100;
export const DOC_SYNC_CALLBACK_MAX_MENTIONS = 500;
export const DOC_SYNC_CALLBACK_MAX_ID_LENGTH = 64;
/** The most of a callback body the API reads; it answers 413 past it. */
export const DOC_SYNC_CALLBACK_MAX_BODY_BYTES = 65_536;

const CALLBACK_ID_CHARACTERS = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/**
 * An editor or mention id: printable ASCII other than space, `"` and `\`, so each
 * character is one byte of JSON and the caps above keep every callback under
 * {@link DOC_SYNC_CALLBACK_MAX_BODY_BYTES}. doc-sync leaves out an id that
 * fails it rather than send a body the API refuses.
 */
export const docSyncCallbackIdSchema = z
  .string()
  .max(DOC_SYNC_CALLBACK_MAX_ID_LENGTH)
  .regex(CALLBACK_ID_CHARACTERS);

export const DocSyncMentionKind = { User: "user", Group: "group" } as const;
export type DocSyncMentionKind =
  (typeof DocSyncMentionKind)[keyof typeof DocSyncMentionKind];

/**
 * A version-skewed wire contract: unknown fields are stripped, and `sources`
 * takes any string, so a newer doc-sync never breaks an older API. A field
 * added later must be optional. No document text travels; mentions carry ids
 * only.
 */
export const docSyncChangeCallbackSchema = z.object({
  /** Fresh per callback and kept across its retries, so the API can dedupe. */
  callbackId: z.uuid(),
  documentName: z.string().min(1),
  /** `DocSyncChangeSource` values; an unknown one is accepted and ignored. */
  sources: z.array(z.string()),
  editorUserIds: z
    .array(docSyncCallbackIdSchema)
    .max(DOC_SYNC_CALLBACK_MAX_EDITORS),
  firstChangedAt: z.iso.datetime(),
  lastChangedAt: z.iso.datetime(),
  /** The document's mentions after the change, deduped, in document order. */
  mentions: z
    .array(
      z.object({
        kind: z.enum([DocSyncMentionKind.User, DocSyncMentionKind.Group]),
        id: docSyncCallbackIdSchema,
      })
    )
    .max(DOC_SYNC_CALLBACK_MAX_MENTIONS),
  /** More distinct mentions exist than `mentions` holds. */
  mentionsTruncated: z.boolean(),
});
export type DocSyncChangeCallback = z.infer<typeof docSyncChangeCallbackSchema>;
export type DocSyncMention = DocSyncChangeCallback["mentions"][number];

/**
 * Q-001 default A (STS caller identity): doc-sync SigV4-presigns an STS
 * `GetCallerIdentity` request with its task role, binding these headers into
 * the signature, and the API replays it to STS. No secret travels.
 */
export const DocSyncCallbackHeader = {
  /** Signed; always {@link DOC_SYNC_CALLBACK_AUDIENCE}. */
  Audience: "x-closedloop-audience",
  /** Signed; the hex SHA-256 of the request body. */
  BodySha256: "x-closedloop-body-sha256",
  /** The presigned STS URL the API replays. */
  StsUrl: "x-closedloop-sts-url",
} as const;
export type DocSyncCallbackHeader =
  (typeof DocSyncCallbackHeader)[keyof typeof DocSyncCallbackHeader];

export const DOC_SYNC_CALLBACK_AUDIENCE = "doc-sync-callback";

/** The presigned request's lifetime, which STS enforces on the replay. */
export const DOC_SYNC_CALLBACK_SIGNATURE_TTL_SECONDS = 60;

/** The presigned STS request's query, before the SigV4 parameters. */
export const STS_GET_CALLER_IDENTITY_QUERY = {
  Action: "GetCallerIdentity",
  Version: "2011-06-15",
} as const;

/**
 * `arn:{partition}:sts::{account}:assumed-role/{roleName}/`: the ARN STS
 * reports for a session of the IAM role `roleArn`, which drops the role's
 * path. `undefined` when `roleArn` is not a role ARN, a trailing slash
 * included.
 */
export function assumedRoleArnPrefix(roleArn: string): string | undefined {
  const match = IAM_ROLE_ARN_PARTS.exec(roleArn);
  if (match === null) {
    return;
  }
  const [, partition, account, roleName] = match;
  return `arn:${partition}:sts::${account}:assumed-role/${roleName}/`;
}

/**
 * PLN-2187 T-3.2: the comment-anchor commands. A quote's `prefix` and
 * `suffix` and a `position` are in the document's flattened text
 * (`@repo/document-schema/comment-anchor-flatten`).
 */
export const COMMENT_ANCHORS_PLACE_MAX = 100;
export const COMMENT_ANCHORS_RENAME_MAX = 500;
export const COMMENT_ANCHORS_REMOVE_MAX = 100;

/** `full` first removes the listed threads' marks; `missing` keeps a thread's existing mark. */
export const CommentAnchorPlaceMode = {
  Missing: "missing",
  Full: "full",
} as const;
export type CommentAnchorPlaceMode =
  (typeof CommentAnchorPlaceMode)[keyof typeof CommentAnchorPlaceMode];

/** Where a placed anchor landed; the values are `CommentAnchorState`'s in `@repo/api`. */
export const CommentAnchorPlacementState = {
  Anchored: "ANCHORED",
  Moved: "MOVED",
  Orphaned: "ORPHANED",
} as const;
export type CommentAnchorPlacementState =
  (typeof CommentAnchorPlacementState)[keyof typeof CommentAnchorPlacementState];

const commentAnchorThreadIdSchema = z.string().min(1);

const commentAnchorQuoteShape = {
  exact: z.string().min(1),
  prefix: z.string(),
  suffix: z.string(),
};

const commentAnchorOffsetSchema = z.number().int().nonnegative();
const commentAnchorPositionShape = {
  start: commentAnchorOffsetSchema,
  end: commentAnchorOffsetSchema,
};
const hasPositionOrder = (position: { start: number; end: number }) =>
  position.end >= position.start;
const POSITION_ORDER_MESSAGE = "end must not precede start";

const commentAnchorQuoteSchema = z.object(commentAnchorQuoteShape);
const commentAnchorPositionSchema = z
  .object(commentAnchorPositionShape)
  .refine(hasPositionOrder, POSITION_ORDER_MESSAGE);

export type CommentAnchorQuote = z.infer<typeof commentAnchorQuoteSchema>;
export type CommentAnchorPosition = z.infer<typeof commentAnchorPositionSchema>;

export const readCommentAnchorsResponseSchema = z.object({
  marks: z.array(
    z.object({
      threadId: commentAnchorThreadIdSchema,
      quote: commentAnchorQuoteSchema,
      position: commentAnchorPositionSchema,
      orphan: z.boolean(),
    })
  ),
});
export type ReadCommentAnchorsResponse = z.infer<
  typeof readCommentAnchorsResponseSchema
>;

export const placeCommentAnchorsRequestSchema = z.strictObject({
  mode: z.enum(CommentAnchorPlaceMode),
  anchors: z
    .array(
      z.strictObject({
        threadId: commentAnchorThreadIdSchema,
        quote: z.strictObject(commentAnchorQuoteShape),
        position: z
          .strictObject(commentAnchorPositionShape)
          .refine(hasPositionOrder, POSITION_ORDER_MESSAGE)
          .optional(),
      })
    )
    .min(1)
    .max(COMMENT_ANCHORS_PLACE_MAX)
    .refine(
      (anchors) => isEachDistinct(anchors.map(({ threadId }) => threadId)),
      "a threadId must not repeat"
    ),
});
export type PlaceCommentAnchorsRequest = z.infer<
  typeof placeCommentAnchorsRequestSchema
>;

/** `quote` and `position` accompany a placed anchor; an orphaned one carries neither. */
export const placeCommentAnchorsResponseSchema = z.object({
  results: z.array(
    z.object({
      threadId: commentAnchorThreadIdSchema,
      state: z.enum(CommentAnchorPlacementState),
      quote: commentAnchorQuoteSchema.optional(),
      position: commentAnchorPositionSchema.optional(),
    })
  ),
});
export type PlaceCommentAnchorsResponse = z.infer<
  typeof placeCommentAnchorsResponseSchema
>;

export const renameCommentAnchorsRequestSchema = z.strictObject({
  mapping: z
    .array(
      z.strictObject({
        from: commentAnchorThreadIdSchema,
        to: commentAnchorThreadIdSchema,
      })
    )
    .min(1)
    .max(COMMENT_ANCHORS_RENAME_MAX)
    .refine(
      (mapping) => isEachDistinct(mapping.map(({ from }) => from)),
      "a from id must not repeat"
    ),
});
export type RenameCommentAnchorsRequest = z.infer<
  typeof renameCommentAnchorsRequestSchema
>;

/** The `from` ids that had a mark. */
export const renameCommentAnchorsResponseSchema = z.object({
  renamed: z.array(commentAnchorThreadIdSchema),
});
export type RenameCommentAnchorsResponse = z.infer<
  typeof renameCommentAnchorsResponseSchema
>;

export const removeCommentAnchorsRequestSchema = z.strictObject({
  threadIds: z
    .array(commentAnchorThreadIdSchema)
    .min(1)
    .max(COMMENT_ANCHORS_REMOVE_MAX),
});
export type RemoveCommentAnchorsRequest = z.infer<
  typeof removeCommentAnchorsRequestSchema
>;

/** The listed ids that had a mark. */
export const removeCommentAnchorsResponseSchema = z.object({
  removed: z.array(commentAnchorThreadIdSchema),
});
export type RemoveCommentAnchorsResponse = z.infer<
  typeof removeCommentAnchorsResponseSchema
>;

/** RFC 3986 `pchar` without `%`: unreserved, sub-delims, `:` and `@`. */
const ADDRESSABLE_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/;
const IAM_ROLE_ARN_PARTS =
  /^arn:(aws[\w-]*):iam::(\d{12}):role\/(?:[^/]+\/)*([^/]+)$/;

function isEachDistinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
