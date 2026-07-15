import { TraceCommentTargetType } from "@repo/api/src/types/comment";
import {
  createTraceCommentsGetHandler,
  createTraceCommentsPostHandler,
} from "@/app/trace-comments/route-handlers";

export const GET = createTraceCommentsGetHandler(
  TraceCommentTargetType.Session
);
export const POST = createTraceCommentsPostHandler(
  TraceCommentTargetType.Session
);
