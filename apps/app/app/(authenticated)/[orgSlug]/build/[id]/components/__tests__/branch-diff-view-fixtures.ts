import {
  type BranchViewComment,
  CommentKind,
  FileChangeStatus,
  GitHubDiffSide,
  PRReviewCommentState,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import type { BranchViewFileDiff } from "../../types";
import { type ChangedFileEntry, FileSection } from "../../types";

export function makeEntry(path: string): ChangedFileEntry {
  return {
    file: {
      additions: 3,
      deletions: 1,
      path,
      previousPath: null,
      status: FileChangeStatus.Modified,
    },
    fileId: `committed:${path}`,
    section: FileSection.Committed,
  };
}

export function makeLocalEntry(path: string): ChangedFileEntry {
  return {
    file: {
      additions: 3,
      deletions: 1,
      path,
      previousPath: null,
      status: FileChangeStatus.Modified,
    },
    fileId: `local:${path}`,
    section: FileSection.Local,
  };
}

export function makeInlineComment(
  overrides: Partial<BranchViewComment> = {}
): BranchViewComment {
  return {
    author: "reviewer-user",
    authorAvatar: null,
    authorKind: PrCommentAuthorKind.User,
    body: "Inline comment body",
    createdAt: "2026-05-22T12:00:00.000Z",
    githubCommentId: "9001",
    htmlUrl: "https://github.com/acme/repo/pull/1#discussion_r9001",
    id: "comment-9001",
    inReplyToId: null,
    kind: CommentKind.ReviewComment,
    line: 2,
    path: "src/app.tsx",
    reviewId: "review-1",
    side: GitHubDiffSide.Right,
    state: PRReviewCommentState.Pending,
    ...overrides,
  };
}

export function diff(overrides: Partial<BranchViewFileDiff> = {}) {
  return {
    data: {
      isBinary: false,
      isDeleted: false,
      isNew: false,
      newContent: ["one", "two", "three"].join("\n"),
      oldContent: ["one", "old", "three"].join("\n"),
      path: "src/app.tsx",
      ...overrides,
    },
    error: null,
    isLoading: false,
  };
}
