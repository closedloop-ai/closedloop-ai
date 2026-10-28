import {
  createCommentDeleteHandler,
  createCommentPatchHandler,
} from "@/app/comments/unified-route-handlers";

export const PATCH = createCommentPatchHandler();
export const DELETE = createCommentDeleteHandler();
