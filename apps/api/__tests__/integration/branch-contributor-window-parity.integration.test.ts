import { randomUUID } from "node:crypto";
import { CollaboratorArtifactType } from "@repo/api/src/types/artifact-collaborators";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
} from "@repo/api/src/types/branch-identity";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import { ThreadSource } from "@repo/api/src/types/comment";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubCommentThreadKind, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  AFTER_SHA,
  BEFORE_SHA,
  closedloopKey,
  FIRST_PUSHED_AT,
  personKey,
  REPOSITORY,
  readSql,
  seedBranch,
  seedExternalAuthor,
  seedPullRequest,
} from "@/__tests__/support/branches/contributor-parity.test-fixtures";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { artifactCollaboratorsService } from "@/app/artifacts/collaborators/service";
import { BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT } from "@/app/branches/branch-read-service/collaborator-source-evidence";
import {
  readPullRequestAuthorWindow,
  readPushContributionWindow,
} from "@/app/branches/branch-read-service/contributor-source-windows";
import { resolveBranchIdentities } from "@/app/branches/branch-read-service/identity-attribution";
import { chunksOf } from "@/lib/chunks-of";

const tracker = createCommittedTestOrganizationTracker();
const INSERT_CHUNK_SIZE = 500;

describe.skipIf(!keys().DATABASE_URL)(
  "bounded contributor source parity",
  () => {
    afterEach(() => tracker.cleanup());

    it("bounds PR admission per Branch and prevents stale refs from spending the current pusher window", async () => {
      const organizationId = await tracker.create();
      const branchId = await seedBranch(organizationId, "feature/current", {
        firstPushedAt: null,
        pushCoverageAvailability: BranchIdentityAvailability.Complete,
      });
      const laterBranchId = await seedBranch(organizationId, "feature/later", {
        firstPushedAt: null,
        pushCoverageAvailability: BranchIdentityAvailability.Complete,
      });
      const history = Array.from(
        { length: BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT + 2 },
        (_, index) => index
      );
      for (const chunk of chunksOf(history, INSERT_CHUNK_SIZE)) {
        await withDb(async (db) => {
          await db.pullRequestDetail.createMany({
            data: chunk.map((index) => ({
              organizationId,
              branchArtifactId: branchId,
              repositoryFullName: REPOSITORY,
              number: index + 1,
              authorProviderUserId: "123",
              authorActorType: GitHubActorType.User,
              authorLogin: "author",
            })),
          });
          await db.branchPushContribution.createMany({
            data: chunk.map((index) => ({
              organizationId,
              branchArtifactId: branchId,
              repositoryFullName: REPOSITORY,
              refName: "feature/old",
              source: BranchPushContributionSource.GraphqlPush,
              sourceEventId: `old-${index}`,
              providerUserId: "456",
              actorType: GitHubActorType.User,
              beforeSha: BEFORE_SHA,
              afterSha: AFTER_SHA,
              observedAt: FIRST_PUSHED_AT,
            })),
          });
        });
      }
      await seedPullRequest(
        organizationId,
        laterBranchId,
        history.length + 1,
        "999",
        GitHubActorType.User
      );
      await withDb((db) =>
        db.branchPushContribution.create({
          data: {
            organizationId,
            branchArtifactId: branchId,
            repositoryFullName: REPOSITORY,
            refName: "feature/current",
            source: BranchPushContributionSource.GraphqlPush,
            sourceEventId: "current",
            providerUserId: "789",
            actorType: GitHubActorType.User,
            beforeSha: BEFORE_SHA,
            afterSha: AFTER_SHA,
            observedAt: new Date(FIRST_PUSHED_AT.getTime() + 1),
          },
        })
      );
      const input = {
        organizationId,
        branchIds: [branchId, laterBranchId],
        limit: BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT,
      };
      const windows = await withDb(async (db) => ({
        authors: await readPullRequestAuthorWindow(db, input),
        pushes: await readPushContributionWindow(db, input),
      }));
      expect(
        windows.authors.filter((row) => row.branchArtifactId === branchId)
      ).toHaveLength(BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT + 1);
      expect(
        windows.authors.filter((row) => row.branchArtifactId === laterBranchId)
      ).toHaveLength(1);
      expect(windows.pushes.rows.map((row) => row.providerUserId)).toEqual([
        "789",
      ]);
      expect(windows.pushes.mismatchedBranchIds).toEqual(new Set([branchId]));
      const batch = await artifactCollaboratorsService.readBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: input.branchIds,
        }
      );
      const identities = await withDb((db) =>
        resolveBranchIdentities(
          db,
          organizationId,
          input.branchIds.map((id) => ({
            branchId: id,
            assigneeId: null,
            firstPushedAt: null,
            associatedPullRequestCount: id === branchId ? history.length : 1,
          })),
          []
        )
      );
      for (const id of input.branchIds) {
        const people = batch.results
          .find((item) => item.artifactId === id)
          ?.collaborators.people.map(personKey);
        expect(people).toEqual(
          id === branchId ? ["github:123", "github:789"] : ["github:999"]
        );
        expect(identities.get(id)?.collaborators.people.map(personKey)).toEqual(
          people
        );
        expect((await readSql(organizationId, id)).collaboratorKeys).toEqual(
          people
        );
      }
      const first = batch.results.find((item) => item.artifactId === branchId);
      const later = batch.results.find(
        (item) => item.artifactId === laterBranchId
      );
      if (
        first?.artifactType !== CollaboratorArtifactType.Branch ||
        later?.artifactType !== CollaboratorArtifactType.Branch
      ) {
        throw new Error("Branch batch omitted an authorized fixture");
      }
      expect(
        first?.collaborators.sources[
          BranchCollaboratorSource.PullRequestAuthors
        ]
      ).toBe(BranchIdentityAvailability.Incomplete);
      expect(
        first?.collaborators.sources[BranchCollaboratorSource.Pushes]
      ).toBe(BranchIdentityAvailability.Incomplete);
      expect(
        later.collaborators.sources[BranchCollaboratorSource.PullRequestAuthors]
      ).toBe(BranchIdentityAvailability.Complete);
    }, 20_000);

    it("excludes source-object ghost authors while preserving a supported node identity and Bot exclusion", async () => {
      const organizationId = await tracker.create();
      const human = await createTestUser(organizationId);
      const ghost = await createTestUser(organizationId);
      const bot = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "feature/ghost", {
        firstPushedAt: null,
      });
      await seedPullRequest(
        organizationId,
        branchId,
        1,
        "66",
        GitHubActorType.Bot
      );
      for (const [userId, providerId, actorType] of [
        [human.id, "node:node-123", GitHubActorType.User],
        [ghost.id, "ghost:issue_comment:1", GitHubActorType.User],
        [bot.id, "77", GitHubActorType.Bot],
      ] as const) {
        await seedExternalAuthor(
          organizationId,
          userId,
          providerId,
          "provider-account"
        );
        await withDb(async (db) => {
          const author = await db.externalCommentAuthor.findFirstOrThrow({
            where: { organizationId, providerUserId: providerId },
            select: { id: true },
          });
          await db.externalCommentAuthor.update({
            where: { id: author.id },
            data: { providerDetail: { actorType } },
            select: { id: true },
          });
          const pr = await db.pullRequestDetail.findFirstOrThrow({
            where: { organizationId, branchArtifactId: branchId, number: 1 },
            select: { id: true },
          });
          const thread = await db.commentThread.create({
            data: {
              organizationId,
              artifactId: branchId,
              source: ThreadSource.Github,
            },
            select: { id: true },
          });
          await db.gitHubCommentThreadProjection.create({
            data: {
              threadId: thread.id,
              branchArtifactId: branchId,
              pullRequestDetailId: pr.id,
              threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
            },
            select: { threadId: true },
          });
          const comment = await db.comment.create({
            data: {
              threadId: thread.id,
              authorId: userId,
              body: "comment",
              bodyFormat: CommentBodyFormat.Markdown,
            },
            select: { id: true },
          });
          await db.gitHubCommentProjection.create({
            data: {
              commentId: comment.id,
              threadId: thread.id,
              externalAuthorId: author.id,
              githubCommentId: randomUUID(),
            },
            select: { commentId: true },
          });
        });
      }
      const batch = await artifactCollaboratorsService.readBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: [branchId],
        }
      );
      expect(batch.results[0]?.collaborators.people.map(personKey)).toEqual([
        closedloopKey(human.id),
      ]);
      expect(
        (await readSql(organizationId, branchId)).collaboratorKeys
      ).toEqual([closedloopKey(human.id)]);
      const entry = batch.results[0];
      if (entry?.artifactType !== CollaboratorArtifactType.Branch) {
        throw new Error("Branch batch omitted its stored commenters");
      }
      expect(
        entry.collaborators.sources[
          BranchCollaboratorSource.PullRequestComments
        ]
      ).toBe(BranchIdentityAvailability.Incomplete);
    });
  }
);
