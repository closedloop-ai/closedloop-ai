import {
  ThreadSource,
  type ThreadStatus,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import {
  type CollectionCapabilities,
  CommentPolicyKey,
} from "@repo/api/src/types/comment-capabilities";
import {
  type CommentDto,
  CommentSyncProvider,
  CommentSyncStatus,
  type CommentThreadDto,
  type CommentThreadProviderDto,
  type CommentThreadSyncDto,
} from "@repo/api/src/types/comment-thread-dto";
import type { Prisma, TransactionClient } from "@repo/database";
import { selectedPullRequestRepositoryFullName } from "@/app/branches/selected-pull-request-repository-identity";
import type { TimeIdCursor } from "@/lib/time-id-cursor";
import {
  githubCommentExternalAuthorSelect,
  toBranchPrCommentAuthor,
} from "../../github-author-provider-detail";
import { extractBodyMentions } from "../../mention-body";
import { type CommentViewer, itemPermissions } from "../comment-capabilities";
import { afterCursorWhere, loadCommentAuthors } from "../comment-thread-rows";
import { readStoredCommentAnchor } from "../trace-comment-anchor-json";
import {
  formatAuthorName,
  type TraceCommentAuthor,
} from "../trace-comment-reply-mapper";
import { readPullRequestsWithFailedLatestAttempt } from "./github-comment-reconcile-marker";
import { hasUnconfirmedGitHubSync } from "./github-comment-sync-state";

/**
 * The live GitHub threads on a branch and their live comments, with each
 * comment's external author read in the viewer's organization only.
 */
function githubThreadRowSelect(organizationId: string) {
  return {
    id: true,
    organizationId: true,
    artifactId: true,
    source: true,
    status: true,
    resolvedAt: true,
    resolvedById: true,
    anchor: true,
    anchorState: true,
    revision: true,
    createdAt: true,
    githubProjection: {
      select: {
        htmlUrl: true,
        pullRequestDetailId: true,
        pullRequestDetail: {
          select: {
            number: true,
            repositoryFullName: true,
            repository: { select: { fullName: true } },
            branchArtifact: {
              select: {
                branch: {
                  select: {
                    repositoryFullName: true,
                    repository: { select: { fullName: true } },
                  },
                },
              },
            },
          },
        },
      },
    },
    comments: {
      where: {
        deletedAt: null,
        githubProjection: { is: { githubDeletedAt: null } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        authorId: true,
        plainText: true,
        body: true,
        bodyFormat: true,
        revision: true,
        editedAt: true,
        createdAt: true,
        updatedAt: true,
        githubProjection: {
          select: {
            githubHtmlUrl: true,
            githubUpdatedAt: true,
            externalAuthor: githubCommentExternalAuthorSelect(organizationId),
          },
        },
        syncStates: {
          where: { provider: CommentSyncProvider.Github },
          select: { direction: true, state: true },
        },
      },
    },
  } satisfies Prisma.CommentThreadSelect;
}

export type GitHubThreadRow = Prisma.CommentThreadGetPayload<{
  select: ReturnType<typeof githubThreadRowSelect>;
}>;

type GitHubCommentRow = GitHubThreadRow["comments"][number];

type GitHubThreadClient = Pick<TransactionClient, "commentThread">;

type GitHubThreadScope = {
  organizationId: string;
  artifactId: string;
};

/** The branch's live GitHub threads, oldest first, as the native list pages. */
export function findArtifactGitHubThreadRows(
  db: GitHubThreadClient,
  query: GitHubThreadScope & {
    status?: ThreadStatus;
    after?: TimeIdCursor;
    take: number;
  }
): Promise<GitHubThreadRow[]> {
  return db.commentThread.findMany({
    where: {
      ...liveGitHubThreadWhere(query),
      ...(query.status ? { status: query.status } : {}),
      ...(query.after ? afterCursorWhere(query.after) : {}),
    },
    select: githubThreadRowSelect(query.organizationId),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: query.take,
  });
}

export function findArtifactGitHubThreadRow(
  db: GitHubThreadClient,
  input: GitHubThreadScope & { threadId: string }
): Promise<GitHubThreadRow | null> {
  return db.commentThread.findFirst({
    where: { id: input.threadId, ...liveGitHubThreadWhere(input) },
    select: githubThreadRowSelect(input.organizationId),
  });
}

/**
 * PLN-2122 Step 7: GitHub threads as the unified DTO, under the
 * `github_branch` policy, in row order. A thread with no live comment or an
 * anchor this build cannot read is left out, as a native thread is.
 */
export async function mapGitHubThreadDtos(
  db: Pick<TransactionClient, "user" | "$queryRaw">,
  viewer: CommentViewer,
  capabilities: CollectionCapabilities,
  rows: readonly GitHubThreadRow[]
): Promise<CommentThreadDto[]> {
  const resolvers = await loadCommentAuthors(
    db,
    viewer.organizationId,
    rows.map((row) => ({ resolvedById: row.resolvedById, comments: [] }))
  );
  const failedPullRequestIds = await readPullRequestsWithFailedLatestAttempt(
    db,
    viewer.organizationId,
    [
      ...new Set(
        rows.flatMap((row) => row.githubProjection?.pullRequestDetailId ?? [])
      ),
    ]
  );
  return rows.flatMap(
    (row) =>
      mapGitHubThreadDto(row, {
        viewerUserId: viewer.userId,
        capabilities,
        resolvers,
        failedPullRequestIds,
      }) ?? []
  );
}

function liveGitHubThreadWhere(
  scope: GitHubThreadScope
): Prisma.CommentThreadWhereInput {
  return {
    organizationId: scope.organizationId,
    artifactId: scope.artifactId,
    source: ThreadSource.Github,
    githubProjection: {
      is: { branchArtifactId: scope.artifactId, deletedAt: null },
    },
  };
}

function mapGitHubThreadDto(
  row: GitHubThreadRow,
  context: {
    viewerUserId: string;
    capabilities: CollectionCapabilities;
    resolvers: ReadonlyMap<string, TraceCommentAuthor>;
    failedPullRequestIds: ReadonlySet<string>;
  }
): CommentThreadDto | null {
  const root = row.comments[0];
  if (!(row.artifactId && root)) {
    return null;
  }
  const anchor = readStoredCommentAnchor(row.anchor, {
    organizationId: row.organizationId,
    threadId: row.id,
  });
  if (anchor === undefined) {
    return null;
  }
  const participantIds = new Set(row.comments.map((c) => c.authorId));
  const permissionsFor = (authorId: string) =>
    itemPermissions(CommentPolicyKey.GithubBranch, context.capabilities, {
      viewerUserId: context.viewerUserId,
      commentAuthorId: authorId,
      threadAuthorId: root.authorId,
      threadParticipantIds: participantIds,
    });
  const resolver = row.resolvedById
    ? context.resolvers.get(row.resolvedById)
    : undefined;
  return {
    id: row.id,
    artifactId: row.artifactId,
    source: row.source,
    anchor,
    anchorState: row.anchorState,
    status: row.status,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedById
      ? {
          id: row.resolvedById,
          name: resolver ? formatAuthorName(resolver) : null,
          avatarUrl: resolver?.avatarUrl ?? null,
        }
      : null,
    revision: row.revision,
    sync: githubThreadSync(row.comments),
    permissions: permissionsFor(root.authorId),
    provider: githubThreadProvider(row, root, context.failedPullRequestIds),
    kind: TraceCommentKind.Comment,
    createdAt: row.createdAt.toISOString(),
    comments: row.comments.map(
      (comment): CommentDto => ({
        id: comment.id,
        threadId: row.id,
        author: githubCommentAuthorDto(comment),
        body: comment.plainText ?? "",
        bodyFormat: comment.bodyFormat,
        mentions: extractBodyMentions(comment.body),
        revision: comment.revision,
        createdAt: comment.createdAt.toISOString(),
        updatedAt: (
          comment.githubProjection?.githubUpdatedAt ?? comment.updatedAt
        ).toISOString(),
        editedAt: comment.editedAt?.toISOString() ?? null,
        permissions: permissionsFor(comment.authorId),
      })
    ),
  };
}

function githubCommentAuthorDto(
  comment: GitHubCommentRow
): CommentDto["author"] {
  const author = comment.githubProjection?.externalAuthor;
  return {
    id: comment.authorId,
    name: author ? (author.displayName ?? author.providerLogin) : null,
    avatarUrl: author?.avatarUrl ?? null,
  };
}

function githubThreadProvider(
  row: GitHubThreadRow,
  root: GitHubCommentRow,
  failedPullRequestIds: ReadonlySet<string>
): CommentThreadProviderDto {
  const linkOut =
    root.githubProjection?.githubHtmlUrl ?? row.githubProjection?.htmlUrl;
  const author = root.githubProjection?.externalAuthor;
  const pullRequestDetailId = row.githubProjection?.pullRequestDetailId;
  const pullRequest = row.githubProjection?.pullRequestDetail;
  const pullRequestNumber = pullRequest?.number;
  const repositoryFullName = pullRequest
    ? selectedPullRequestRepositoryFullName(
        pullRequest.branchArtifact,
        pullRequest
      )
    : null;
  return {
    ...(linkOut ? { linkOut } : {}),
    ...(author ? { author: toBranchPrCommentAuthor(author) } : {}),
    ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
    ...(repositoryFullName ? { repositoryFullName } : {}),
    // The Branch PR comments read's `stale` rule (Kerensa, 2026-10-05), per thread.
    stale:
      Boolean(
        pullRequestDetailId && failedPullRequestIds.has(pullRequestDetailId)
      ) || row.comments.some(hasUnconfirmedGitHubSync),
  };
}

/**
 * The thread's GitHub sync as its comments' stored sync states show it: one
 * that is not SYNCED wins, and a thread with none has no sync to show.
 */
function githubThreadSync(
  comments: readonly GitHubCommentRow[]
): CommentThreadSyncDto | null {
  const states = comments.flatMap((comment) => comment.syncStates);
  const shown =
    states.find((state) => state.state !== CommentSyncStatus.Synced) ??
    states[0];
  return shown
    ? {
        provider: CommentSyncProvider.Github,
        direction: shown.direction,
        state: shown.state,
      }
    : null;
}
