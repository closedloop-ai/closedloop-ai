import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  type BranchPerson,
  BranchPersonProvider,
  branchPersonKey,
} from "@repo/api/src/types/branch-identity";
import { ThreadSource } from "@repo/api/src/types/comment";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { CommitProvenanceSource } from "@repo/api/src/types/commit";
import {
  BRANCH_PUSH_METHOD_VALUES,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactType,
  ExternalCommentProvider,
  GitHubCommentThreadKind,
  Prisma,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { BRANCH_OWNER_UNATTRIBUTED_LABEL } from "@repo/lib/branches/branch-list-page";
import { linkValidSessionToBranch } from "@/__tests__/utils/db-helpers";
import {
  branchListOwnerColumnsSql,
  branchListOwnerJoinSql,
} from "@/app/branches/branch-list-sql/branch-list-dimension-sql";
import {
  branchCollaboratorIdentityCtesSql,
  branchCollaboratorIdentityJoinSql,
} from "@/app/branches/branch-list-sql/branch-list-identity-sql";
import { seedBranchOwners } from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { branchPullRequestDetailOrderBy } from "@/app/branches/branch-read-selects";
import {
  type BranchIdentityProjection,
  identityInputs,
  resolveBranchIdentities,
} from "@/app/branches/branch-read-service/identity-attribution";
import {
  getSessionUsageByBranch,
  type SessionBranchIdentityEvidence,
} from "@/app/branches/branch-read-service/session-usage-window";

/**
 * ISS-10298 — the shared corpus/oracle harness behind the two Branches-list
 * identity SQL suites (`branch-list-identity-sql.integration.test.ts` for the
 * owner half, `branch-list-identity-collaborators.integration.test.ts` for the
 * collaborator half).
 *
 * `readIdentityProjections` is the oracle: it reads the SQL projection and the
 * production JavaScript projector (`resolveBranchIdentities`) over the same
 * seeded branch, so a case asserts the two AGREE rather than restating a
 * hand-written expectation that could agree with a shared mistake.
 *
 * ISS-12463: the Owner both sides read is the branch's assignee. The oracle
 * first runs the production seed, which writes the assignee from the evidence a
 * case seeded, so the owner cases still name the person that evidence names.
 */

/**
 * Each suite derives its own `describeIfDb` from this rather than importing a
 * ready-made one: a `describe | describe.skip` union cannot be exported from a
 * module (TS4023 — vitest's `SuiteCollectorCallable` is not nameable here).
 */
export const HAS_DATABASE = Boolean(keys().DATABASE_URL);

export const FIRST_PUSHED_AT = new Date("2026-07-01T00:00:00.000Z");
export const LATER_PUSHED_AT = new Date("2026-07-02T00:00:00.000Z");
export const [GIT_PUSH_METHOD] = BRANCH_PUSH_METHOD_VALUES;
export const NON_PUSH_METHOD = "git_command";

export type IdentitySqlRow = {
  ownerKey: string | null;
  ownerLabel: string | null;
  ownerAvailability: string;
  collaboratorKeys: string[];
  collaboratorLabels: string[];
  collaboratorAvailability: string;
};

export function closedloopKey(userId: string): string {
  return `${BranchPersonProvider.ClosedLoop}:${userId}`;
}

/** The single display string the SQL projects as `*_label`. */
function personLabel(person: BranchPerson): string | null {
  return person.displayName ?? person.login ?? null;
}

export async function renameUser(
  userId: string,
  firstName: string,
  lastName: string
): Promise<void> {
  await withDb((db) =>
    db.user.update({
      where: { id: userId },
      data: { firstName, lastName },
      select: { id: true },
    })
  );
}

export async function seedBranch(
  organizationId: string,
  branchName: string,
  options: { firstPushedAt: Date | null }
): Promise<string> {
  return await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: branchName,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryFullName: `acme/${branchName}`,
        branchName,
        firstPushedAt: options.firstPushedAt,
        pushSource: options.firstPushedAt ? BranchPushSource.Session : null,
        lastActivityAt: FIRST_PUSHED_AT,
      },
      select: { artifactId: true },
    });
    return artifact.id;
  });
}

/** @returns the seeded SESSION artifact id, so a case can mutate its detail row. */
export async function seedEvidenceLink(params: {
  organizationId: string;
  branchId: string;
  userId: string;
  label: string;
  method: string;
  observedAt: Date | null;
}): Promise<string> {
  const sessionArtifactId = await linkValidSessionToBranch({
    organizationId: params.organizationId,
    userId: params.userId,
    branchArtifactId: params.branchId,
    label: params.label,
    linkKind: SessionArtifactLinkKind.SessionBranch,
  });
  await withDb((db) =>
    db.artifactLink.updateMany({
      where: {
        organizationId: params.organizationId,
        sourceId: sessionArtifactId,
        targetId: params.branchId,
      },
      data: {
        branchParticipationMethod: params.method,
        branchParticipationObservedAt: params.observedAt,
      },
    })
  );
  return sessionArtifactId;
}

