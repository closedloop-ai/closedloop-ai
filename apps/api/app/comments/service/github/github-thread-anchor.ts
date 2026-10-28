import {
  CodeCommentSide,
  type CommentAnchor,
  CommentAnchorState,
  parseStoredCommentAnchor,
  StoredCommentAnchorReadStatus,
} from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { CommentPolicyKey } from "@repo/api/src/types/comment-capabilities";
import { GitHubDiffSide, type TransactionClient } from "@repo/database";
import { validateCommentAnchor } from "../comment-anchor-validation";
import { commentAnchorToStoredJson } from "../trace-comment-anchor-json";
import type { GitHubReviewThreadPosition } from "./github-projection-contract";

export type GitHubThreadAnchor = {
  anchor: CommentAnchor;
  anchorState: CommentAnchorState;
};

/**
 * PLN-2122 decision 7: a review comment is anchored to its code position, an
 * issue comment or a review summary to the artifact. A review comment GitHub
 * no longer places on a line (`line` null, `original_line` set) is OUTDATED and
 * anchored at its original line. `null` when the position is not a valid code
 * anchor (the anchor validation every connector write still passes).
 */
export function githubThreadAnchor(
  position: GitHubReviewThreadPosition | null,
  repositoryFullName: string | null
): GitHubThreadAnchor | null {
  if (!position?.path) {
    return {
      anchor: { kind: CommentAnchorKind.Artifact },
      anchorState: CommentAnchorState.Anchored,
    };
  }
  const side = codeSide(position.side);
  const startSide = codeSide(position.startSide);
  const candidate = {
    kind: CommentAnchorKind.Code,
    repository: repositoryFullName,
    commitSha: position.commitSha,
    path: position.path,
    side,
    endLine: position.line ?? null,
    ...(position.startLine == null ? {} : { startLine: position.startLine }),
    ...(position.startLine == null || startSide === null ? {} : { startSide }),
    ...(position.originalLine == null
      ? {}
      : { originalEndLine: position.originalLine }),
  };
  const validated = validateCommentAnchor(
    CommentPolicyKey.GithubBranch,
    candidate
  );
  if (!validated.ok) {
    return null;
  }
  return {
    anchor: validated.value,
    anchorState:
      position.line == null && position.originalLine != null
        ? CommentAnchorState.Outdated
        : CommentAnchorState.Anchored,
  };
}

/**
 * Writes a thread's anchor when it differs from the stored one, and reports
 * whether it wrote. The comparison is semantic: Postgres `jsonb` reorders keys.
 */
export async function writeGitHubThreadAnchor(
  tx: TransactionClient,
  threadId: string,
  next: GitHubThreadAnchor
): Promise<boolean> {
  const stored = await tx.commentThread.findUnique({
    where: { id: threadId },
    select: { anchor: true, anchorState: true },
  });
  if (!stored) {
    return false;
  }
  const read = parseStoredCommentAnchor(stored.anchor);
  if (
    read.status === StoredCommentAnchorReadStatus.Valid &&
    stored.anchorState === next.anchorState &&
    canonicalAnchor(read.anchor) === canonicalAnchor(next.anchor)
  ) {
    return false;
  }
  await tx.commentThread.update({
    where: { id: threadId },
    data: {
      anchor: commentAnchorToStoredJson(next.anchor),
      anchorState: next.anchorState,
    },
    select: { id: true },
  });
  return true;
}

/** Code and artifact anchors are flat, so sorted top-level keys are canonical. */
function canonicalAnchor(anchor: CommentAnchor): string {
  return JSON.stringify(anchor, Object.keys(anchor).sort());
}

function codeSide(
  side: GitHubDiffSide | null | undefined
): CodeCommentSide | null {
  if (side === GitHubDiffSide.LEFT) {
    return CodeCommentSide.Left;
  }
  if (side === GitHubDiffSide.RIGHT) {
    return CodeCommentSide.Right;
  }
  return null;
}
