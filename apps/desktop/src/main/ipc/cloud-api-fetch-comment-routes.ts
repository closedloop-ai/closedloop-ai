import {
  CommentTargetType,
  hasTraceCommentRoutes,
  type TraceCommentTarget,
  traceCommentRetrySyncPath,
} from "@repo/api/src/types/comment";
import { commentApiPaths } from "@repo/api/src/types/comment-thread-dto";

/**
 * Stands in for the id while a path builder is turned into a pattern.
 * `encodeURIComponent` leaves it unchanged, so it appears in the built path
 * exactly once.
 */
const ROUTE_ID_PLACEHOLDER = "ROUTEID";

/**
 * One encoded id segment. `%2F` stays percent-encoded in the raw pathname, so
 * a segment cannot span a real separator.
 */
const ID_SEGMENT = "[^/]+";

/**
 * `/comments/:commentId/...` shares its prefix with the `/comments/threads/...`
 * and `/comments/attachments/...` families, so the comment id may be neither
 * `threads` nor `attachments`, whatever follows it.
 */
const COMMENT_ID_SEGMENT = `(?!(?:threads|attachments)(?:/|$))${ID_SEGMENT}`;

/**
 * The unified comment write routes the desktop renderer may reach over the
 * cloud bridge (PLN-2162 M5.1, decision 11). Each pattern is built from the
 * route's own `commentApiPaths` builder, so the allowlist cannot drift from the
 * paths the shared HTTP source requests. Reads are GETs and need no entry.
 */
export const UNIFIED_COMMENT_WRITE_ROUTES = {
  POST: [
    routePattern(commentApiPaths.artifactThreads),
    routePattern(commentApiPaths.threadReplies),
    routePattern(commentApiPaths.threadResolve),
    routePattern(commentApiPaths.threadReopen),
    routePattern(commentApiPaths.threadRetrySync),
    // PLN-2187 T-2.8: an upload starts on the comment and is confirmed on the
    // attachment; the file itself goes straight to its signed URL.
    routePattern(commentApiPaths.commentAttachments, COMMENT_ID_SEGMENT),
    routePattern(commentApiPaths.attachmentComplete),
  ],
  PUT: [commentReactionPattern()],
  PATCH: [routePattern(commentApiPaths.comment, COMMENT_ID_SEGMENT)],
  DELETE: [
    routePattern(commentApiPaths.comment, COMMENT_ID_SEGMENT),
    commentReactionPattern(),
  ],
} as const satisfies Record<string, readonly RegExp[]>;

/**
 * The legacy trace-comment rail's retry door (ISS-10382), on both owner kinds.
 * Desktop sends every comment write over HTTP since PLN-2162 M5.2, so this POST
 * now reaches the bridge.
 */
export const TRACE_COMMENT_RETRY_SYNC_ROUTE = traceCommentRoutePattern(
  traceCommentRetrySyncPath
);

function routePattern(
  buildPath: (id: string) => string,
  idSegment = ID_SEGMENT
): RegExp {
  const parts = buildPath(ROUTE_ID_PLACEHOLDER).split(ROUTE_ID_PLACEHOLDER);
  if (parts.length !== 2) {
    throw new Error("A comment route must carry exactly one id segment.");
  }
  const [prefix, suffix] = parts;
  return new RegExp(`^${prefix}${idSegment}${suffix}$`);
}

/** `/comments/:commentId/reactions/:emoji`, the one route carrying two ids. */
function commentReactionPattern(): RegExp {
  const parts = commentApiPaths
    .commentReaction(ROUTE_ID_PLACEHOLDER, ROUTE_ID_PLACEHOLDER)
    .split(ROUTE_ID_PLACEHOLDER);
  if (parts.length !== 3) {
    throw new Error("A reaction route must carry exactly two ids.");
  }
  const [prefix, middle, suffix] = parts;
  return new RegExp(
    `^${prefix}${COMMENT_ID_SEGMENT}${middle}${ID_SEGMENT}${suffix}$`
  );
}

function traceCommentRoutePattern(
  buildPath: (target: TraceCommentTarget, commentId: string) => string
): RegExp {
  const owners = Object.values(CommentTargetType)
    .filter(hasTraceCommentRoutes)
    .map((type) => {
      const parts = buildPath(
        { type, id: ROUTE_ID_PLACEHOLDER },
        ROUTE_ID_PLACEHOLDER
      ).split(ROUTE_ID_PLACEHOLDER);
      if (parts.length !== 3) {
        throw new Error("A trace-comment route must carry exactly two ids.");
      }
      return parts.join(ID_SEGMENT);
    });
  return new RegExp(`^(?:${owners.join("|")})$`);
}