export async function seedNativeComment(params: {
  organizationId: string;
  artifactId: string;
  authorId: string;
}): Promise<void> {
  await withDb(async (db) => {
    const thread = await db.commentThread.create({
      data: {
        organizationId: params.organizationId,
        artifactId: params.artifactId,
        source: ThreadSource.Native,
      },
      select: { id: true },
    });
    await db.comment.create({
      data: {
        threadId: thread.id,
        authorId: params.authorId,
        body: {},
        bodyFormat: CommentBodyFormat.RichV1,
      },
      select: { id: true },
    });
  });
}

export async function seedPullRequestDetail(
  organizationId: string,
  branchId: string,
  label: string,
  authorLogin?: string
): Promise<string> {
  return await withDb(async (db) => {
    const pullRequest = await db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId: branchId,
        repositoryFullName: `acme/${label}`,
        number: 1,
        ...(authorLogin === undefined ? {} : { authorLogin }),
      },
      select: { id: true },
    });
    return pullRequest.id;
  });
}

/**
 * ISS-11765 — a commit on the branch, for the owner chain's commit-author rung.
 *
 * `committedAt` is nullable on purpose: the undated commit is the case
 * `committed_at ASC NULLS LAST` exists to order, so a case has to be able to
 * seed one.
 */
export async function seedCommit(params: {
  organizationId: string;
  branchId: string;
  sha: string;
  authorLogin: string | null;
  committedAt: Date | null;
}): Promise<void> {
  await withDb((db) =>
    db.commitDetail.create({
      data: {
        organizationId: params.organizationId,
        branchArtifactId: params.branchId,
        repositoryFullName: `acme/${params.sha}`,
        sha: params.sha,
        authorLogin: params.authorLogin,
        committedAt: params.committedAt,
        source: CommitProvenanceSource.PushWebhook,
      },
      select: { id: true },
    })
  );
}

/** ISS-11765 — the `github_user_connections` row both inferred rungs resolve through. */
export async function seedGitHubConnection(params: {
  organizationId: string;
  userId: string;
  login: string;
}): Promise<void> {
  await withDb((db) =>
    db.gitHubUserConnection.create({
      data: {
        organizationId: params.organizationId,
        userId: params.userId,
        githubUserId: `gh-${params.userId}`,
        login: params.login,
        normalizedLogin: params.login.toLowerCase(),
      },
      select: { id: true },
    })
  );
}

export async function seedGitHubComment(params: {
  organizationId: string;
  branchId: string;
  label: string;
  author: {
    userId: string;
    providerUserId: string;
    providerLogin: string;
    displayName: string;
    providerDetail: Prisma.InputJsonObject | null;
    /**
     * The tenant the author row is filed under, when it is NOT the branch's.
     * `github_comment_projections` has no `organization_id`, so its
     * `external_author_id` FK is single-column and the database accepts this
     * cross-tenant pairing — which is the whole point of the case that uses it.
     */
    organizationId?: string;
  };
}): Promise<void> {
  const pullRequestDetailId = await seedPullRequestDetail(
    params.organizationId,
    params.branchId,
    params.label
  );
  await withDb(async (db) => {
    const externalAuthor = await db.externalCommentAuthor.create({
      data: {
        organizationId: params.author.organizationId ?? params.organizationId,
        provider: ExternalCommentProvider.GITHUB,
        providerUserId: params.author.providerUserId,
        providerLogin: params.author.providerLogin,
        normalizedProviderLogin: params.author.providerLogin.toLowerCase(),
        displayName: params.author.displayName,
        userId: params.author.userId,
        ...(params.author.providerDetail
          ? { providerDetail: params.author.providerDetail }
          : {}),
      },
      select: { id: true },
    });
    const thread = await db.commentThread.create({
      data: {
        organizationId: params.organizationId,
        artifactId: params.branchId,
        source: ThreadSource.Github,
      },
      select: { id: true },
    });
    await db.gitHubCommentThreadProjection.create({
      data: {
        threadId: thread.id,
        branchArtifactId: params.branchId,
        pullRequestDetailId,
        threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
      },
      select: { threadId: true },
    });
    const comment = await db.comment.create({
      data: {
        threadId: thread.id,
        authorId: params.author.userId,
        body: {},
        bodyFormat: CommentBodyFormat.Markdown,
      },
      select: { id: true },
    });
    await db.gitHubCommentProjection.create({
      data: {
        commentId: comment.id,
        threadId: thread.id,
        externalAuthorId: externalAuthor.id,
        githubCommentId: `gh-comment-${params.label}`,
      },
      select: { commentId: true },
    });
  });
}

