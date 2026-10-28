import {
  CommentTargetType,
  type TraceComment,
} from "@repo/api/src/types/comment";
import type { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import {
  badRequestResponse,
  conflictResponse,
  forbiddenResponse,
  notFoundResponse,
} from "@/lib/route-utils";

/** How the legacy routes answer a failed command; mapped from the service's codes by the adapter. */
export type TraceCommentFailureReason =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "bad_request";

/**
 * The service's code rides along only where the legacy routes had no answer
 * of their own, and is what those responses carry instead of prose.
 */
export type TraceCommentMutationFailure =
  | { ok: false; reason: "not_found" | "forbidden" }
  | { ok: false; reason: "conflict" | "bad_request"; code: CommentErrorCode };

export type TraceCommentMutationResult<T> =
  | { ok: true; value: T }
  | TraceCommentMutationFailure;

/** A create the service refused for a reason other than a missing target. */
export function isTraceCommentMutationFailure(
  value: TraceComment | TraceCommentMutationFailure
): value is TraceCommentMutationFailure {
  return "ok" in value && value.ok === false;
}

/**
 * ISS-11212: a refused command answers the status the route always gave it.
 * The two outcomes the legacy routes never had carry the service's code as
 * their error, never new prose.
 */
export function traceCommentFailureResponse(
  failure: TraceCommentMutationFailure,
  targetType: CommentTargetType
) {
  switch (failure.reason) {
    case "forbidden":
      return forbiddenResponse();
    case "conflict":
      return conflictResponse(failure.code, { code: failure.code });
    case "bad_request":
      return badRequestResponse(failure.code, { code: failure.code });
    default:
      return notFoundResponse(getTargetLabel(targetType));
  }
}

export function getTargetLabel(type: CommentTargetType): string {
  return type === CommentTargetType.Session ? "Agent session" : "Branch";
}
