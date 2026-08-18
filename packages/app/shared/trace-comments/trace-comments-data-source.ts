import type {
  BranchTraceCommentCollectionQuery,
  TraceComment,
  TraceCommentDeleteResult,
  TraceCommentDraft,
  TraceCommentReplyDraft,
  TraceCommentTarget,
  TraceCommentUpdate,
} from "@repo/api/src/types/comment";
import {
  normalizeTraceCommentKind,
  TraceCommentSurface,
  TraceCommentTargetType,
  traceCommentPath,
  traceCommentRepliesPath,
  traceCommentsPath,
} from "@repo/api/src/types/comment";
import type { ApiRequestOptions } from "../api/api-timeout";

export type TraceCommentsDataSourceCapabilities = {
  /** Explicit opt-in for the additive Branch-timeline write contract. */
  branchTimelineWrites: true;
};

/**
 * Cancellation and deadline for ONE read (ISS-5110).
 *
 * Additive and optional so an older source that ignores it keeps working: a
 * source that drops it is no worse than before this existed, and no caller
 * depends on cancellation being honored for correctness.
 *
 * `signal` is the query's own signal (TanStack hands one to every `queryFn`), so
 * a superseded or unmounted read stops occupying the transport instead of being
 * merely un-joined. `timeoutMs` is the read's deadline, expressed as the shared
 * API client's per-call override — the ONLY thing the desktop cloud-IPC bridge
 * can act on, since an `AbortSignal` does not survive structured cloning (see
 * the surface caveat in `../api/api-timeout.ts`).
 */
export type TraceCommentReadOptions = Pick<
  ApiRequestOptions,
  "signal" | "timeoutMs"
>;

/** Portable trace-comments persistence port shared by Sessions and Branches. */
export type TraceCommentsDataSource = {
  scope: string;
  capabilities?: TraceCommentsDataSourceCapabilities;
  list(
    target: TraceCommentTarget,
    collection?: BranchTraceCommentCollectionQuery,
    options?: TraceCommentReadOptions
  ): Promise<TraceComment[]>;
  create(
    target: TraceCommentTarget,
    draft: TraceCommentDraft,
    collection?: BranchTraceCommentCollectionQuery
  ): Promise<TraceComment>;
  reply(
    target: TraceCommentTarget,
    commentId: string,
    draft: TraceCommentReplyDraft,
    collection?: BranchTraceCommentCollectionQuery
  ): Promise<TraceComment>;
  update(
    target: TraceCommentTarget,
    commentId: string,
    update: TraceCommentUpdate,
    collection?: BranchTraceCommentCollectionQuery
  ): Promise<TraceComment>;
  delete(
    target: TraceCommentTarget,
    commentId: string,
    collection?: BranchTraceCommentCollectionQuery
  ): Promise<TraceCommentDeleteResult>;
};

export type TraceCommentCollectionRead = {
  comments: TraceComment[];
  rejectedCount: number;
};

