import type { CommentSurface, ThreadStatus } from "@repo/api/src/types/comment";
import {
  type ArtifactCommentsResponse,
  artifactCommentsResponseSchema,
  type CommentThreadDto,
  type CreateCommentThreadRequest,
  commentApiPaths,
  commentThreadDtoSchema,
  type EditCommentRequest,
  type ReplyToCommentThreadRequest,
} from "@repo/api/src/types/comment-thread-dto";
import { z } from "zod";
import type { ApiRequestOptions } from "../api/api-timeout";

export type CommentsListOptions = {
  cursor?: string;
  surface?: CommentSurface;
  status?: ThreadStatus;
  signal?: AbortSignal;
};

/**
 * The unified comments API as the shared client sees it (PLN-2162 M2.1).
 * Every method is required: what the UI offers comes from the server's
 * capabilities and permissions, never from which methods a source has.
 * Realtime goes through `useSignals`, not through this port.
 */
export type CommentsDataSource = {
  /** One page; `targetId` is an artifact id, or a session id the server resolves. */
  list(
    targetId: string,
    options?: CommentsListOptions
  ): Promise<ArtifactCommentsResponse>;
  getThread(
    threadId: string,
    options?: { signal?: AbortSignal }
  ): Promise<CommentThreadDto>;
  createThread(
    artifactId: string,
    request: CreateCommentThreadRequest
  ): Promise<CommentThreadDto>;
  reply(
    threadId: string,
    request: ReplyToCommentThreadRequest
  ): Promise<CommentThreadDto>;
  update(
    commentId: string,
    request: EditCommentRequest
  ): Promise<CommentThreadDto>;
  delete(commentId: string): Promise<void>;
  resolve(threadId: string): Promise<CommentThreadDto>;
  reopen(threadId: string): Promise<CommentThreadDto>;
  retrySync(threadId: string): Promise<CommentThreadDto>;
};

/** The slice of `useApiClient()` the HTTP source needs; every body is validated, so it is `unknown`. */
export type CommentsHttpClient = {
  get(path: string, options?: ApiRequestOptions): Promise<unknown>;
  post(path: string, data: unknown): Promise<unknown>;
  patch(path: string, data: unknown): Promise<unknown>;
  delete(path: string): Promise<unknown>;
};

/**
 * A response that failed its schema: the read is a failure, never an empty
 * or partial list (PLN-2162 decision 2).
 */
export class CommentsResponseInvalidError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(issues: z.core.$ZodIssue[]) {
    super("The comments response did not match its contract.");
    this.name = "CommentsResponseInvalidError";
    this.issues = issues;
  }
}

/** The one source web and desktop share, over `useApiClient()` (PLN-2162 M2.2). */
export function createHttpCommentsDataSource(
  api: CommentsHttpClient
): CommentsDataSource {
  const thread = async (request: Promise<unknown>) =>
    validated(commentThreadDtoSchema, await request);
  return {
    list: async (targetId, options = {}) =>
      validated(
        artifactCommentsResponseSchema,
        await api.get(listPath(targetId, options), {
          cache: "no-store",
          ...(options.signal ? { signal: options.signal } : {}),
        })
      ),
    getThread: (threadId, options = {}) =>
      thread(
        api.get(commentApiPaths.thread(threadId), {
          cache: "no-store",
          ...(options.signal ? { signal: options.signal } : {}),
        })
      ),
    createThread: (artifactId, request) =>
      thread(api.post(commentApiPaths.artifactThreads(artifactId), request)),
    reply: (threadId, request) =>
      thread(api.post(commentApiPaths.threadReplies(threadId), request)),
    update: (commentId, request) =>
      thread(api.patch(commentApiPaths.comment(commentId), request)),
    delete: async (commentId) => {
      validated(
        deletedResponseSchema,
        await api.delete(commentApiPaths.comment(commentId))
      );
    },
    resolve: (threadId) =>
      thread(api.post(commentApiPaths.threadResolve(threadId), {})),
    reopen: (threadId) =>
      thread(api.post(commentApiPaths.threadReopen(threadId), {})),
    retrySync: (threadId) =>
      thread(api.post(commentApiPaths.threadRetrySync(threadId), {})),
  };
}

const deletedResponseSchema = z.object({ deleted: z.literal(true) });

function validated<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new CommentsResponseInvalidError(parsed.error.issues);
  }
  return parsed.data;
}

function listPath(targetId: string, options: CommentsListOptions): string {
  const query = new URLSearchParams();
  if (options.surface) {
    query.set("surface", options.surface);
  }
  if (options.status) {
    query.set("status", options.status);
  }
  if (options.cursor) {
    query.set("cursor", options.cursor);
  }
  const search = query.toString();
  const path = commentApiPaths.artifactComments(targetId);
  return search ? `${path}?${search}` : path;
}
