import { CommentTargetType } from "@repo/api/src/types/comment";
import { createTraceCommentsSyncAbandonedPostHandler } from "@/app/trace-comments/route-handlers";

export const POST = createTraceCommentsSyncAbandonedPostHandler(
  CommentTargetType.Branch
);
