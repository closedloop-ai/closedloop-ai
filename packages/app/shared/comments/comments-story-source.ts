import type { CollectionCapabilities } from "@repo/api/src/types/comment-capabilities";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import type {
  CommentsDataSource,
  CommentsListOptions,
} from "./comments-data-source";

/**
 * A read-only, in-memory port for stories of the connected panes: each list
 * answers from `read`, and every write is refused, so a play function proves
 * what the pane does with what it was given, never what a server did.
 */
export function storyCommentsSource({
  capabilities,
  read,
}: {
  capabilities: CollectionCapabilities;
  read: (
    targetId: string,
    options: CommentsListOptions
  ) => { artifactId: string; threads: CommentThreadDto[] };
}): CommentsDataSource {
  const refuse = () =>
    Promise.reject(new Error("Story comments are read-only."));
  return {
    list: (targetId, options = {}) =>
      Promise.resolve({
        ...read(targetId, options),
        capabilities,
        nextCursor: null,
      }),
    getThread: refuse,
    createThread: refuse,
    reply: refuse,
    update: refuse,
    delete: refuse,
    resolve: refuse,
    reopen: refuse,
    retrySync: refuse,
  };
}
