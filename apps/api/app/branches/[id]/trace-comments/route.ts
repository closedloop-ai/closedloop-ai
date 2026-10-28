import { CommentTargetType } from "@repo/api/src/types/comment";
import {
  createTraceCommentsGetHandler,
  createTraceCommentsPostHandler,
} from "@/app/trace-comments/route-handlers";

// ISS-11113: a literal, because Next reads segment config statically; pinned to
// `TRACE_COMMENT_CREATE_MAX_DURATION_SECONDS`, which the desktop's by-client-id
// read waits out before it believes a create never landed.
export const maxDuration = 300;

export const GET = createTraceCommentsGetHandler(CommentTargetType.Branch, {
  allowBranchSessions: true,
});
export const POST = createTraceCommentsPostHandler(CommentTargetType.Branch);
