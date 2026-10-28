import { z } from "zod";
import {
  CommentSurface,
  normalizeTraceCommentKind,
  ThreadStatus,
  type TraceComment,
  type TraceCommentReply,
  traceCommentTargetSchema,
  traceTextAnchorSchema,
} from "./comment.ts";

const replyShape = {
  id: z.string(),
  threadId: z.string(),
  body: z.string(),
  mentions: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  editedAt: z.string().nullable(),
  authorId: z.string(),
  authorName: z.string().nullable(),
  authorAvatarUrl: z.string().nullable(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
} satisfies Record<keyof TraceCommentReply, z.ZodType>;

/** ISS-12282: validate the batch transport without stripping newer optional fields. */
export const traceCommentResponseSchema: z.ZodType<TraceComment> = z
  .object({
    ...replyShape,
    target: traceCommentTargetSchema,
    artifactId: z.string(),
    surface: z.enum(CommentSurface),
    kind: z.unknown().transform(normalizeTraceCommentKind),
    anchor: traceTextAnchorSchema,
    clientId: z.string().optional(),
    status: z.enum(ThreadStatus),
    resolvedAt: z.string().nullable(),
    resolvedById: z.string().nullable(),
    resolvedByName: z.string().nullable(),
    resolvedByAvatarUrl: z.string().nullable(),
    replies: z.array(z.object(replyShape).loose()).optional(),
    syncAbandoned: z.boolean().optional(),
  } satisfies Record<keyof TraceComment, z.ZodType>)
  .loose();

export const branchSessionTraceCommentsQuery = {
  surface: CommentSurface.BranchTimeline,
  includeSessions: "true",
} as const;
