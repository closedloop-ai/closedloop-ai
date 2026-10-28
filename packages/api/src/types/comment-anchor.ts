import { z } from "zod";
import {
  hasTraceTextAnchorOffsetOrder,
  TRACE_COMMENT_ANCHOR_TEXT_MAX_LENGTH,
  TRACE_COMMENT_ID_MAX_LENGTH,
  TRACE_TEXT_ANCHOR_OFFSET_ORDER_MESSAGE,
  type TraceTextAnchor,
  traceTextAnchorShape,
} from "./comment.ts";
import { CommentAnchorKind } from "./comment-anchor-kind.ts";

/** Server-computed placement of a thread's anchor against the current artifact. */
export const CommentAnchorState = {
  Anchored: "ANCHORED",
  Moved: "MOVED",
  Outdated: "OUTDATED",
  Orphaned: "ORPHANED",
} as const;
export type CommentAnchorState =
  (typeof CommentAnchorState)[keyof typeof CommentAnchorState];

export const CodeCommentSide = {
  Left: "left",
  Right: "right",
} as const;
export type CodeCommentSide =
  (typeof CodeCommentSide)[keyof typeof CodeCommentSide];

/** Version of the `{ v, ...anchor }` envelope stored in `CommentThread.anchor`. */
export const COMMENT_ANCHOR_SCHEMA_VERSION = 1 as const;

export const COMMENT_ANCHOR_PATH_MAX_LENGTH = 4096;

export type CommentAnchorArtifact = {
  kind: typeof CommentAnchorKind.Artifact;
};

export type CommentAnchorTextQuote = {
  exact: string;
  prefix: string;
  suffix: string;
};

export type CommentAnchorTextPosition = {
  start: number;
  end: number;
};

export type CommentAnchorText = {
  kind: typeof CommentAnchorKind.Text;
  documentVersion: number;
  quote: CommentAnchorTextQuote;
  position?: CommentAnchorTextPosition;
};

export type CommentAnchorTrace = {
  kind: typeof CommentAnchorKind.Trace;
} & TraceTextAnchor;

/**
 * `endLine` is `null` when GitHub reports the comment as outdated (`line: null`);
 * the thread's `anchorState` carries that as `OUTDATED`.
 */
export type CommentAnchorCode = {
  kind: typeof CommentAnchorKind.Code;
  repository: string;
  commitSha: string;
  path: string;
  side: CodeCommentSide;
  startLine?: number;
  startSide?: CodeCommentSide;
  endLine: number | null;
  originalEndLine?: number;
};

export type CommentAnchorPoint = {
  x: number;
  y: number;
};

export type CommentAnchorSize = {
  width: number;
  height: number;
};

export type CommentAnchorRect = CommentAnchorPoint & CommentAnchorSize;

/** Identity is `prototypeVersionId` + `route` + `anchorId`; geometry is diagnostic only. */
export type CommentAnchorPrototype = {
  kind: typeof CommentAnchorKind.Prototype;
  prototypeVersionId: string;
  route: string;
  anchorId: string;
  selector?: string;
  domPath?: string;
  textContext?: string;
  normalizedPosition?: CommentAnchorPoint;
  originalRect?: CommentAnchorRect;
  viewport?: CommentAnchorSize;
};

export type CommentAnchorByKind = {
  [CommentAnchorKind.Artifact]: CommentAnchorArtifact;
  [CommentAnchorKind.Text]: CommentAnchorText;
  [CommentAnchorKind.Trace]: CommentAnchorTrace;
  [CommentAnchorKind.Code]: CommentAnchorCode;
  [CommentAnchorKind.Prototype]: CommentAnchorPrototype;
};

export type CommentAnchor = CommentAnchorByKind[CommentAnchorKind];

export type StoredCommentAnchor = CommentAnchor & {
  v: typeof COMMENT_ANCHOR_SCHEMA_VERSION;
};

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export const commentAnchorKindSchema = z.enum(CommentAnchorKind);
export const commentAnchorStateSchema = z.enum(CommentAnchorState);
const codeCommentSideSchema = z.enum(CodeCommentSide);

