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
  CommentSurface,
  CommentTargetType,
  normalizeTraceCommentKind,
  TRACE_COMMENT_INCLUDE_THREAD_PARAM,
  traceCommentPath,
  traceCommentRepliesPath,
  traceCommentRetrySyncPath,
  traceCommentsPath,
} from "@repo/api/src/types/comment";
import {
  branchSessionTraceCommentsQuery,
  traceCommentResponseSchema,
} from "@repo/api/src/types/trace-comment-response";
import { z } from "zod";
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
> & {
  /** ISS-11004: one thread to return even when it falls past the cap. */
  includeThreadId?: string;
};

/** Portable trace-comments persistence port shared by Sessions and Branches. */
export type TraceCommentsDataSource = {
  scope: string;
  /** ISS-12282: null means an older API does not support the additive batch read. */
  listBranchSessions?(
    branchId: string,
    options?: TraceCommentReadOptions
  ): Promise<TraceComment[] | null>;
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
  /**
   * ISS-8597 (PRD-699 §5 D2): re-pend one comment this source dead-lettered, and
   * answer with the collection's refreshed list.
   *
   * OPTIONAL, and absence is still the answer rather than a gap: only a source
   * that can represent an ABANDONED comment can un-abandon one. A surface offers
   * the retry affordance exactly when this is present, so the port's shape
   * decides it instead of a per-surface flag.
   *
   * ISS-10382 made the cloud HTTP source one of those sources. It used to opt
   * out on the grounds that "a comment it returns has been delivered by
   * definition", which stopped being true when the API gained a dead-letter
   * representation of its own: the cloud can now hold a comment whose delivery
   * was permanently rejected, so it has something real to re-pend and the web
   * shell has the same door desktop has.
   */
  retrySync?(
    target: TraceCommentTarget,
    commentId: string,
    collection?: BranchTraceCommentCollectionQuery
  ): Promise<TraceComment[]>;
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
    listBranchSessions: async (branchId, options) => {
      const query = new URLSearchParams(branchSessionTraceCommentsQuery);
      const target = { type: CommentTargetType.Branch, id: branchId };
      try {
        const incoming = await api.get<unknown>(
          `${traceCommentsPath(target)}?${query}`,
          { cache: "no-store", ...options }
        );
        return z.array(traceCommentResponseSchema).parse(incoming);
      } catch (error) {
        // The previous API rejects this unknown query parameter. Preserve its
        // exact collection reads until the server is upgraded (ISS-12282).
        if (z.object({ status: z.literal(400) }).safeParse(error).success) {
          return null;
        }
        throw error;
      }
    },
    list: async (target, collection, options) => {
      const { includeThreadId, ...requestOptions } = options ?? {};
      return (
        await api.get<TraceComment[]>(
          traceCommentsCollectionReadPath(target, collection, includeThreadId),
          { cache: "no-store", ...requestOptions }
        )
      ).map(withNormalizedKind);
    },
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
    // ISS-10382: the web recovery door. Answers with the refreshed collection,
    // normalized exactly like `list` does — the response is the same list shape
    // and a caller must not get an un-normalized `kind` only on this path.
    retrySync: async (target, commentId, collection) =>
      (
        await api.post<TraceComment[]>(
          withCollectionQuery(
            traceCommentRetrySyncPath(target, commentId),
            target,
            collection
          ),
          {}
        )
      ).map(withNormalizedKind),
  };
}

/** Canonical collection surface for cache, transport, and validation. */
export function normalizedCommentSurface(
  target: TraceCommentTarget,
  collection?: BranchTraceCommentCollectionQuery
) {
  if (target.type === CommentTargetType.Session) {
    return CommentSurface.SessionDetail;
  }
  return collection?.surface ?? CommentSurface.BranchDetail;
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

/**
 * Whether this source can accept a write to this collection at all.
 *
 * Exported beside the assert because a SURFACE has to ask the question before
 * rendering the control, not only before sending the write: a button that throws
 * on click is the dead affordance the port's optional-method contract exists to
 * avoid (ISS-10383). One rule, two callers — the assert below is the fail-closed
 * backstop for anything that reaches the write without asking.
 */
export function isTraceCommentWriteSupported(
  dataSource: TraceCommentsDataSource,
  target: TraceCommentTarget,
  collection?: BranchTraceCommentCollectionQuery
): boolean {
  return !(
    target.type === CommentTargetType.Branch &&
    normalizedCommentSurface(target, collection) ===
      CommentSurface.BranchTimeline &&
    dataSource.capabilities?.branchTimelineWrites !== true
  );
}

/** Fail closed before an additive Branch-timeline write reaches an old port. */
export function assertTraceCommentWriteSupported(
  dataSource: TraceCommentsDataSource,
  target: TraceCommentTarget,
  collection?: BranchTraceCommentCollectionQuery
): void {
  if (!isTraceCommentWriteSupported(dataSource, target, collection)) {
    throw new TraceCommentCapabilityError();
  }
}

/**
 * Re-pend one dead-lettered comment through the port (ISS-8597).
 *
 * The collection argument is OMITTED rather than passed as `undefined` for a
 * session target, because a source may distinguish "no collection" from "an
 * undefined collection". ISS-10383 moved this beside the port it calls: the
 * Sessions rail and the Branches surface were each about to declare that
 * convention themselves, and two copies of one calling convention drift in
 * silence — a surface keeps the old arity and addresses the wrong collection.
 */
export function executeTraceCommentRetrySync(
  dataSource: TraceCommentsDataSource,
  target: TraceCommentTarget,
  commentId: string,
  collection?: BranchTraceCommentCollectionQuery
): Promise<TraceComment[]> {
  const retrySync = dataSource.retrySync;
  if (!retrySync) {
    throw new Error("This trace-comment source cannot retry a failed sync.");
  }
  return collection === undefined
    ? retrySync.call(dataSource, target, commentId)
    : retrySync.call(dataSource, target, commentId, collection);
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
    comment.surface === normalizedCommentSurface(target, collection)
  );
}

function traceCommentsCollectionPath(
  target: TraceCommentTarget,
  collection?: BranchTraceCommentCollectionQuery
): string {
  const path = traceCommentsPath(target);
  if (target.type === CommentTargetType.Session) {
    return path;
  }
  const query = new URLSearchParams({
    surface: normalizedCommentSurface(target, collection),
  });
  return `${path}?${query.toString()}`;
}

function withCollectionQuery(
  path: string,
  target: TraceCommentTarget,
  collection?: BranchTraceCommentCollectionQuery
): string {
  if (target.type === CommentTargetType.Session) {
    return path;
  }
  const query = new URLSearchParams({
    surface: normalizedCommentSurface(target, collection),
  });
  return `${path}?${query.toString()}`;
}

function withNormalizedKind(comment: TraceComment): TraceComment {
  return { ...comment, kind: normalizeTraceCommentKind(comment.kind) };
}

function traceCommentsCollectionReadPath(
  target: TraceCommentTarget,
  collection: BranchTraceCommentCollectionQuery | undefined,
  includeThreadId: string | undefined
): string {
  const path = traceCommentsCollectionPath(target, collection);
  if (!includeThreadId) {
    return path;
  }
  const separator = path.includes("?") ? "&" : "?";
  const query = new URLSearchParams({
    [TRACE_COMMENT_INCLUDE_THREAD_PARAM]: includeThreadId,
  });
  return `${path}${separator}${query.toString()}`;
}
