import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  SessionMetadataActivityField,
} from "@repo/api/src/types/artifact-activity";
import {
  CollaboratorArtifactType,
  DirectCollaboratorSource,
  SessionCollaboratorSource,
} from "@repo/api/src/types/artifact-collaborators";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import { ThreadSource } from "@repo/api/src/types/comment";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { Priority } from "@repo/api/src/types/common";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { ExternalCommentProvider, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { artifactCollaboratorsService } from "./service";

const tracker = createCommittedTestOrganizationTracker();
const REPOSITORY = "acme/app";
const BRANCH_NAME = "feature/collaborators";
const BEFORE_SHA = "a".repeat(40);
const AFTER_SHA = "b".repeat(40);

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-10992 collaborator batch service",
  () => {
    afterEach(() => tracker.cleanup());

    it("counts native and Liveblocks commenters and account-resolved API edits", async () => {
      const organizationId = await tracker.create();
      const foreignOrganizationId = await tracker.create();
      const owner = await createTestUser(organizationId);
      const editor = await createTestUser(organizationId);
      const apiEditor = await createTestUser(organizationId);
      const commenter = await createTestUser(organizationId);
      const liveblocksCommenter = await createTestUser(organizationId);
      const foreignOwner = await createTestUser(foreignOrganizationId);
      const sessionId = await createTestSessionDetail({
        organizationId,
        userId: owner.id,
        label: "collaborators-session",
        metadataActivityCoverageStartedAt: new Date(),
      });
      const foreignSessionId = await createTestSessionDetail({
        organizationId: foreignOrganizationId,
        userId: foreignOwner.id,
        label: "foreign-collaborators-session",
      });
      await withDb((db) =>
        db.artifactActivityEvent.createMany({
          data: [
            {
              organizationId,
              artifactId: sessionId,
              actorType: ArtifactActivityActorType.User,
              actorId: editor.id,
              action: ArtifactActivityAction.FieldChange,
              after: {
                field: SessionMetadataActivityField.Name,
                value: "renamed",
              },
            },
            {
              organizationId,
              artifactId: sessionId,
              actorType: ArtifactActivityActorType.Agent,
              actorId: apiEditor.id,
              action: ArtifactActivityAction.FieldChange,
              after: {
                field: SessionMetadataActivityField.Priority,
                value: Priority.High,
              },
            },
          ],
        })
      );
      await withDb(async (db) => {
        const thread = await db.commentThread.create({
          data: {
            organizationId,
            artifactId: sessionId,
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
        const liveblocksThread = await db.commentThread.create({
          data: {
            organizationId,
            artifactId: sessionId,
            source: ThreadSource.Liveblocks,
          },
          select: { id: true },
        });
        await db.comment.create({
          data: {
            threadId: liveblocksThread.id,
            authorId: liveblocksCommenter.id,
            body: {},
            bodyFormat: CommentBodyFormat.LiveblocksV1,
          },
          select: { id: true },
        });
      });

      const result = await artifactCollaboratorsService.readBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Session,
          artifactIds: [sessionId, foreignSessionId],
        }
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        artifactId: sessionId,
        artifactType: ArtifactType.Session,
        collaborators: {
          availability: BranchIdentityAvailability.Complete,
          sources: {
            [SessionCollaboratorSource.Owner]:
              BranchIdentityAvailability.Complete,
            [SessionCollaboratorSource.MetadataEdits]:
              BranchIdentityAvailability.Complete,
            [SessionCollaboratorSource.Comments]:
              BranchIdentityAvailability.Complete,
          },
        },
      });
      expect(
        result.results[0]?.collaborators.people
          .map((person) => person.userId)
          .sort()
      ).toEqual(
        [
          owner.id,
          editor.id,
          apiEditor.id,
          commenter.id,
          liveblocksCommenter.id,
        ].sort()
      );
    });

    it("returns confirmed-empty Session evidence separately from a missing foreign ID", async () => {
      const organizationId = await tracker.create();
      const foreignOrganizationId = await tracker.create();
      const owner = await createTestUser(organizationId);
      const foreignOwner = await createTestUser(foreignOrganizationId);
      const sessionId = await createTestSessionDetail({
        organizationId,
        userId: owner.id,
        label: "empty-collaborators-session",
        metadataActivityCoverageStartedAt: new Date(),
      });
      const foreignSessionId = await createTestSessionDetail({
        organizationId: foreignOrganizationId,
        userId: foreignOwner.id,
        label: "empty-foreign-session",
      });
      await withDb(async (db) => {
        // ISS-12251: the fixture stamps Created by and Owner like ingest does;
        // a session with no person evidence has neither.
        await db.artifact.update({
          where: { id: sessionId },
          data: { createdById: null, assigneeId: null },
          select: { id: true },
        });
      });

      const result = await artifactCollaboratorsService.readBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Session,
          artifactIds: [sessionId, foreignSessionId],
        }
      );

      expect(result.results).toEqual([
        {
          artifactId: sessionId,
          artifactType: ArtifactType.Session,
          commentCount: 0,
          collaborators: {
            availability: BranchIdentityAvailability.Complete,
            people: [],
            sources: {
              [DirectCollaboratorSource.Creator]:
                BranchIdentityAvailability.Complete,
              [DirectCollaboratorSource.Interactions]:
                BranchIdentityAvailability.Complete,
              [DirectCollaboratorSource.Comments]:
                BranchIdentityAvailability.Complete,
              [SessionCollaboratorSource.Owner]:
                BranchIdentityAvailability.Complete,
              [SessionCollaboratorSource.MetadataEdits]:
                BranchIdentityAvailability.Complete,
              [SessionCollaboratorSource.Comments]:
                BranchIdentityAvailability.Complete,
            },
          },
        },
      ]);
    });

    it("keeps a legacy Session's known editor visible without claiming complete history", async () => {
      const organizationId = await tracker.create();
      const owner = await createTestUser(organizationId);
      const editor = await createTestUser(organizationId);
      const sessionId = await createTestSessionDetail({
        organizationId,
        userId: owner.id,
        label: "legacy-editor-batch",
      });
      await withDb((db) =>
        db.artifactActivityEvent.create({
          data: {
            organizationId,
            artifactId: sessionId,
            actorType: ArtifactActivityActorType.User,
            actorId: editor.id,
            action: ArtifactActivityAction.FieldChange,
            after: {
              field: SessionMetadataActivityField.Name,
              value: "renamed",
            },
          },
          select: { id: true },
        })
      );

      const result = await artifactCollaboratorsService.readBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Session,
          artifactIds: [sessionId],
        }
      );

      expect(
        result.results[0]?.collaborators.people
          .map((person) => person.userId)
          .sort()
      ).toEqual([owner.id, editor.id].sort());
      expect(result.results[0]?.collaborators.sources).toMatchObject({
        [SessionCollaboratorSource.Owner]: BranchIdentityAvailability.Complete,
        [SessionCollaboratorSource.MetadataEdits]:
          BranchIdentityAvailability.Incomplete,
        [SessionCollaboratorSource.Comments]:
          BranchIdentityAvailability.Complete,
      });
      expect(result.results[0]?.collaborators.availability).toBe(
        BranchIdentityAvailability.Incomplete
      );
    });

    it("returns Branch authors and pushers once without another organization's same-ref evidence", async () => {
      const organizationId = await tracker.create();
      const foreignOrganizationId = await tracker.create();
      const author = await createTestUser(organizationId);
      const pusher = await createTestUser(organizationId);
      const loginOnlyAuthor = await createTestUser(organizationId);
      const foreign = await createTestUser(foreignOrganizationId);
      const branchId = await seedBranch(organizationId);
      const loginOnlyBranchId = await seedBranch(
        organizationId,
        "feature/login-only"
      );
      const foreignBranchId = await seedBranch(foreignOrganizationId);
      await seedExternalAuthor(organizationId, author.id, "123", "author");
      await seedExternalAuthor(organizationId, pusher.id, "456", "pusher");
      await seedGitHubConnection(
        organizationId,
        loginOnlyAuthor.id,
        "login-owner",
        "gh-login-owner"
      );
      await seedExternalAuthor(
        foreignOrganizationId,
        foreign.id,
        "999",
        "foreign"
      );
      await seedPullRequest(organizationId, branchId, "123");
      await seedPullRequestLoginOnly(
        organizationId,
        loginOnlyBranchId,
        "login-owner"
      );
      await seedPullRequest(foreignOrganizationId, foreignBranchId, "999");
      await seedPush(organizationId, branchId, "456", "push-a");
      await seedPush(foreignOrganizationId, foreignBranchId, "999", "push-b");

      const result = await artifactCollaboratorsService.readBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: [branchId, loginOnlyBranchId, foreignBranchId],
        }
      );

      expect(result.results).toHaveLength(2);
      const branchResult = result.results.find(
        (entry) => entry.artifactId === branchId
      );
      expect(
        branchResult?.collaborators.people.map((person) => [
          person.provider,
          person.id,
        ])
      ).toEqual([
        [BranchPersonProvider.GitHub, "123"],
        [BranchPersonProvider.GitHub, "456"],
      ]);
      expect(branchResult?.collaborators.availability).toBe(
        BranchIdentityAvailability.Incomplete
      );
      const loginOnlyResult = result.results.find(
        (entry) => entry.artifactId === loginOnlyBranchId
      );
      expect(
        loginOnlyResult?.collaborators.people.map((person) => [
          person.provider,
          person.id,
          person.userId,
        ])
      ).toEqual([
        [BranchPersonProvider.GitHub, "gh-login-owner", loginOnlyAuthor.id],
      ]);
      expect(loginOnlyResult?.collaborators.availability).toBe(
        BranchIdentityAvailability.Incomplete
      );
    });
  }
);

