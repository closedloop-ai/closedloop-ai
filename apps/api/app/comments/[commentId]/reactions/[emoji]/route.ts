import {
  createCommentReactionDeleteHandler,
  createCommentReactionPutHandler,
} from "@/app/comments/unified-route-handlers";

export const PUT = createCommentReactionPutHandler();
export const DELETE = createCommentReactionDeleteHandler();
