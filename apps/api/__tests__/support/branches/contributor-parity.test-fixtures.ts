import { ArtifactType, BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchIdentityAvailability,
  type BranchPerson,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { ExternalCommentProvider, Prisma, withDb } from "@repo/database";
import {
  branchCollaboratorIdentityCtesSql,
  branchCollaboratorIdentityJoinSql,
} from "@/app/branches/branch-list-sql/branch-list-identity-sql";

export const REPOSITORY = "acme/app";
export const FIRST_PUSHED_AT = new Date("2026-09-01T00:00:00.000Z");
export const BEFORE_SHA = "a".repeat(40);
export const AFTER_SHA = "b".repeat(40);

type IdentityRow = {
  collaboratorKeys: string[];
  collaboratorLabels: string[];
  collaboratorAvailability: string;
};

export async function seedBranch(
  organizationId: string,
  branchName: string,
  options: {
    firstPushedAt?: Date | null;
    pushCoverageAvailability?: BranchIdentityAvailability | null;
  } = {}
): Promise<string> {
  const firstPushedAt =
    options.firstPushedAt === undefined
      ? FIRST_PUSHED_AT
      : options.firstPushedAt;
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.Branch,
        name: branchName,
        status: BranchStatus.Open,
        branch: {
          create: {
            organizationId,
            repositoryFullName: REPOSITORY,
            branchName,
            firstPushedAt,
            pushSource: firstPushedAt ? BranchPushSource.Session : null,
            pushCoverageAvailability:
              options.pushCoverageAvailability === undefined
                ? BranchIdentityAvailability.Incomplete
                : options.pushCoverageAvailability,
          },
        },
      },
      select: { id: true },
    })
  );
  return artifact.id;
}

export async function seedExternalAuthor(
  organizationId: string,
  userId: string,
  providerUserId: string,
  login: string
): Promise<void> {
  await withDb((db) =>
    db.externalCommentAuthor.create({
      data: {
        organizationId,
        provider: ExternalCommentProvider.GITHUB,
        providerUserId,
        providerLogin: login,
        normalizedProviderLogin: login,
        displayName: login,
        providerDetail: { actorType: GitHubActorType.User },
        userId,
      },
      select: { id: true },
    })
  );
}

export async function seedPullRequest(
  organizationId: string,
  branchArtifactId: string,
  number: number,
  authorProviderUserId: string,
  authorActorType: GitHubActorType
): Promise<void> {
  await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId,
        repositoryFullName: REPOSITORY,
        number,
        authorProviderUserId,
        authorActorType,
        authorLogin: authorProviderUserId,
      },
      select: { id: true },
    })
  );
}

export async function seedPush(
  organizationId: string,
  branchArtifactId: string,
  refName: string,
  providerUserId: string,
  sourceEventId: string,
  options: {
    source?: BranchPushContributionSource;
    afterSha?: string;
    actorType?: GitHubActorType;
    observedAt?: Date;
  } = {}
): Promise<void> {
  await withDb((db) =>
    db.branchPushContribution.create({
      data: {
        organizationId,
        branchArtifactId,
        repositoryFullName: REPOSITORY,
        refName,
        beforeSha: BEFORE_SHA,
        afterSha: options.afterSha ?? AFTER_SHA,
        source: options.source ?? BranchPushContributionSource.GraphqlPush,
        sourceEventId,
        providerUserId,
        actorType: options.actorType ?? GitHubActorType.User,
        observedAt: options.observedAt ?? FIRST_PUSHED_AT,
      },
      select: { id: true },
    })
  );
}

export async function readSql(
  organizationId: string,
  branchId: string
): Promise<IdentityRow> {
  const rows = await withDb((db) =>
    db.$queryRaw<IdentityRow[]>(Prisma.sql`
      WITH ${branchCollaboratorIdentityCtesSql(Prisma.sql`SELECT ${branchId}::uuid AS id`)}
      SELECT branch_collaborator_identity.collaborator_keys AS "collaboratorKeys",
        branch_collaborator_identity.collaborator_labels AS "collaboratorLabels",
        branch_collaborator_identity.collaborator_availability AS "collaboratorAvailability"
      FROM artifacts a
      JOIN branch_detail b ON b.artifact_id = a.id
      ${branchCollaboratorIdentityJoinSql()}
      WHERE a.organization_id = ${organizationId}::uuid
        AND a.id = ${branchId}::uuid
        AND a.type = ${ArtifactType.Branch}::"ArtifactType"
    `)
  );
  const row = rows[0];
  if (!row) {
    throw new Error("Branch identity row was not found");
  }
  return row;
}

export function closedloopKey(userId: string): string {
  return `${BranchPersonProvider.ClosedLoop}:${userId}`;
}

export function personKey(person: BranchPerson): string {
  return person.userId
    ? closedloopKey(person.userId)
    : `${person.provider}:${person.id}`;
}
