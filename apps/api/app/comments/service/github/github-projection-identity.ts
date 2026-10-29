import { type GitHubCommentThreadKind, ThreadSource } from "@repo/database";

export const GitHubProjectionNoWriteCode = {
  AmbiguousThreadProjection: "ambiguous_thread_projection",
  ExternalIdConflict: "external_id_conflict",
  /** The comment is soft-deleted and the write is not a revival. */
  DeletedComment: "deleted_comment",
} as const;
export type GitHubProjectionNoWriteCode =
  (typeof GitHubProjectionNoWriteCode)[keyof typeof GitHubProjectionNoWriteCode];

/**
 * Typed projection preflight failure raised before mutating any unified comment
 * rows. Producer paths catch this when a GitHub remote id cannot be mapped to a
 * single organization/branch/current-PR scoped projection.
 */
export class GitHubProjectionNoWriteError extends Error {
  readonly code: GitHubProjectionNoWriteCode;
  readonly details: Record<string, string | number | null>;

  constructor(
    code: GitHubProjectionNoWriteCode,
    details: Record<string, string | number | null>
  ) {
    super(`GitHub comment projection no-write: ${code}`);
    this.name = "GitHubProjectionNoWriteError";
    this.code = code;
    this.details = details;
  }
}

export class GitHubCommentProjectionScopeCollisionError extends GitHubProjectionNoWriteError {
  constructor(githubCommentId: string) {
    super(GitHubProjectionNoWriteCode.ExternalIdConflict, {
      githubCommentId,
    });
    this.name = "GitHubCommentProjectionScopeCollisionError";
  }
}

/**
 * The org/branch/current-PR scope every GitHub thread-projection query narrows
 * to before it is allowed to match a row. Shared with
 * `github-projection-review-thread-read.ts`, which asks the same scoping
 * question of the same rows from the read-only webhook path — two spellings of
 * this predicate is how a resolution sync starts matching a thread the write
 * path would refuse.
 */
export function scopedThreadProjectionWhere(input: {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
}) {
  return {
    branchArtifactId: input.branchArtifactId,
    pullRequestDetailId: input.pullRequestDetailId,
    deletedAt: null,
    thread: {
      organizationId: input.organizationId,
      artifactId: input.branchArtifactId,
      source: ThreadSource.GITHUB,
    },
  };
}

export function requireRemoteCommentId(id: string | number): string {
  const normalized = String(id).trim();
  if (!normalized) {
    throw new Error("GitHub comment projection requires a remote comment id");
  }
  return normalized;
}

export function optionalRemoteCommentId(
  id: string | number | null | undefined
): string | null {
  if (id === null || id === undefined) {
    return null;
  }
  return requireRemoteCommentId(id);
}

export function gitHubCommentExternalId(
  threadKind: GitHubCommentThreadKind,
  githubCommentId: string
): string {
  return `github:${threadKind}:comment:${githubCommentId}`;
}

export function gitHubThreadExternalId(input: {
  pullRequestDetailId: string;
  threadKind: GitHubCommentThreadKind;
  rootCommentId: string;
  reviewThreadId?: string | null;
}): string {
  const identity = input.reviewThreadId
    ? `review-thread:${input.reviewThreadId}`
    : `${input.threadKind}:root:${input.rootCommentId}`;
  return `github-pr-thread:${input.pullRequestDetailId}:${identity}`;
}
