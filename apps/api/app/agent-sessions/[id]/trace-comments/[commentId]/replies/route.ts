import { TraceCommentTargetType } from "@repo/api/src/types/comment";
import { createTraceCommentsReplyPostHandler } from "@/app/trace-comments/route-handlers";

export const POST = createTraceCommentsReplyPostHandler(
  TraceCommentTargetType.Session
);
