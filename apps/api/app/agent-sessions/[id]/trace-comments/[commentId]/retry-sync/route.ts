import { CommentTargetType } from "@repo/api/src/types/comment";
import { createTraceCommentsRetrySyncPostHandler } from "@/app/trace-comments/route-handlers";

export const POST = createTraceCommentsRetrySyncPostHandler(
  CommentTargetType.Session
);
