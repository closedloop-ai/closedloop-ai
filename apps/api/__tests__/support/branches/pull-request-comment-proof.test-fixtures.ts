import { randomUUID } from "node:crypto";
import { CollaboratorArtifactType } from "@repo/api/src/types/artifact-collaborators";
import {
  BranchCollaboratorSource,
  type BranchCollaborators,
  BranchIdentityAvailability,
  branchPersonKey,
} from "@repo/api/src/types/branch-identity";
import { ThreadSource } from "@repo/api/src/types/comment";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import {
  ExternalCommentProvider,
  GitHubCommentThreadKind,
  type PullRequestCommentLane,
  PullRequestCommentLaneStatus,
  withDb,
} from "@repo/database";
import type { GitHubCommentAuthor } from "@repo/github";
import { readSql } from "@/__tests__/support/branches/contributor-parity.test-fixtures";
import {
  GITHUB_TEST_AUTHOR,
  GITHUB_TEST_REPOSITORY,
  type GitHubCommentScope,
  seedGitHubCommentScope,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import { artifactCollaboratorsService } from "@/app/artifacts/collaborators/service";
import { branchPullRequestDetailOrderBy } from "@/app/branches/branch-read-selects";
import { resolveBranchDetailIdentityData } from "@/app/branches/branch-read-service/identity-attribution";
import { REQUIRED_PULL_REQUEST_COMMENT_LANES } from "@/app/comments/service/github/github-comment-acquisition-proof";

/** The PR author every proven fixture carries, so its PR-author source is complete. */
export const PULL_REQUEST_AUTHOR_ID = "5151";

export const HUMAN_AUTHOR: GitHubCommentAuthor = {
  ...GITHUB_TEST_AUTHOR,
  actorType: GitHubActorType.User,
};

/** A second GitHub human, distinct from {@link HUMAN_AUTHOR}. */
export const OTHER_HUMAN_AUTHOR: GitHubCommentAuthor = {
  id: 7373,
  login: "hubot-human",
  node_id: "U_7373",
  avatar_url: "https://avatars.example/7373",
  actorType: GitHubActorType.User,
};

export type HostCollaborators = {
  pullRequestComments: string | undefined;
  availability: string | undefined;
  people: string[];
};

export type Hosts = {
  batch: HostCollaborators;
  detail: HostCollaborators;
  sql: Pick<HostCollaborators, "availability" | "people">;
};

/**
 * A Branch with one current PR whose every source but PR comments is complete:
 * push coverage is complete (unless overridden) and the PR has a human author.
 */
export async function seedProvenScope(
  organizationId: string,
  options: {
    pushCoverageAvailability?: BranchIdentityAvailability;
    number?: number;
  } = {}
): Promise<GitHubCommentScope> {
  const scope = await seedGitHubCommentScope(organizationId, {
    number: options.number,
  });
  await withDb(async (db) => {
    await db.branchDetail.update({
      where: { artifactId: scope.branchArtifactId },
      data: {
        pushCoverageAvailability:
          options.pushCoverageAvailability ??
          BranchIdentityAvailability.Complete,
      },
      select: { artifactId: true },
    });
    await setPullRequestAuthor(db, scope.pullRequestDetailId);
  });
  return scope;
}

/** Another PR on the scope's Branch, with the same human author. */
export async function seedSecondPullRequest(
  scope: GitHubCommentScope
): Promise<GitHubCommentScope> {
  const pullRequest = await withDb(async (db) => {
    const created = await db.pullRequestDetail.create({
      data: {
        organizationId: scope.organizationId,
        branchArtifactId: scope.branchArtifactId,
        repositoryFullName: GITHUB_TEST_REPOSITORY,
        number: 43,
      },
      select: { id: true },
    });
    await setPullRequestAuthor(db, created.id);
    return created;
  });
  return { ...scope, pullRequestDetailId: pullRequest.id };
}

/** Writes `COMPLETE` proof for every required lane, without a reconcile. */
export async function seedCompleteProof(
  scope: GitHubCommentScope
): Promise<void> {
  const now = new Date();
  await withDb((db) =>
    db.pullRequestCommentAcquisition.createMany({
      data: REQUIRED_PULL_REQUEST_COMMENT_LANES.map((lane) => ({
        pullRequestDetailId: scope.pullRequestDetailId,
        organizationId: scope.organizationId,
        lane,
        generation: 1,
        status: PullRequestCommentLaneStatus.COMPLETE,
        itemCount: 0,
        listedAt: now,
        lastCompleteListedAt: now,
        incompleteStreak: 0,
        recordedAt: now,
      })),
    })
  );
}

export async function deleteLaneProof(
  scope: GitHubCommentScope,
  lane: PullRequestCommentLane
): Promise<void> {
  await withDb((db) =>
    db.pullRequestCommentAcquisition.deleteMany({
      where: { pullRequestDetailId: scope.pullRequestDetailId, lane },
    })
  );
}

/**
 * `count` stored issue comments on the scope's PR, all by one human GitHub
 * author linked to `userId`, written directly so no reconcile retracts them.
 */
export async function seedStoredGitHubComments(
  scope: GitHubCommentScope,
  userId: string,
  count: number
): Promise<void> {
  await withDb.tx(async (db) => {
    const author = await db.externalCommentAuthor.create({
      data: {
        organizationId: scope.organizationId,
        provider: ExternalCommentProvider.GITHUB,
        providerUserId: String(HUMAN_AUTHOR.id),
        providerLogin: HUMAN_AUTHOR.login,
        normalizedProviderLogin: HUMAN_AUTHOR.login,
        displayName: HUMAN_AUTHOR.login,
        providerDetail: { actorType: GitHubActorType.User },
        userId,
      },
      select: { id: true },
    });
    const thread = await db.commentThread.create({
      data: {
        organizationId: scope.organizationId,
        artifactId: scope.branchArtifactId,
        source: ThreadSource.Github,
      },
      select: { id: true },
    });
    await db.gitHubCommentThreadProjection.create({
      data: {
        threadId: thread.id,
        branchArtifactId: scope.branchArtifactId,
        pullRequestDetailId: scope.pullRequestDetailId,
        threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
      },
      select: { threadId: true },
    });
    const commentIds = Array.from({ length: count }, () => randomUUID());
    await db.comment.createMany({
      data: commentIds.map((id) => ({
        id,
        threadId: thread.id,
        authorId: userId,
        body: {},
        bodyFormat: CommentBodyFormat.Markdown,
      })),
    });
    await db.gitHubCommentProjection.createMany({
      data: commentIds.map((commentId, index) => ({
        commentId,
        threadId: thread.id,
        externalAuthorId: author.id,
        githubCommentId: `capped-${index}`,
      })),
    });
  });
}

/**
 * The same Branch through the batch route's service, the Branch detail read
 * and the Branches-list SQL, in one comparable shape. The SQL projects no
 * per-source state, so its `pullRequestComments` is left undefined.
 */
export async function readHosts(
  organizationId: string,
  branchId: string
): Promise<Hosts & { pushes: (string | undefined)[] }> {
  const batch = await artifactCollaboratorsService.readBatch(organizationId, {
    artifactType: CollaboratorArtifactType.Branch,
    artifactIds: [branchId],
  });
  const entry = batch.results[0];
  if (entry?.artifactType !== CollaboratorArtifactType.Branch) {
    throw new Error("Branch batch omitted the fixture");
  }
  const detail = await withDb(async (db) => {
    const row = await db.artifact.findUniqueOrThrow({
      where: { id: branchId },
      select: {
        id: true,
        branch: { select: { firstPushedAt: true } },
        pullRequestDetails: {
          select: { authorLogin: true },
          orderBy: branchPullRequestDetailOrderBy,
        },
      },
    });
    const read = await resolveBranchDetailIdentityData(db, organizationId, {
      id: row.id,
      assigneeId: null,
      branch: { firstPushedAt: row.branch?.firstPushedAt ?? null },
      pullRequestDetails: row.pullRequestDetails,
    });
    return read.identityByBranch.get(branchId)?.collaborators;
  });
  if (!detail) {
    throw new Error("Branch detail omitted the fixture");
  }
  const sql = await readSql(organizationId, branchId);
  return {
    batch: hostCollaborators(entry.collaborators),
    detail: hostCollaborators(detail),
    pushes: [entry.collaborators, detail].map(
      (collaborators) => collaborators.sources[BranchCollaboratorSource.Pushes]
    ),
    sql: {
      availability: sql.collaboratorAvailability,
      people: [...sql.collaboratorKeys].sort(),
    },
  };
}

function hostCollaborators(
  collaborators: BranchCollaborators
): HostCollaborators {
  return {
    pullRequestComments:
      collaborators.sources[BranchCollaboratorSource.PullRequestComments],
    availability: collaborators.availability,
    people: collaborators.people.map(branchPersonKey).sort(),
  };
}

async function setPullRequestAuthor(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  pullRequestDetailId: string
): Promise<void> {
  await db.pullRequestDetail.update({
    where: { id: pullRequestDetailId },
    data: {
      authorProviderUserId: PULL_REQUEST_AUTHOR_ID,
      authorActorType: GitHubActorType.User,
      authorLogin: "pr-author",
    },
    select: { id: true },
  });
}
