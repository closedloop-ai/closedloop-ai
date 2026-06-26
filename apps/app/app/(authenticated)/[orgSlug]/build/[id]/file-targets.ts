import type { BranchViewFile } from "./types";
import { buildFileId, FileSection } from "./types";

/** UI-only selected-file target, including an activation counter for replays. */
export type BranchFileSelectionTarget = {
  fileId: string;
  line: number | null;
  activationId: number;
};

/** Resolved committed-file target for a PR review comment location. */
export type ResolvedCommentFileTarget = {
  fileId: string;
};

/** Navigation request emitted by a resolvable PR review comment file/line chip. */
export type CommentDiffNavigationRequest = {
  commentId: string;
  fileId: string;
  path: string;
  line: number;
};

/**
 * Resolve a review-comment path against committed files only.
 *
 * GitHub review comments can reference a previous path after a rename, so the
 * current file path is preferred and `previousPath` is a compatibility lookup.
 */
export function resolveCommittedCommentFileTarget(
  files: BranchViewFile[],
  path: string
): ResolvedCommentFileTarget | null {
  const directMatch = files.find((file) => file.path === path);
  const matchedFile =
    directMatch ?? files.find((file) => file.previousPath === path);

  if (!matchedFile) {
    return null;
  }

  return {
    fileId: buildFileId(FileSection.Committed, matchedFile.path),
  };
}
