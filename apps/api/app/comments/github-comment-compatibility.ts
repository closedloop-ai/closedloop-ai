import type {
  GitHubCommentThreadKind,
  TransactionClient,
} from "@repo/database";

export const GitHubCommentCompatibilityCode = {
  Resolved: "resolved",
  NotFound: "not_found",
  Ambiguous: "ambiguous",
  MalformedId: "malformed_id",
} as const;
export type GitHubCommentCompatibilityCode =
  (typeof GitHubCommentCompatibilityCode)[keyof typeof GitHubCommentCompatibilityCode];

export type ResolveGitHubCommentCompatibilityInput = {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  id: string | number;
  /**
   * Optional provider comment source discriminator. Raw GitHub ids can be
   * shared across issue-comment and review-thread projections, so callers that
   * know the intended source kind should pass it to avoid false ambiguity.
   */
  threadKind?: GitHubCommentThreadKind;
};

export type ResolvedGitHubCommentCompatibility = {
  code: typeof GitHubCommentCompatibilityCode.Resolved;
  commentId: string;
  threadId: string;
  githubCommentId: string;
};

export type GitHubCommentCompatibilityResult =
  | ResolvedGitHubCommentCompatibility
  | {
      code:
        | typeof GitHubCommentCompatibilityCode.NotFound
        | typeof GitHubCommentCompatibilityCode.Ambiguous
        | typeof GitHubCommentCompatibilityCode.MalformedId;
    };

/**
 * Resolve remote GitHub ids, unified comment ids, and unified thread ids
 * through the current org/branch/PR scope.
 */
export async function resolveGitHubCommentCompatibility(
  tx: TransactionClient,
  input: ResolveGitHubCommentCompatibilityInput
): Promise<GitHubCommentCompatibilityResult> {
  const normalizedId = String(input.id).trim();
  if (!normalizedId) {
    return { code: GitHubCommentCompatibilityCode.MalformedId };
  }

  const unified = await resolveUnifiedComment(tx, input, normalizedId);
  if (unified === "ambiguous") {
    return { code: GitHubCommentCompatibilityCode.Ambiguous };
  }
  if (unified) {
    return { code: GitHubCommentCompatibilityCode.Resolved, ...unified };
  }

  return { code: GitHubCommentCompatibilityCode.NotFound };
}

async function resolveUnifiedComment(
  tx: TransactionClient,
  input: ResolveGitHubCommentCompatibilityInput,
  id: string
): Promise<
  Omit<ResolvedGitHubCommentCompatibility, "code"> | "ambiguous" | null
> {
  const rows = await tx.gitHubCommentProjection.findMany({
    where: {
      OR: [{ githubCommentId: id }, { commentId: id }],
      ...scopedProjectionWhere(input),
    },
    select: {
      commentId: true,
      threadId: true,
      githubCommentId: true,
    },
    take: 2,
  });
  if (rows.length > 1) {
    return "ambiguous";
  }
  if (rows.length !== 1 || !rows[0].githubCommentId) {
    return await resolveUnifiedCommentByThreadId(tx, input, id);
  }
  return {
    commentId: rows[0].commentId,
    threadId: rows[0].threadId,
    githubCommentId: rows[0].githubCommentId,
  };
}

async function resolveUnifiedCommentByThreadId(
  tx: TransactionClient,
  input: ResolveGitHubCommentCompatibilityInput,
  threadId: string
): Promise<Omit<ResolvedGitHubCommentCompatibility, "code"> | null> {
  const row = await tx.gitHubCommentProjection.findFirst({
    where: {
      threadId,
      ...scopedProjectionWhere(input),
    },
    select: {
      commentId: true,
      threadId: true,
      githubCommentId: true,
    },
    orderBy: [{ comment: { createdAt: "asc" } }, { commentId: "asc" }],
  });
  if (!row?.githubCommentId) {
    return null;
  }
  return {
    commentId: row.commentId,
    threadId: row.threadId,
    githubCommentId: row.githubCommentId,
  };
}

function scopedProjectionWhere(input: ResolveGitHubCommentCompatibilityInput) {
  return {
    githubDeletedAt: null,
    comment: { deletedAt: null },
    threadProjection: {
      branchArtifactId: input.branchArtifactId,
      pullRequestDetailId: input.pullRequestDetailId,
      deletedAt: null,
      ...(input.threadKind ? { threadKind: input.threadKind } : {}),
      thread: {
        organizationId: input.organizationId,
        artifactId: input.branchArtifactId,
      },
    },
  };
}
