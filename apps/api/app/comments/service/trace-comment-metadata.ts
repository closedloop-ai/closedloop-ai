import {
  CommentSurface,
  CommentTargetType,
  TRACE_COMMENT_METADATA_KIND,
  TRACE_COMMENT_SCHEMA_VERSION,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import { Prisma } from "@repo/database";
import { z } from "zod";
import type { TraceCommentTargetRecord } from "@/app/comments/service/trace-comment-target-lookup";

/**
 * The fields the stored blob may carry, declared rather than inferred so the
 * shape below can be checked against it (ISS-10382).
 *
 * `commentKind` is `unknown` here as well as in the schema, which is
 * deliberate: a reader that wants a narrowed value goes through the normalizer
 * that owns it, so no call site can spend a stored value it has not validated.
 *
 * ISS-11212: the anchor lives in `CommentThread.anchor`, and `syncAbandoned` in
 * `CommentSyncState`.
 */
type TraceCommentMetadataFields = {
  kind: typeof TRACE_COMMENT_METADATA_KIND;
  schemaVersion: typeof TRACE_COMMENT_SCHEMA_VERSION;
  targetType: CommentTargetType;
  surface: CommentSurface;
  commentKind?: unknown;
};

/**
 * `satisfies Record<keyof T, z.ZodTypeAny>` so a field added to
 * {@link TraceCommentMetadataFields} fails `tsc` here rather than disappearing at
 * runtime. This is a plain `z.object`, not `.passthrough()`, so Zod STRIPS what
 * the shape does not name — an untaught field reads as absent on every hydrated
 * render, which is how a wire field goes missing with no test going red.
 */
const traceCommentMetadataShape = {
  kind: z.literal(TRACE_COMMENT_METADATA_KIND),
  schemaVersion: z.literal(TRACE_COMMENT_SCHEMA_VERSION),
  targetType: z.enum(CommentTargetType),
  surface: z.enum(CommentSurface),
  commentKind: z.unknown().optional(),
} satisfies Record<keyof TraceCommentMetadataFields, z.ZodTypeAny>;

/**
 * Validates the JSON `metadata` blob stored on a native trace-comment thread and
 * discriminates it from other thread kinds (`kind` === TRACE_COMMENT_METADATA_KIND).
 *
 * Read-tolerant on `commentKind` by design: it is `z.unknown()`, NOT the strict
 * `traceCommentKindSchema`. Under version skew a newer writer can store a future
 * `commentKind`; a strict validator here would fail the WHOLE parse and make an
 * otherwise-valid trace comment vanish from lists / 404 on reply/update/delete.
 * The classification must never gate thread validity — the mapper resolves it via
 * `normalizeTraceCommentKind` (unknown/absent → Comment), the same SSOT the write
 * draft schema uses (FEA-4171). Extracted from service.ts (FEA-4281).
 */
export const traceCommentMetadataSchema = z.object(traceCommentMetadataShape);

export type TraceCommentMetadata = z.infer<typeof traceCommentMetadataSchema>;

/**
 * Parses a stored thread `metadata` value into `TraceCommentMetadata`, or null
 * when it is not a native trace comment. A `Prisma.JsonNull` sentinel normalizes
 * to `null` before validation. Never throws.
 */
export function parseTraceCommentMetadata(
  value: unknown
): TraceCommentMetadata | null {
  const normalized = value === Prisma.JsonNull ? null : value;
  const result = traceCommentMetadataSchema.safeParse(normalized);
  return result.success ? result.data : null;
}

/**
 * The metadata a trace thread is created with. The anchor is not part of it; it
 * is written to the `anchor` column.
 */
export function buildTraceCommentMetadata(
  target: TraceCommentTargetRecord,
  commentKind?: TraceCommentKind
): Prisma.InputJsonObject {
  return {
    kind: TRACE_COMMENT_METADATA_KIND,
    schemaVersion: TRACE_COMMENT_SCHEMA_VERSION,
    targetType: target.target.type,
    surface: target.surface,
    // FEA-4171: persist the classification only when explicitly set. Omit the
    // key for a plain comment so the stored shape stays unchanged for the common
    // case and the mapper's default (`Comment`) covers both omission and older
    // rows. The metadata's own `kind` field is the trace-comment discriminator
    // (`TRACE_COMMENT_METADATA_KIND`); the classification is a distinct
    // `commentKind` field to avoid colliding with it.
    ...(commentKind && commentKind !== TraceCommentKind.Comment
      ? { commentKind }
      : {}),
  };
}
