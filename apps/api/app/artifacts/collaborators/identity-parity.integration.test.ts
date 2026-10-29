import { CollaboratorArtifactType } from "@repo/api/src/types/artifact-collaborators";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
} from "@repo/api/src/types/branch-identity";
import { ThreadSource } from "@repo/api/src/types/comment";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubCommentThreadKind, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  closedloopKey,
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
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { seedBranchOwners } from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { resolveBranchDetailIdentityData } from "@/app/branches/branch-read-service/identity-attribution";
import { githubShadowClerkId } from "@/app/comments/github-shadow-identity";
import { artifactCollaboratorsService } from "./service";

const tracker = createCommittedTestOrganizationTracker();

describe.skipIf(!keys().DATABASE_URL)(
  "collaborator stable identity parity",
  () => {
    afterEach(() => tracker.cleanup());

    it("counts an inferred PR Owner as an author without treating that inference as a pusher", async () => {
      const organizationId = await tracker.create();
      const user = await createTestUser(organizationId);
      const branchId = await seedBranch(
        organizationId,
        "feature/inferred-owner",
        { firstPushedAt: null }
      );
      await withDb(async (db) => {
        await db.gitHubUserConnection.createMany({
          data: {
            organizationId,
            userId: user.id,
            githubUserId: "789",
            login: "inferred-owner",
            normalizedLogin: "inferred-owner",
          },
        });
        await db.pullRequestDetail.createMany({
          data: {
            organizationId,
            branchArtifactId: branchId,
            repositoryFullName: REPOSITORY,
            number: 1,
            authorLogin: "inferred-owner",
          },
        });
      });
      const batch = await artifactCollaboratorsService.readBoundedBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: [branchId],
        }
      );
      expect(batch.ok).toBe(true);
      if (!batch.ok) {
        throw new Error("Small inferred-owner fixture did not fit");
      }
      const expectedKeys = [closedloopKey(user.id)];
      expect(
        batch.value.results[0]?.collaborators.people.map(personKey)
      ).toEqual(expectedKeys);
      expect(batch.value.results[0]?.collaborators.sources).toMatchObject({
        [BranchCollaboratorSource.PullRequestAuthors]:
          BranchIdentityAvailability.Incomplete,
        [BranchCollaboratorSource.Pushes]:
          BranchIdentityAvailability.Incomplete,
      });
      // ISS-12463: the PR-creator rung seeds the branch assignee, which is the
      // Owner the detail read names.
      await withDb.tx((tx) => seedBranchOwners(tx, organizationId, [branchId]));
      const { assigneeId } = await withDb((db) =>
        db.artifact.findUniqueOrThrow({
          where: { id: branchId },
          select: { assigneeId: true },
        })
      );
      expect(assigneeId).toBe(user.id);
      const detail = await withDb((db) =>
        resolveBranchDetailIdentityData(db, organizationId, {
          id: branchId,
          assigneeId,
          branch: { firstPushedAt: null },
          pullRequestDetails: [{ authorLogin: "inferred-owner" }],
        })
      );
      const projection = detail.identityByBranch.get(branchId);
      expect(projection?.ownerIdentity.person?.userId).toBe(user.id);
      expect(projection?.ownerIdentity.availability).toBe(
        BranchIdentityAvailability.Complete
      );
      expect(projection?.collaborators.people.map(personKey)).toEqual(
        expectedKeys
      );
      expect(projection?.collaborators.sources).toMatchObject({
        [BranchCollaboratorSource.PullRequestAuthors]:
          BranchIdentityAvailability.Incomplete,
        [BranchCollaboratorSource.Pushes]:
          BranchIdentityAvailability.Incomplete,
      });
      expect(
        (await readSql(organizationId, branchId)).collaboratorKeys
      ).toEqual(expectedKeys);
    });

    it("keeps a reserved ghost PR author unresolved even when legacy numeric identity remains stored", async () => {
      const organizationId = await tracker.create();
      const branchId = await seedBranch(
        organizationId,
        "feature/ghost-author",
        { firstPushedAt: null }
      );
      await seedPullRequest(
        organizationId,
        branchId,
        1,
        "123",
        GitHubActorType.User
      );
      await withDb((db) =>
        db.pullRequestDetail.updateMany({
          where: { organizationId, branchArtifactId: branchId },
          data: { authorLogin: "ghost" },
        })
      );
      const result = await artifactCollaboratorsService.readBoundedBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: [branchId],
        }
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Small identity cohort did not fit");
      }
      const entry = result.value.results[0];
      if (entry?.artifactType !== CollaboratorArtifactType.Branch) {
        throw new Error("Expected a Branch result");
      }
      expect(entry.collaborators.people).toEqual([]);
      expect(
        entry.collaborators.sources[BranchCollaboratorSource.PullRequestAuthors]
      ).toBe(BranchIdentityAvailability.Incomplete);
      expect(
        (await readSql(organizationId, branchId)).collaboratorKeys
      ).toEqual([]);
    });

    it("admits null, wrote and reviewed Session links but excludes unsupported persisted participation", async () => {
      const organizationId = await tracker.create();
      const branchId = await seedBranch(organizationId, "feature/link-policy", {
        firstPushedAt: null,
      });
      const expectedKeys: string[] = [];
      let excludedUserId = "";
      for (const participation of [
        null,
        BranchParticipationKind.Wrote,
        BranchParticipationKind.Reviewed,
        "unsupported-history",
      ]) {
        const user = await createTestUser(organizationId);
        const sessionId = await linkValidSessionToBranch({
          organizationId,
          userId: user.id,
          branchArtifactId: branchId,
          label: `policy-${participation}`,
        });
        await withDb(async (db) => {
          await db.artifactLink.updateMany({
            where: { organizationId, sourceId: sessionId, targetId: branchId },
            data: { branchParticipation: participation },
          });
          const thread = await db.commentThread.create({
            data: {
              organizationId,
              artifactId: sessionId,
              source: ThreadSource.Native,
            },
          });
          await db.comment.create({
            data: {
              threadId: thread.id,
              authorId: user.id,
              body: {},
              bodyFormat: CommentBodyFormat.RichV1,
            },
            select: { id: true },
          });
        });
        if (participation === "unsupported-history") {
          excludedUserId = user.id;
        } else {
          expectedKeys.push(closedloopKey(user.id));
        }
      }
      expectedKeys.sort();
      const batch = await artifactCollaboratorsService.readBoundedBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: [branchId],
        }
      );
      expect(batch.ok).toBe(true);
      if (!batch.ok) {
        throw new Error("Small identity cohort did not fit");
      }
      const batchPeople = batch.value.results[0]?.collaborators.people ?? [];
      const detail = await withDb((db) =>
        resolveBranchDetailIdentityData(db, organizationId, {
          id: branchId,
          assigneeId: null,
          branch: { firstPushedAt: null },
          pullRequestDetails: [],
        })
      );
      expect(batchPeople.map(personKey)).toEqual(expectedKeys);
      expect(batchPeople.map((person) => person.userId)).not.toContain(
        excludedUserId
      );
      expect(
        detail.identityByBranch
          .get(branchId)
          ?.collaborators.people.map(personKey)
      ).toEqual(expectedKeys);
      expect(
        (await readSql(organizationId, branchId)).collaboratorKeys
      ).toEqual(expectedKeys);
    });

    it("reconciles a stored node-only commenter and numeric PR author through a later verified link", async () => {
      const organizationId = await tracker.create();
      const branchId = await seedBranch(organizationId, "feature/node-link", {
        firstPushedAt: null,
      });
      const shadow = await createTestUser(organizationId, {
        clerkId: githubShadowClerkId(organizationId, "node:node-123"),
      });
      const human = await createTestUser(organizationId);
      await seedPullRequest(
        organizationId,
        branchId,
        1,
        "123",
        GitHubActorType.User
      );
      await seedExternalAuthor(
        organizationId,
        shadow.id,
        "node:node-123",
        "historical-login"
      );
      await withDb(async (db) => {
        const pr = await db.pullRequestDetail.findFirstOrThrow({
          where: { organizationId, branchArtifactId: branchId },
        });
        const author = await db.externalCommentAuthor.findFirstOrThrow({
          where: { organizationId, providerUserId: "node:node-123" },
        });
        const thread = await db.commentThread.create({
          data: {
            organizationId,
            artifactId: branchId,
            source: ThreadSource.Github,
          },
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
            authorId: shadow.id,
            body: "stored comment",
            bodyFormat: CommentBodyFormat.Markdown,
          },
        });
        await db.gitHubCommentProjection.create({
          data: {
            commentId: comment.id,
            threadId: thread.id,
            externalAuthorId: author.id,
            githubCommentId: "node-comment-1",
          },
          select: { commentId: true },
        });
        await db.gitHubUserConnection.create({
          data: {
            organizationId,
            userId: human.id,
            githubUserId: "123",
            githubNodeId: "node-123",
            login: "current-login",
            normalizedLogin: "current-login",
          },
          select: { id: true },
        });
      });
      const response = await artifactCollaboratorsService.readBoundedBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: [branchId],
        }
      );
      expect(response.ok).toBe(true);
      if (!response.ok) {
        throw new Error("Small identity cohort did not fit");
      }
      const expected = [closedloopKey(human.id)];
      expect(
        response.value.results[0]?.collaborators.people.map(personKey)
      ).toEqual(expected);
      const detail = await withDb((db) =>
        resolveBranchDetailIdentityData(db, organizationId, {
          id: branchId,
          assigneeId: null,
          branch: { firstPushedAt: null },
          pullRequestDetails: [{ authorLogin: null }],
        })
      );
      expect(
        detail.identityByBranch
          .get(branchId)
          ?.collaborators.people.map(personKey)
      ).toEqual(expected);
      expect(
        (await readSql(organizationId, branchId)).collaboratorKeys
      ).toEqual(expected);
      const author = await withDb((db) =>
        db.externalCommentAuthor.findFirstOrThrow({
          where: { organizationId, providerUserId: "node:node-123" },
          select: { userId: true },
        })
      );
      expect(author.userId).toBe(shadow.id);
    });
  }
);
