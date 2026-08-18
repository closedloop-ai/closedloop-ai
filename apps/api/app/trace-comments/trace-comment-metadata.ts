import {
  TRACE_COMMENT_METADATA_KIND,
  TRACE_COMMENT_SCHEMA_VERSION,
  TraceCommentSurface,
  TraceCommentTargetType,
  traceTextAnchorSchema,
} from "@repo/api/src/types/comment";
import { Prisma } from "@repo/database";
import { z } from "zod";

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
export const traceCommentMetadataSchema = z.object({
  kind: z.literal(TRACE_COMMENT_METADATA_KIND),
  schemaVersion: z.literal(TRACE_COMMENT_SCHEMA_VERSION),
  targetType: z.union([
    z.literal(TraceCommentTargetType.Session),
    z.literal(TraceCommentTargetType.Branch),
  ]),
  surface: z.union([
    z.literal(TraceCommentSurface.SessionDetail),
    z.literal(TraceCommentSurface.BranchDetail),
    z.literal(TraceCommentSurface.BranchTimeline),
  ]),
  anchor: traceTextAnchorSchema,
  commentKind: z.unknown().optional(),
});

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
