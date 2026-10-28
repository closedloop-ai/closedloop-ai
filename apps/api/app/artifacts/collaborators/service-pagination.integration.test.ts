import { randomUUID } from "node:crypto";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { CollaboratorArtifactType } from "@repo/api/src/types/artifact-collaborators";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import { ThreadSource } from "@repo/api/src/types/comment";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import {
  branchCollaboratorIdentityCtesSql,
  branchCollaboratorIdentityJoinSql,
} from "@/app/branches/branch-list-sql/branch-list-identity-sql";
import { BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT } from "@/app/branches/branch-read-service/collaborator-source-evidence";
import { resolveBranchDetailIdentityData } from "@/app/branches/branch-read-service/identity-attribution";
import { githubShadowClerkId } from "@/app/comments/github-shadow-identity";
import { chunksOf } from "@/lib/chunks-of";
import { artifactCollaboratorsService } from "./service";

const BRANCH_LINK_PAGE_SIZE = 5000;

const tracker = createCommittedTestOrganizationTracker();
const REPOSITORY = "acme/app";
const TIMESTAMP = new Date("2026-09-01T00:00:00.000Z");
const INSERT_CHUNK_SIZE = 1000;
const BEFORE_SHA = "a".repeat(40);
const AFTER_SHA = "b".repeat(40);

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-10992 Branch batch pagination against PostgreSQL",
  () => {
    afterEach(() => tracker.cleanup());

    it("retains a later Branch's commenter after a full earlier link page", async () => {
      const organizationId = await tracker.create();
      const owner = await createTestUser(organizationId);
      const commenter = await createTestUser(organizationId);
      const computeTargetId = await withDb(async (db) => {
        const target = await db.computeTarget.create({
          data: {
            organizationId,
            userId: owner.id,
            machineName: "iss10992-pagination",
            platform: "darwin",
          },
          select: { id: true },
        });
        return target.id;
      });
      const branchOneId = await seedBranch(
        organizationId,
        "feature/first-page"
      );
      const branchTwoId = await seedBranch(
        organizationId,
        "feature/later-page"
      );
      const [firstBranchId, laterBranchId] = [branchOneId, branchTwoId].sort();
      if (!(firstBranchId && laterBranchId)) {
        throw new Error("Branch fixtures were not created");
      }
      const sessionIds = Array.from({ length: BRANCH_LINK_PAGE_SIZE + 1 }, () =>
        randomUUID()
      );
      const laterSessionId = sessionIds[BRANCH_LINK_PAGE_SIZE];
      if (!laterSessionId) {
        throw new Error("last Session fixture was not created");
      }
      for (const chunk of chunksOf(
        sessionIds.map((id, index) => ({ id, index })),
        INSERT_CHUNK_SIZE
      )) {
        await withDb(async (db) => {
          await db.artifact.createMany({
            data: chunk.map(({ id, index }) => ({
              id,
              organizationId,
              type: ArtifactType.Session,
              name: `page-session-${index}`,
              status: SESSION_STATUS.ACTIVE,
            })),
          });
          await db.sessionDetail.createMany({
            data: chunk.map(({ id, index }) => ({
              artifactId: id,
              computeTargetId,
              externalSessionId: `page-session-${index}`,
              harness: "claude",
              sessionStartedAt: TIMESTAMP,
              sessionUpdatedAt: TIMESTAMP,
              lastActivityAt: TIMESTAMP,
              estimatedCost: 0,
            })),
          });
          await db.artifactLink.createMany({
            data: chunk.map(({ id, index }) => ({
              organizationId,
              sourceId: id,
              targetId:
                index < BRANCH_LINK_PAGE_SIZE ? firstBranchId : laterBranchId,
              linkType: LinkType.RelatesTo,
              branchParticipation: BranchParticipationKind.Wrote,
              metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
            })),
          });
        });
      }
      await withDb(async (db) => {
        const thread = await db.commentThread.create({
          data: {
            organizationId,
            artifactId: laterSessionId,
            source: ThreadSource.Native,
          },
          select: { id: true },
        });
        await db.comment.create({
          data: {
            threadId: thread.id,
            authorId: commenter.id,
            body: {},
            bodyFormat: CommentBodyFormat.RichV1,
          },
          select: { id: true },
        });
      });

      const result = await artifactCollaboratorsService.readBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: [firstBranchId, laterBranchId],
        }
      );

      expect(result.results.map((entry) => entry.artifactId)).toEqual([
        firstBranchId,
        laterBranchId,
      ]);
      expect(result.results[0]?.collaborators.people).toEqual([]);
      expect(result.results[1]?.collaborators.people).toEqual([
        expect.objectContaining({
          provider: BranchPersonProvider.ClosedLoop,
          userId: commenter.id,
        }),
      ]);
      const detail = await withDb((db) =>
        resolveBranchDetailIdentityData(db, organizationId, {
          id: laterBranchId,
          assigneeId: null,
          branch: { firstPushedAt: null },
          pullRequestDetails: [],
        })
      );
      expect(
        detail.identityByBranch.get(laterBranchId)?.collaborators.people
      ).toEqual(result.results[1]?.collaborators.people);
      const sql = await readSqlIdentity(organizationId, laterBranchId);
      expect(sql.collaboratorKeys).toEqual([
        `${BranchPersonProvider.ClosedLoop}:${commenter.id}`,
      ]);
    });

    it("retains later PR authors and pushers with per-Branch SQL parity", async () => {
      const organizationId = await tracker.create();
      const branchOneName = "feature/authors-first";
      const branchTwoName = "feature/authors-later";
      const branchOneId = await seedBranch(
        organizationId,
        branchOneName,
        BranchIdentityAvailability.Complete
      );
      const branchTwoId = await seedBranch(
        organizationId,
        branchTwoName,
        BranchIdentityAvailability.Complete
      );
      const [firstBranchId, laterBranchId] = [branchOneId, branchTwoId].sort();
      const branchNames = new Map([
        [branchOneId, branchOneName],
        [branchTwoId, branchTwoName],
      ]);
      const firstBranchName = branchNames.get(firstBranchId);
      const laterBranchName = branchNames.get(laterBranchId);
      if (
        !(firstBranchId && laterBranchId && firstBranchName && laterBranchName)
      ) {
        throw new Error("Branch fixtures were not created");
      }
      const rows = Array.from(
        { length: BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT + 1 },
        (_, index) => ({
          index,
          later: index === BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT,
        })
      );
      for (const chunk of chunksOf(rows, INSERT_CHUNK_SIZE)) {
        await withDb(async (db) => {
          await db.pullRequestDetail.createMany({
            data: chunk.map(({ index, later }) => ({
              organizationId,
              branchArtifactId: later ? laterBranchId : firstBranchId,
              repositoryFullName: REPOSITORY,
              number: index + 1,
              authorProviderUserId: later ? "456" : "123",
              authorActorType: GitHubActorType.User,
              authorLogin: later ? "later-author" : "first-author",
            })),
          });
          await db.branchPushContribution.createMany({
            data: chunk.map(({ index, later }) => ({
              organizationId,
              branchArtifactId: later ? laterBranchId : firstBranchId,
              repositoryFullName: REPOSITORY,
              refName: later ? laterBranchName : firstBranchName,
              beforeSha: BEFORE_SHA,
              afterSha: AFTER_SHA,
              source: BranchPushContributionSource.GraphqlPush,
              sourceEventId: `push-${index}`,
              providerUserId: later ? "999" : "789",
              actorType: GitHubActorType.User,
              observedAt: TIMESTAMP,
            })),
          });
        });
      }

      const batch = await artifactCollaboratorsService.readBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: [firstBranchId, laterBranchId],
        }
      );
      const later = batch.results[1];
      expect(later?.collaborators.people.map((person) => person.id)).toEqual([
        "456",
        "999",
      ]);
      expect(later?.collaborators.sources).toMatchObject({
        [BranchCollaboratorSource.PullRequestAuthors]:
          BranchIdentityAvailability.Complete,
        [BranchCollaboratorSource.Pushes]: BranchIdentityAvailability.Complete,
      });
      const detail = await withDb((db) =>
        resolveBranchDetailIdentityData(db, organizationId, {
          id: laterBranchId,
          assigneeId: null,
          branch: { firstPushedAt: null },
          pullRequestDetails: [{ authorLogin: null }],
        })
      );
      expect(
        detail.identityByBranch.get(laterBranchId)?.collaborators.people
      ).toEqual(later?.collaborators.people);
      const sql = await readSqlIdentity(organizationId, laterBranchId);
      expect(sql.collaboratorKeys.sort()).toEqual([
        `${BranchPersonProvider.GitHub}:456`,
        `${BranchPersonProvider.GitHub}:999`,
      ]);
      expect(sql.collaboratorAvailability).toBe(
        later?.collaborators.availability
      );
    });

    it("leaves known shadow comment actors unclassified in batch, detail, and SQL", async () => {
      const organizationId = await tracker.create();
      const owner = await createTestUser(organizationId);
      const shadow = await createTestUser(organizationId);
      await withDb((db) =>
        db.user.update({
          where: { id: shadow.id },
          data: { clerkId: githubShadowClerkId(organizationId, "123") },
          select: { id: true },
        })
      );
      const branchId = await seedBranch(
        organizationId,
        "feature/shadow-comment",
        BranchIdentityAvailability.Complete
      );
      const sessionId = await linkValidSessionToBranch({
        organizationId,
        userId: owner.id,
        branchArtifactId: branchId,
        label: "shadow-comment-session",
        linkKind: SessionArtifactLinkKind.SessionBranch,
      });
      await withDb(async (db) => {
        for (const artifactId of [branchId, sessionId]) {
          await db.commentThread.create({
            data: {
              organizationId,
              artifactId,
              source: ThreadSource.Native,
              createdById: shadow.id,
              comments: {
                create: {
                  authorId: shadow.id,
                  body: {},
                  bodyFormat: CommentBodyFormat.RichV1,
                },
              },
            },
            select: { id: true },
          });
        }
      });

      const batch = await artifactCollaboratorsService.readBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: [branchId],
        }
      );
      const collaborators = batch.results[0]?.collaborators;
      expect(collaborators?.people).toEqual([]);
      expect(collaborators?.sources).toMatchObject({
        [BranchCollaboratorSource.BranchComments]:
          BranchIdentityAvailability.Incomplete,
        [BranchCollaboratorSource.SessionComments]:
          BranchIdentityAvailability.Incomplete,
      });
      const detail = await withDb((db) =>
        resolveBranchDetailIdentityData(db, organizationId, {
          id: branchId,
          assigneeId: null,
          branch: { firstPushedAt: null },
          pullRequestDetails: [],
        })
      );
      expect(detail.identityByBranch.get(branchId)?.collaborators).toEqual(
        collaborators
      );
      const sql = await readSqlIdentity(organizationId, branchId);
      expect(sql.collaboratorKeys).toEqual([]);
      expect(sql.collaboratorAvailability).toBe(
        BranchIdentityAvailability.Incomplete
      );
    });
  }
);

function seedBranch(
  organizationId: string,
  branchName: string,
  pushCoverageAvailability?: BranchIdentityAvailability
) {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
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
            ...(pushCoverageAvailability ? { pushCoverageAvailability } : {}),
          },
        },
      },
      select: { id: true },
    });
    return artifact.id;
  });
}

async function readSqlIdentity(organizationId: string, branchId: string) {
  const rows = await withDb((db) =>
    db.$queryRaw<
      { collaboratorKeys: string[]; collaboratorAvailability: string }[]
    >(Prisma.sql`
      WITH ${branchCollaboratorIdentityCtesSql(Prisma.sql`SELECT ${branchId}::uuid AS id`)}
      SELECT branch_collaborator_identity.collaborator_keys AS "collaboratorKeys",
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
    throw new Error("Branch SQL identity row was not found");
  }
  return row;
}