const anchorIdSchema = z.string().min(1).max(TRACE_COMMENT_ID_MAX_LENGTH);
const anchorTextSchema = z.string().max(TRACE_COMMENT_ANCHOR_TEXT_MAX_LENGTH);
const lineNumberSchema = z.number().int().positive();
const offsetSchema = z.number().int().nonnegative();

const artifactShape = {
  kind: z.literal(CommentAnchorKind.Artifact),
} satisfies Record<keyof CommentAnchorArtifact, z.ZodTypeAny>;

const textQuoteShape = {
  exact: anchorTextSchema.min(1),
  prefix: anchorTextSchema,
  suffix: anchorTextSchema,
} satisfies Record<keyof CommentAnchorTextQuote, z.ZodTypeAny>;

const textPositionShape = {
  start: offsetSchema,
  end: offsetSchema,
} satisfies Record<keyof CommentAnchorTextPosition, z.ZodTypeAny>;

const textShape = {
  kind: z.literal(CommentAnchorKind.Text),
  documentVersion: z.number().int().positive(),
  quote: z.object(textQuoteShape),
  position: z.object(textPositionShape).optional(),
} satisfies Record<keyof CommentAnchorText, z.ZodTypeAny>;

const traceShape = {
  kind: z.literal(CommentAnchorKind.Trace),
  ...traceTextAnchorShape,
} satisfies Record<keyof CommentAnchorTrace, z.ZodTypeAny>;

const codeShape = {
  kind: z.literal(CommentAnchorKind.Code),
  repository: z.string().min(1).max(TRACE_COMMENT_ID_MAX_LENGTH),
  commitSha: z.string().regex(COMMIT_SHA_PATTERN),
  path: z.string().min(1).max(COMMENT_ANCHOR_PATH_MAX_LENGTH),
  side: codeCommentSideSchema,
  startLine: lineNumberSchema.optional(),
  startSide: codeCommentSideSchema.optional(),
  endLine: lineNumberSchema.nullable(),
  originalEndLine: lineNumberSchema.optional(),
} satisfies Record<keyof CommentAnchorCode, z.ZodTypeAny>;

const pointShape = {
  x: z.number(),
  y: z.number(),
} satisfies Record<keyof CommentAnchorPoint, z.ZodTypeAny>;

const sizeShape = {
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
} satisfies Record<keyof CommentAnchorSize, z.ZodTypeAny>;

const rectShape = {
  ...pointShape,
  ...sizeShape,
} satisfies Record<keyof CommentAnchorRect, z.ZodTypeAny>;

const prototypeShape = {
  kind: z.literal(CommentAnchorKind.Prototype),
  prototypeVersionId: anchorIdSchema,
  route: z.string().min(1).max(COMMENT_ANCHOR_PATH_MAX_LENGTH),
  anchorId: anchorIdSchema,
  selector: anchorTextSchema.optional(),
  domPath: anchorTextSchema.optional(),
  textContext: anchorTextSchema.optional(),
  normalizedPosition: z.object(pointShape).optional(),
  originalRect: z.object(rectShape).optional(),
  viewport: z.object(sizeShape).optional(),
} satisfies Record<keyof CommentAnchorPrototype, z.ZodTypeAny>;

const commentAnchorVariantSchemas = {
  [CommentAnchorKind.Artifact]: z.object(artifactShape),
  [CommentAnchorKind.Text]: z.object(textShape),
  [CommentAnchorKind.Trace]: z.object(traceShape),
  [CommentAnchorKind.Code]: z.object(codeShape),
  [CommentAnchorKind.Prototype]: z.object(prototypeShape),
} satisfies Record<CommentAnchorKind, z.ZodTypeAny>;

export const commentAnchorSchema: z.ZodType<CommentAnchor> = z
  .discriminatedUnion("kind", [
    commentAnchorVariantSchemas[CommentAnchorKind.Artifact],
    commentAnchorVariantSchemas[CommentAnchorKind.Text],
    commentAnchorVariantSchemas[CommentAnchorKind.Trace],
    commentAnchorVariantSchemas[CommentAnchorKind.Code],
    commentAnchorVariantSchemas[CommentAnchorKind.Prototype],
  ])
  .superRefine((anchor, ctx) => {
    if (
      anchor.kind === CommentAnchorKind.Trace &&
      !hasTraceTextAnchorOffsetOrder(anchor)
    ) {
      ctx.addIssue({
        code: "custom",
        message: TRACE_TEXT_ANCHOR_OFFSET_ORDER_MESSAGE,
        path: ["endOffset"],
      });
    }
    if (
      anchor.kind === CommentAnchorKind.Text &&
      anchor.position &&
      anchor.position.end < anchor.position.start
    ) {
      ctx.addIssue({
        code: "custom",
        message: "position.end must be greater than or equal to position.start",
        path: ["position", "end"],
      });
    }
    if (anchor.kind === CommentAnchorKind.Code) {
      addCodeAnchorLineIssues(anchor, ctx);
    }
  });

