import {
  TRACE_COMMENT_LIST_MAX_LIMIT,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { z } from "zod";

/**
 * Query params for the org-scoped aggregate `GET /trace-comments` (FEA-3550).
 *
 * Every filter is optional. `resolved` narrows by thread status
 * (`false` → open, `true` → resolved); `targetType` narrows by session vs
 * branch; `authorId` narrows to threads opened by a user; `sessionId` narrows to
 * a single target artifact (the `artifactId`/`target.id` echoed on each row),
 * giving the same result as the per-session route without a fan-out.
 *
 * Pagination is offset-based: `cursor` is the opaque token echoed from a prior
 * response's `nextCursor` (it encodes the next offset) and takes precedence over
 * a raw `offset` when both are present.
 */
export const traceCommentListQuerySchema = z.object({
  resolved: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  targetType: z
    .enum([TraceCommentTargetType.Session, TraceCommentTargetType.Branch])
    .optional(),
  // `authorId`/`sessionId` filter uuid columns (`createdById`/`artifactId`), so
  // reject non-uuid input up front rather than letting Prisma throw at the DB.
  authorId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(TRACE_COMMENT_LIST_MAX_LIMIT)
    .optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  cursor: z.coerce.number().int().nonnegative().optional(),
});

export type TraceCommentListQuery = z.infer<typeof traceCommentListQuerySchema>;
