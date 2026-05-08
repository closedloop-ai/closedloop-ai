/**
 * Branch view UI types.
 * API types imported from @repo/api/src/types/branch-view.
 * This file contains UI-only constructs (file selection, section tagging).
 */

export type {
  BranchViewComment,
  BranchViewData,
  BranchViewFile,
  BranchViewFileDiff,
  BranchViewReview,
  ChecksStatus,
  CommentKind,
  FileChangeStatus,
  PRReviewCommentState,
  PrCommentAuthorKind,
  ReviewDecision,
} from "@repo/api/src/types/branch-view";

export const FileSection = {
  Local: "local",
  Committed: "committed",
} as const;
export type FileSection = (typeof FileSection)[keyof typeof FileSection];

/** A changed file annotated with a unique identity for selection. */
export type ChangedFileEntry = {
  fileId: string;
  section: FileSection;
  file: {
    path: string;
    previousPath?: string | null;
    status: string;
    additions?: number;
    deletions?: number;
  };
};

export function buildFileId(section: FileSection, path: string): string {
  return `${section}:${path}`;
}
