import type { CommentSyncStatus } from "@repo/api/src/types/comment-thread-dto";
import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubCommentThreadKind, ThreadStatus } from "@repo/database";
import {
  type GitHubCommentReconcileResult,
  GitHubCommentReconcileStatus,
} from "@/app/comments/service/github/github-comment-reconcile";
import type { PullRequestCommentsReconcileMarker } from "@/app/comments/service/github/github-comment-reconcile-marker";

export const BRANCH_ID = "11111111-1111-4111-8111-111111111111";

export const RECONCILED_AT = new Date("2026-07-03T11:00:00.000Z");

/** A pull request a complete reconcile covered, with no failed attempt since. */
export function reconcileMarker(
  overrides: Partial<PullRequestCommentsReconcileMarker> = {}
): PullRequestCommentsReconcileMarker {
  return {
    reconciledAt: RECONCILED_AT,
    latestAttemptFailed: false,
    attemptDue: true,
    ...overrides,
  };
}

/** A pull request no complete reconcile has covered. */
export function unsyncedMarker(
  overrides: Partial<PullRequestCommentsReconcileMarker> = {}
): PullRequestCommentsReconcileMarker {
  return reconcileMarker({ reconciledAt: null, ...overrides });
}

export function reconcileResult(
  status: GitHubCommentReconcileStatus = GitHubCommentReconcileStatus.Reconciled,
  errorCode?: string
): GitHubCommentReconcileResult {
  return {
    status,
    reasons: [],
    appliedEvents: 0,
    signals: 0,
    ...(errorCode ? { errorCode } : {}),
  };
}

type RepositoryFixture = {
  fullName: string;
  owner: string;
  name: string;
};

export function repositoryFixture(
  overrides: Partial<RepositoryFixture> = {}
): RepositoryFixture {
  return {
    fullName: "closedloop-ai/closedloop-ai",
    owner: "closedloop-ai",
    name: "closedloop-ai",
    ...overrides,
  };
}

export function pullRequestDetailFixture(
  overrides: {
    id?: string;
    number?: number;
    repository?: RepositoryFixture | null;
  } = {}
) {
  const repository =
    overrides.repository === undefined
      ? repositoryFixture()
      : overrides.repository;
  return {
    id: overrides.id ?? "pr-detail-1",
    branchArtifactId: BRANCH_ID,
    repositoryId: "repository-1",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    number: overrides.number ?? 42,
    title: "Pull request",
    htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
    prState: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: null,
    githubCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
    closedAt: null,
    mergedAt: null,
    lastVerifiedAt: new Date("2026-07-01T00:00:01.000Z"),
    repository,
  };
}

export function branchContextRow(
  overrides: {
    pullRequestDetails?: ReturnType<typeof pullRequestDetailFixture>[];
    branchRepository?: RepositoryFixture | null;
    branchRepositoryFullName?: string | null;
  } = {}
) {
  const pullRequestDetails = overrides.pullRequestDetails ?? [
    pullRequestDetailFixture(),
  ];
  return {
    id: BRANCH_ID,
    pullRequestDetails,
    branch: {
      deletedAt: null,
      firstPushedAt: new Date("2026-07-01T00:00:00.000Z"),
      repositoryId: "repository-1",
      repositoryFullName:
        overrides.branchRepositoryFullName === undefined
          ? "closedloop-ai/closedloop-ai"
          : overrides.branchRepositoryFullName,
      repository:
        overrides.branchRepository === undefined
          ? repositoryFixture()
          : overrides.branchRepository,
    },
  };
}

type ThreadGithubProjectionFixture = {
  threadKind: GitHubCommentThreadKind;
  path: string | null;
  line: number | null;
  originalLine: number | null;
};

export function projectionRow(
  overrides: {
    id?: string;
    body?: unknown;
    plainText?: string | null;
    createdAt?: Date;
    updatedAt?: Date;
    syncStates?: CommentSyncStatus[];
    githubProjection?: null;
    githubCommentId?: string | null;
    githubInReplyToCommentId?: string | null;
    githubHtmlUrl?: string | null;
    githubUpdatedAt?: Date | null;
    externalAuthor?: null;
    providerLogin?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    profileUrl?: string | null;
    providerDetail?: unknown;
    threadStatus?: ThreadStatus;
    threadGithubProjection?: ThreadGithubProjectionFixture | null;
    threadKind?: GitHubCommentThreadKind;
    path?: string | null;
    line?: number | null;
    originalLine?: number | null;
  } = {}
) {
  const defaultThreadProjection: ThreadGithubProjectionFixture = {
    threadKind: overrides.threadKind ?? GitHubCommentThreadKind.REVIEW_THREAD,
    path:
      overrides.path === undefined
        ? "apps/api/app/branches/branch-comments-service.ts"
        : overrides.path,
    line: overrides.line === undefined ? 12 : overrides.line,
    originalLine: overrides.originalLine ?? null,
  };
  const externalAuthor =
    overrides.externalAuthor === null
      ? null
      : {
          providerLogin:
            overrides.providerLogin === undefined
              ? "reviewer"
              : overrides.providerLogin,
          displayName:
            overrides.displayName === undefined ? null : overrides.displayName,
          avatarUrl:
            overrides.avatarUrl === undefined ? null : overrides.avatarUrl,
          profileUrl:
            overrides.profileUrl === undefined ? null : overrides.profileUrl,
          providerDetail:
            overrides.providerDetail === undefined
              ? { actorType: GitHubActorType.Bot }
              : overrides.providerDetail,
        };
  const githubProjection =
    overrides.githubProjection === null
      ? null
      : {
          githubCommentId:
            overrides.githubCommentId === undefined
              ? "123456"
              : overrides.githubCommentId,
          githubInReplyToCommentId:
            overrides.githubInReplyToCommentId === undefined
              ? null
              : overrides.githubInReplyToCommentId,
          githubHtmlUrl:
            overrides.githubHtmlUrl === undefined
              ? "https://github.com/closedloop-ai/closedloop-ai/pull/42#discussion_r123456"
              : overrides.githubHtmlUrl,
          githubUpdatedAt:
            overrides.githubUpdatedAt === undefined
              ? new Date("2026-07-03T10:02:00.000Z")
              : overrides.githubUpdatedAt,
          githubDeletedAt: null,
          externalAuthor,
        };
  return {
    id: overrides.id ?? "comment-1",
    body:
      overrides.body === undefined
        ? { markdown: "Please cover desktop parity." }
        : overrides.body,
    plainText:
      overrides.plainText === undefined
        ? "Please cover desktop parity."
        : overrides.plainText,
    createdAt: overrides.createdAt ?? new Date("2026-07-03T10:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-07-03T10:01:00.000Z"),
    deletedAt: null,
    syncStates: (overrides.syncStates ?? []).map((state) => ({ state })),
    githubProjection,
    thread: {
      id: "thread-1",
      status: overrides.threadStatus ?? ThreadStatus.OPEN,
      githubProjection:
        overrides.threadGithubProjection === undefined
          ? defaultThreadProjection
          : overrides.threadGithubProjection,
    },
  };
}
