import { TraceCommentTargetType } from "@repo/api/src/types/comment";
import {
  createTraceCommentsDeleteHandler,
  createTraceCommentsPatchHandler,
} from "@/app/trace-comments/route-handlers";

export const PATCH = createTraceCommentsPatchHandler(
  TraceCommentTargetType.Branch
);
export const DELETE = createTraceCommentsDeleteHandler(
  TraceCommentTargetType.Branch
);
