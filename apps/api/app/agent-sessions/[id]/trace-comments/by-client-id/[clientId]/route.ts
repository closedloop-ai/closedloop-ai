import { CommentTargetType } from "@repo/api/src/types/comment";
import { createTraceCommentsGetHandler } from "@/app/trace-comments/route-handlers";

export const GET = createTraceCommentsGetHandler(CommentTargetType.Session);
