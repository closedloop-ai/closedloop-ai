import "server-only";

import type { BranchViewComment } from "@repo/api/src/types/branch-view";
import type { PrContext } from "@/lib/resolve-pr-context";

export type ReplyToCommentResult =
  | { data: BranchViewComment; error: null }
  | { data: null; error: string };

/**
 * Legacy reply path intentionally disabled until the user-token write routes
 * can provide stable GitHub identity and permission checks.
 */
export function replyToComment(
  _ctx: PrContext,
  _commentGithubId: number,
  _body: string
): ReplyToCommentResult {
  return {
    data: null,
    error: "Branch-view GitHub replies require user-token comment writes",
  };
}