function readIdentitySql(
  organizationId: string,
  branchId: string
): Promise<IdentitySqlRow[]> {
  return withDb((db) =>
    db.$queryRaw<IdentitySqlRow[]>(Prisma.sql`
      WITH ${branchCollaboratorIdentityCtesSql(Prisma.sql`SELECT ${branchId}::uuid AS id`)}
      SELECT
        list_owner.owner_key AS "ownerKey",
        list_owner.owner_label AS "ownerLabel",
        list_owner.owner_availability AS "ownerAvailability",
        branch_collaborator_identity.collaborator_keys AS "collaboratorKeys",
        branch_collaborator_identity.collaborator_labels AS "collaboratorLabels",
        branch_collaborator_identity.collaborator_availability AS "collaboratorAvailability"
      FROM artifacts a
      INNER JOIN branch_detail b
        ON b.artifact_id = a.id
      ${branchListOwnerJoinSql()}
      CROSS JOIN LATERAL (SELECT ${branchListOwnerColumnsSql()}) list_owner
      ${branchCollaboratorIdentityJoinSql()}
      WHERE a.organization_id = ${organizationId}::uuid
        AND a.id = ${branchId}::uuid
        AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
    `)
  );
}

function readIdentityJs(
  organizationId: string,
  branchId: string
): Promise<BranchIdentityProjection | undefined> {
  return withDb(async (db) => {
    const evidence: SessionBranchIdentityEvidence[] = [];
    await getSessionUsageByBranch(db, organizationId, [branchId], {
      identityEvidenceOut: evidence,
    });
    const row = await db.artifact.findUniqueOrThrow({
      where: { id: branchId },
      select: {
        assigneeId: true,
        branch: { select: { firstPushedAt: true } },
        // The PR AUTHORS, in the production read's own PR order
        // (`branchPullRequestDetailOrderBy`) — the PR-author Collaborator
        // candidates cannot be exercised from a PR list with no `authorLogin`.
        pullRequestDetails: {
          select: { id: true, authorLogin: true },
          orderBy: branchPullRequestDetailOrderBy,
        },
      },
    });
    const projections = await resolveBranchIdentities(
      db,
      organizationId,
      // Production's own input mapper, not a restatement of it: the PR-author
      // rung reads `pullRequestAuthorLogins`, which only `identityInputs`
      // derives (and which drops `''`, ISS-8155).
      identityInputs([
        {
          id: branchId,
          assigneeId: row.assigneeId,
          branch: { firstPushedAt: row.branch?.firstPushedAt ?? null },
          pullRequestDetails: row.pullRequestDetails,
        },
      ]),
      evidence
    );
    return projections.get(branchId);
  });
}

/** The JS projection rendered in the SQL projection's own shape. */
function expectedSqlRow(js: BranchIdentityProjection): IdentitySqlRow {
  const owner = js.ownerIdentity.person;
  return {
    ownerKey: owner ? branchPersonKey(owner) : BRANCH_OWNER_UNATTRIBUTED_LABEL,
    ownerLabel: owner ? personLabel(owner) : BRANCH_OWNER_UNATTRIBUTED_LABEL,
    ownerAvailability: js.ownerIdentity.availability,
    collaboratorKeys: js.collaborators.people.map(branchPersonKey),
    collaboratorLabels: js.collaborators.people.map(
      (person) => personLabel(person) ?? ""
    ),
    collaboratorAvailability: js.collaborators.availability,
  };
}

export async function readIdentityProjections(
  organizationId: string,
  branchId: string
): Promise<{ sql: IdentitySqlRow; expected: IdentitySqlRow }> {
  await withDb.tx((tx) => seedBranchOwners(tx, organizationId, [branchId]));
  const [rows, js] = await Promise.all([
    readIdentitySql(organizationId, branchId),
    readIdentityJs(organizationId, branchId),
  ]);
  const sql = rows[0];
  if (!(sql && js)) {
    throw new Error("readIdentityProjections: missing projection");
  }
  return { sql, expected: expectedSqlRow(js) };
}

export async function readAssignee(branchId: string): Promise<string | null> {
  const row = await withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: branchId },
      select: { assigneeId: true },
    })
  );
  return row.assigneeId;
}