type TraceCommentsHttpClient = {
  get<T>(path: string, options?: ApiRequestOptions): Promise<T>;
  post<T>(path: string, data: unknown): Promise<T>;
  patch<T>(path: string, data: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
};

/** HTTP-backed source for the current trace-comments wire contract. */
export function createHttpTraceCommentsDataSource(
  api: TraceCommentsHttpClient
): TraceCommentsDataSource {
  return {
    scope: "http",
    capabilities: { branchTimelineWrites: true },
    list: async (target, collection, options) =>
      (
        await api.get<TraceComment[]>(
          traceCommentsCollectionPath(target, collection),
          { cache: "no-store", ...options }
        )
      ).map(withNormalizedKind),
    create: async (target, draft, collection) =>
      withNormalizedKind(
        await api.post<TraceComment>(
          traceCommentsCollectionPath(target, collection),
          draft
        )
      ),
    reply: async (target, commentId, draft, collection) =>
      withNormalizedKind(
        await api.post<TraceComment>(
          withCollectionQuery(
            traceCommentRepliesPath(target, commentId),
            target,
            collection
          ),
          draft
        )
      ),
    update: async (target, commentId, update, collection) =>
      withNormalizedKind(
        await api.patch<TraceComment>(
          withCollectionQuery(
            traceCommentPath(target, commentId),
            target,
            collection
          ),
          update
        )
      ),
    delete: (target, commentId, collection) =>
      api.delete<TraceCommentDeleteResult>(
        withCollectionQuery(
          traceCommentPath(target, commentId),
          target,
          collection
        )
      ),
  };
}

/** Canonical collection surface for cache, transport, and validation. */
export function normalizedTraceCommentSurface(
  target: TraceCommentTarget,
  collection?: BranchTraceCommentCollectionQuery
) {
  if (target.type === TraceCommentTargetType.Session) {
    return TraceCommentSurface.SessionDetail;
  }
  return collection?.surface ?? TraceCommentSurface.BranchDetail;
}

/**
 * Reads one exact collection and rejects version-skewed/misrouted rows without
 * silently presenting them in another comments surface.
 */
export async function readTraceCommentCollection(
  dataSource: TraceCommentsDataSource,
  target: TraceCommentTarget,
  collection?: BranchTraceCommentCollectionQuery,
  options?: TraceCommentReadOptions
): Promise<TraceCommentCollectionRead> {
  const incoming = await dataSource.list(target, collection, options);
  const comments = incoming.filter((comment) =>
    traceCommentMatchesCollection(comment, target, collection)
  );
  return {
    comments,
    rejectedCount: incoming.length - comments.length,
  };
}

/** Fail closed before an additive Branch-timeline write reaches an old port. */
export function assertTraceCommentWriteSupported(
  dataSource: TraceCommentsDataSource,
  target: TraceCommentTarget,
  collection?: BranchTraceCommentCollectionQuery
): void {
  if (
    target.type === TraceCommentTargetType.Branch &&
    normalizedTraceCommentSurface(target, collection) ===
      TraceCommentSurface.BranchTimeline &&
    dataSource.capabilities?.branchTimelineWrites !== true
  ) {
    throw new TraceCommentCapabilityError();
  }
}

/** Reject a mutation response that came back for another target or surface. */
export function assertTraceCommentMutationResult(
  comment: TraceComment,
  target: TraceCommentTarget,
  collection?: BranchTraceCommentCollectionQuery
): TraceComment {
  if (!traceCommentMatchesCollection(comment, target, collection)) {
    throw new TraceCommentCollectionMismatchError();
  }
  return comment;
}

export class TraceCommentCapabilityError extends Error {
  constructor() {
    super("This trace-comment source does not support Branch timeline writes.");
    this.name = "TraceCommentCapabilityError";
  }
}

export class TraceCommentCollectionMismatchError extends Error {
  constructor() {
    super("The trace-comment response did not match the requested collection.");
    this.name = "TraceCommentCollectionMismatchError";
  }
}

function traceCommentMatchesCollection(
  comment: TraceComment,
  target: TraceCommentTarget,
  collection?: BranchTraceCommentCollectionQuery
): boolean {
  return (
    comment.target?.type === target.type &&
    comment.target.id === target.id &&
    comment.surface === normalizedTraceCommentSurface(target, collection)
  );
}

function traceCommentsCollectionPath(
  target: TraceCommentTarget,
  collection?: BranchTraceCommentCollectionQuery
): string {
  const path = traceCommentsPath(target);
  if (target.type === TraceCommentTargetType.Session) {
    return path;
  }
  const query = new URLSearchParams({
    surface: normalizedTraceCommentSurface(target, collection),
  });
  return `${path}?${query.toString()}`;
}

function withCollectionQuery(
  path: string,
  target: TraceCommentTarget,
  collection?: BranchTraceCommentCollectionQuery
): string {
  if (target.type === TraceCommentTargetType.Session) {
    return path;
  }
  const query = new URLSearchParams({
    surface: normalizedTraceCommentSurface(target, collection),
  });
  return `${path}?${query.toString()}`;
}

function withNormalizedKind(comment: TraceComment): TraceComment {
  return { ...comment, kind: normalizeTraceCommentKind(comment.kind) };
}