async function seedBranch(
  organizationId: string,
  branchName = BRANCH_NAME
): Promise<string> {
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
            pushCoverageAvailability: BranchIdentityAvailability.Incomplete,
          },
        },
      },
      select: { id: true },
    })
  );
  return artifact.id;
}

async function seedExternalAuthor(
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
        userId,
      },
    })
  );
}

async function seedGitHubConnection(
  organizationId: string,
  userId: string,
  login: string,
  githubUserId: string
): Promise<void> {
  await withDb((db) =>
    db.gitHubUserConnection.create({
      data: {
        organizationId,
        userId,
        githubUserId,
        login,
        normalizedLogin: login,
      },
      select: { id: true },
    })
  );
}

async function seedPullRequest(
  organizationId: string,
  branchArtifactId: string,
  authorProviderUserId: string
): Promise<void> {
  await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId,
        repositoryFullName: REPOSITORY,
        number: 1,
        authorProviderUserId,
        authorActorType: GitHubActorType.User,
        authorLogin: authorProviderUserId,
      },
    })
  );
}

async function seedPullRequestLoginOnly(
  organizationId: string,
  branchArtifactId: string,
  authorLogin: string
): Promise<void> {
  await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId,
        repositoryFullName: REPOSITORY,
        number: 2,
        authorLogin,
      },
    })
  );
}

async function seedPush(
  organizationId: string,
  branchArtifactId: string,
  providerUserId: string,
  sourceEventId: string
): Promise<void> {
  await withDb((db) =>
    db.branchPushContribution.create({
      data: {
        organizationId,
        branchArtifactId,
        repositoryFullName: REPOSITORY,
        refName: BRANCH_NAME,
        beforeSha: BEFORE_SHA,
        afterSha: AFTER_SHA,
        source: BranchPushContributionSource.GraphqlPush,
        sourceEventId,
        providerUserId,
        actorType: GitHubActorType.User,
      },
    })
  );
}