const storedCommentAnchorVersionSchema = z.object({
  v: z.literal(COMMENT_ANCHOR_SCHEMA_VERSION),
});

/** Shape of the `CommentThread.anchor` column. */
export const storedCommentAnchorSchema: z.ZodType<StoredCommentAnchor> =
  z.intersection(storedCommentAnchorVersionSchema, commentAnchorSchema);

export function toStoredCommentAnchor(
  anchor: CommentAnchor
): StoredCommentAnchor {
  return { ...anchor, v: COMMENT_ANCHOR_SCHEMA_VERSION };
}

/**
 * Reads a stored anchor column. `absent` is a column not yet backfilled,
 * `unknown_version` an envelope newer than this build, and `invalid` a corrupt
 * value; the caller reports the last two rather than coercing them.
 */
export function parseStoredCommentAnchor(
  value: unknown
): StoredCommentAnchorRead {
  if (value === null || value === undefined) {
    return { status: StoredCommentAnchorReadStatus.Absent };
  }
  const envelope = storedCommentAnchorEnvelopeProbeSchema.safeParse(value);
  if (!envelope.success) {
    return { status: StoredCommentAnchorReadStatus.Invalid };
  }
  if (envelope.data.v > COMMENT_ANCHOR_SCHEMA_VERSION) {
    return {
      status: StoredCommentAnchorReadStatus.UnknownVersion,
      version: envelope.data.v,
    };
  }
  const anchor = storedCommentAnchorSchema.safeParse(value);
  if (anchor.success) {
    const { v: _version, ...parsed } = anchor.data;
    return { status: StoredCommentAnchorReadStatus.Valid, anchor: parsed };
  }
  return { status: StoredCommentAnchorReadStatus.Invalid };
}

export function traceTextAnchorToCommentAnchor(
  anchor: TraceTextAnchor
): CommentAnchorTrace {
  return { ...anchor, kind: CommentAnchorKind.Trace };
}

export const StoredCommentAnchorReadStatus = {
  Absent: "absent",
  Valid: "valid",
  UnknownVersion: "unknown_version",
  Invalid: "invalid",
} as const;
export type StoredCommentAnchorReadStatus =
  (typeof StoredCommentAnchorReadStatus)[keyof typeof StoredCommentAnchorReadStatus];

export type StoredCommentAnchorRead =
  | { status: typeof StoredCommentAnchorReadStatus.Absent }
  | {
      status: typeof StoredCommentAnchorReadStatus.Valid;
      anchor: CommentAnchor;
    }
  | {
      status: typeof StoredCommentAnchorReadStatus.UnknownVersion;
      version: number;
    }
  | { status: typeof StoredCommentAnchorReadStatus.Invalid };

const storedCommentAnchorEnvelopeProbeSchema = z.object({
  v: z.number().int().positive(),
});

/**
 * GitHub numbers lines per diff side, so the order check applies only when
 * the range starts and ends on the same side.
 */
function addCodeAnchorLineIssues(
  anchor: CommentAnchorCode,
  ctx: z.RefinementCtx
): void {
  if (anchor.startSide !== undefined && anchor.startLine === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "startSide requires startLine",
      path: ["startLine"],
    });
  }
  const sameSide =
    anchor.startSide === undefined || anchor.startSide === anchor.side;
  if (
    sameSide &&
    anchor.startLine !== undefined &&
    anchor.endLine !== null &&
    anchor.startLine > anchor.endLine
  ) {
    ctx.addIssue({
      code: "custom",
      message: "startLine must be less than or equal to endLine",
      path: ["startLine"],
    });
  }
}
