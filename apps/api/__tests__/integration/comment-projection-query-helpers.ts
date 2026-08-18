/**
 * Read-side lookups for the GitHub comment-projection integration suites: the
 * projection, thread-projection, and shared-comment rows a run asserts against.
 * Seeding helpers stay with the suite that owns the graph they build.
 */

import { withDb } from "@repo/database";

export function findGitHubCommentProjection(githubCommentId: string) {
  return withDb((db) =>
    db.gitHubCommentProjection.findFirst({
      where: { githubCommentId },
      include: { comment: true },
    })
  );
}

export function findGitHubCommentProjectionByThread(threadId: string) {
  return withDb((db) =>
    db.gitHubCommentProjection.findFirst({
      where: { threadId },
      include: { comment: true },
    })
  );
}

export function findGitHubThreadProjection(threadId: string) {
  return withDb((db) =>
    db.gitHubCommentThreadProjection.findUnique({
      where: { threadId },
    })
  );
}

export function findScopedSharedCommentRows(
  githubCommentId: string,
  pullRequestDetailId: string
) {
  return withDb((db) =>
    db.gitHubCommentProjection
      .findMany({
        where: {
          githubCommentId,
          threadProjection: {
            pullRequestDetailId,
          },
        },
        select: {
          threadId: true,
          githubCommentId: true,
          githubDeletedAt: true,
          comment: {
            select: {
              id: true,
              externalId: true,
              plainText: true,
            },
          },
          threadProjection: {
            select: {
              threadKind: true,
            },
          },
        },
      })
      .then((rows) =>
        rows.map((row) => ({
          ...row,
          threadKind: row.threadProjection.threadKind,
        }))
      )
  );
}

export function findCommentByExternalId(externalId: string) {
  return withDb((db) =>
    db.comment.findUnique({
      where: { externalId },
      select: {
        id: true,
        threadId: true,
        plainText: true,
        thread: {
          select: {
            organizationId: true,
            artifactId: true,
            githubProjection: {
              select: {
                branchArtifactId: true,
                pullRequestDetailId: true,
                threadKind: true,
              },
            },
          },
        },
      },
    })
  );
}
