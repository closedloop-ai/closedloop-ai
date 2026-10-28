import { CommentSurface, ThreadSource } from "@repo/api/src/types/comment";
import type { Prisma } from "@repo/database";
import { parseTraceCommentMetadata } from "./trace-comment-metadata";

/**
 * PLN-2187: a thread the Liveblocks webhook sync wrote carries Liveblocks'
 * metadata, not a trace comment's, and stays readable and repliable on the
 * document surface after its org switches (operator ruling, #8828,
 * 2026-10-15). Every other source states its surface in its metadata.
 */
const SURFACE_BY_SOURCE: Record<ThreadSource, CommentSurface | null> = {
  [ThreadSource.Native]: null,
  [ThreadSource.Liveblocks]: CommentSurface.DocumentDetail,
  [ThreadSource.Github]: null,
};

/** The surface a stored thread is shown on, or `null` when it names none. */
export function storedThreadSurface(thread: {
  source: ThreadSource;
  metadata: unknown;
}): CommentSurface | null {
  return (
    SURFACE_BY_SOURCE[thread.source] ??
    parseTraceCommentMetadata(thread.metadata)?.surface ??
    null
  );
}

/** The threads {@link storedThreadSurface} places on `surface`. */
export function storedThreadSurfaceWhere(
  surface: CommentSurface
): Prisma.CommentThreadWhereInput {
  const bySource = Object.values(ThreadSource).filter(
    (source) => SURFACE_BY_SOURCE[source] === surface
  );
  const byMetadata: Prisma.CommentThreadWhereInput = {
    metadata: { path: ["surface"], equals: surface },
  };
  // Under AND, so it never collides with a caller's own top-level OR.
  return bySource.length === 0
    ? byMetadata
    : { AND: [{ OR: [byMetadata, { source: { in: bySource } }] }] };
}

export function threadSourceWhere(
  sources: readonly ThreadSource[]
): Prisma.CommentThreadWhereInput["source"] {
  const [only, ...rest] = sources;
  return only !== undefined && rest.length === 0 ? only : { in: [...sources] };
}
