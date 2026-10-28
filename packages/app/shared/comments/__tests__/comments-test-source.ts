import type {
  ArtifactCommentsResponse,
  CommentThreadDto,
} from "@repo/api/src/types/comment-thread-dto";
import { vi } from "vitest";
import {
  FULL_CAPABILITIES,
  makeThread,
} from "../../components/comments/comments-pane.fixtures";
import type { CommentsDataSource } from "../comments-data-source";

export const ORG_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
export const ARTIFACT_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60";

/** The n-th thread id: a UUID, as signals carry, ordered by n. */
export function threadId(index: number): string {
  return `0190a1b2-c3d4-7e5f-8a9b-${String(index).padStart(12, "0")}`;
}

/** `count` threads in the server's `(createdAt, id)` order. */
export function threadsOf(count: number): CommentThreadDto[] {
  return Array.from({ length: count }, (_, index) =>
    makeThread({ id: threadId(index), artifactId: ARTIFACT_ID })
  );
}

/** Pages `threads` 50 at a time, as the list route does. */
export function pagedList(
  threads: readonly CommentThreadDto[],
  over: Partial<ArtifactCommentsResponse> = {}
): CommentsDataSource["list"] {
  return (_targetId, options = {}) => {
    const start = options.cursor ? Number(options.cursor) : 0;
    const end = start + 50;
    return Promise.resolve({
      artifactId: ARTIFACT_ID,
      capabilities: FULL_CAPABILITIES,
      threads: threads.slice(start, end),
      nextCursor: end < threads.length ? String(end) : null,
      ...over,
    });
  };
}

/** A port whose every method is a mock; `list` serves `threads` unless replaced. */
export function fakeCommentsSource(threads: readonly CommentThreadDto[] = []) {
  const unexpected = <Method extends keyof CommentsDataSource>(name: Method) =>
    vi.fn<CommentsDataSource[Method]>(() =>
      Promise.reject(new Error(`unexpected ${name}`))
    );
  return {
    list: vi.fn<CommentsDataSource["list"]>(pagedList(threads)),
    getThread: unexpected("getThread"),
    createThread: unexpected("createThread"),
    reply: unexpected("reply"),
    update: unexpected("update"),
    delete: unexpected("delete"),
    resolve: unexpected("resolve"),
    reopen: unexpected("reopen"),
    retrySync: unexpected("retrySync"),
  } satisfies CommentsDataSource;
}
