import { CommentTargetType } from "@repo/api/src/types/comment";
import {
  createTraceCommentsDeleteHandler,
  createTraceCommentsPatchHandler,
} from "@/app/trace-comments/route-handlers";

export const PATCH = createTraceCommentsPatchHandler(CommentTargetType.Session);
export const DELETE = createTraceCommentsDeleteHandler(
  CommentTargetType.Session
);
