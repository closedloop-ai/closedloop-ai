import {
  type CommentAnchor,
  commentAnchorSchema,
} from "@repo/api/src/types/comment-anchor";
import {
  COMMENT_SOURCE_POLICIES,
  type CommentPolicyKey,
} from "@repo/api/src/types/comment-capabilities";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { Result } from "@repo/api/src/types/result";
import type { CommentSourcePolicies } from "./comment-capabilities";

/** Validates an anchor against the contract and the kinds this source allows. */
export function validateCommentAnchor(
  policyKey: CommentPolicyKey,
  anchor: unknown,
  policies: CommentSourcePolicies = COMMENT_SOURCE_POLICIES
): Result<CommentAnchor, CommentErrorCode> {
  const parsed = commentAnchorSchema.safeParse(anchor);
  if (!parsed.success) {
    return Result.err(CommentErrorCode.AnchorInvalid);
  }
  return policies[policyKey].anchorKinds.includes(parsed.data.kind)
    ? Result.ok(parsed.data)
    : Result.err(CommentErrorCode.AnchorKindNotAllowed);
}
