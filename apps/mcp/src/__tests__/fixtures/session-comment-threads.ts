import { ThreadStatus } from "@repo/api/src/types/comment.js";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind.js";

export const SESSION_ID = "11111111-1111-4111-8111-111111111111";

type Author = { id: string; name: string | null; avatarUrl: string | null };

/**
 * A unified-read thread whose root comment is `id`, carrying the same values
 * the legacy route's `TraceComment` fixture carried, so the tool's output for
 * it is unchanged.
 */
export function sampleThread(overrides: {
  id: string;
  status?: ThreadStatus;
  resolvedAt?: string | null;
  resolvedBy?: Author | null;
  anchor?: Record<string, unknown> | null;
}) {
  const threadId = `thread-${overrides.id}`;
  return {
    id: threadId,
    artifactId: SESSION_ID,
    status: overrides.status ?? ThreadStatus.Open,
    resolvedAt: overrides.resolvedAt ?? null,
    resolvedBy: overrides.resolvedBy ?? null,
    anchor:
      overrides.anchor === undefined
        ? {
            kind: CommentAnchorKind.Trace,
            traceId: "trace-1",
            turnId: "turn-1",
            row: 3,
            selectedText: "selected",
            sourceText: "source selected text",
            startOffset: 7,
            endOffset: 15,
            sessionId: SESSION_ID,
            actor: { name: "codex", human: null },
          }
        : overrides.anchor,
    comments: [
      {
        id: overrides.id,
        threadId,
        body: "Root note",
        createdAt: "2026-07-20T09:00:00.000Z",
        updatedAt: "2026-07-20T09:01:00.000Z",
        editedAt: null,
        author: { id: "author-1", name: "Author User", avatarUrl: null },
      },
      {
        id: "reply-1",
        threadId,
        body: "Reply note",
        createdAt: "2026-07-20T09:02:00.000Z",
        updatedAt: "2026-07-20T09:03:00.000Z",
        editedAt: null,
        author: {
          id: "author-2",
          name: "Reply User",
          avatarUrl: "https://example.com/reply.png",
        },
      },
    ],
  };
}

export type SampleThread = ReturnType<typeof sampleThread>;

/** One unified-read page holding `threads`, with nothing after it. */
export function singlePage(threads: readonly SampleThread[]) {
  return { capabilities: {}, threads, nextCursor: null };
}

/**
 * The artifact comments route as the tool sees it: filters on `status`, pages
 * on `limit` and an opaque `cursor`, and answers only the session's path.
 */
export function pagedCommentsApi(
  path: string,
  threads: readonly SampleThread[]
) {
  return (requested: string, query: Record<string, string>) => {
    if (requested !== path) {
      return Promise.reject(new Error(`unexpected path ${requested}`));
    }
    const matching = query.status
      ? threads.filter((thread) => thread.status === query.status)
      : threads;
    const start = query.cursor ? Number(query.cursor) : 0;
    const end = start + Number(query.limit);
    return Promise.resolve({
      capabilities: {},
      threads: matching.slice(start, end),
      nextCursor: end < matching.length ? String(end) : null,
    });
  };
}
