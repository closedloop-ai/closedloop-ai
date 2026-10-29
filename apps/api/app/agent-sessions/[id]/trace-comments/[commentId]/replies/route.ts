import { CommentTargetType } from "@repo/api/src/types/comment";
import { createTraceCommentsReplyPostHandler } from "@/app/trace-comments/route-handlers";

export const POST = createTraceCommentsReplyPostHandler(
  CommentTargetType.Session
);
