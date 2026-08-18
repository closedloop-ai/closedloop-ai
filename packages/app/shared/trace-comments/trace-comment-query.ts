import type {
  BranchTraceCommentCollectionQuery,
  TraceCommentTarget,
} from "@repo/api/src/types/comment";
import { OWNS_AUTH_REJECTION_META_KEY } from "../query/auth-rejection-store";
import { normalizedTraceCommentSurface } from "./trace-comments-data-source";

/** Shared target/surface cache identity for every trace-comments consumer. */
export const traceCommentKeys = {
  all: ["trace-comments"] as const,
  target: (
    scope: string,
    target: TraceCommentTarget,
    collection?: BranchTraceCommentCollectionQuery
  ) =>
    [
      ...traceCommentKeys.all,
      scope,
      target.type,
      target.id,
      normalizedTraceCommentSurface(target, collection),
    ] as const,
};

/** Live-read defaults shared by Session and Branch trace comments. */
export const traceCommentsLiveQueryOptions = {
  staleTime: 0,
  refetchOnReconnect: "always",
  refetchOnWindowFocus: "always",
  meta: { [OWNS_AUTH_REJECTION_META_KEY]: true },
} as const;
