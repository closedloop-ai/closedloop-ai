import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { failure } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";

/** PLN-2121 decision 3: the one HTTP status each code answers on the unified routes. */
const COMMENT_ERROR_HTTP_STATUS = {
  [CommentErrorCode.CapabilityDenied]: 403,
  [CommentErrorCode.StaleRevision]: 409,
  [CommentErrorCode.ClientIdConflict]: 409,
  [CommentErrorCode.AnchorInvalid]: 400,
  [CommentErrorCode.AnchorKindNotAllowed]: 400,
  [CommentErrorCode.ArtifactTypeNotSupported]: 400,
  [CommentErrorCode.NotFound]: 404,
} as const satisfies Record<CommentErrorCode, number>;

/**
 * A refused comment command, in the `ApiResult` envelope with the code as both
 * the error and `code`: clients map the code to approved copy (ISS-11212
 * acceptance criterion 9), so the API carries no prose of its own.
 */
export function commentErrorResponse(code: CommentErrorCode) {
  return NextResponse.json(failure(code, { code }), {
    status: COMMENT_ERROR_HTTP_STATUS[code],
  });
}
