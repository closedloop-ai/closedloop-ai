import { randomUUID } from "node:crypto";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
} from "@repo/api/src/types/branch-identity";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import { ThreadSource } from "@repo/api/src/types/comment";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import {
  BRANCH_PUSH_METHOD_VALUES,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { GitHubCommentThreadKind, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  BEFORE_SHA,
  closedloopKey,
  FIRST_PUSHED_AT,
  personKey,
  REPOSITORY,
  readSql,
  seedBranch,
  seedExternalAuthor,
  seedPullRequest,
  seedPush,
} from "@/__tests__/support/branches/contributor-parity.test-fixtures";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { resolveBranchIdentities } from "@/app/branches/branch-read-service/identity-attribution";
import { COMMENT_EVIDENCE_LIMIT } from "@/app/branches/branch-read-service/page-comment-evidence";
import { githubShadowClerkId } from "@/app/comments/github-shadow-identity";

const tracker = createCommittedTestOrganizationTracker();
const BRANCH_NAME = "feature/shared";
const HISTORICAL_PUSH_AT = new Date("2026-01-01T00:00:00.000Z");

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-10992 Branch list author and pusher parity",
  () => {
    afterEach(() => tracker.cleanup());

    it("retains later PR commenters when another Branch saturates the GitHub comment page", async () => {
      const organizationId = await tracker.create();
      const hotAuthor = await createTestUser(organizationId);
      const laterAuthor = await createTestUser(organizationId);
      const hotBranchId = await seedBranch(
        organizationId,
        "feature/hot-pr-comments",
        { firstPushedAt: null }
      );
      const laterBranchId = await seedBranch(
        organizationId,
        "feature/later-pr-comments",
        { firstPushedAt: null }
      );
      await seedExternalAuthor(
        organizationId,
        hotAuthor.id,
        "123",
        "hot-commenter"
      );
      await seedExternalAuthor(
        organizationId,
        laterAuthor.id,
        "456",
        "later-commenter"
      );
      for (const [branchId, authorId, providerUserId, count, offset] of [
        [hotBranchId, hotAuthor.id, "123", COMMENT_EVIDENCE_LIMIT * 2 + 1, 0],
        [laterBranchId, laterAuthor.id, "456", 1, COMMENT_EVIDENCE_LIMIT * 3],
      ] as const) {
        await withDb(async (db) => {
          const pr = await db.pullRequestDetail.create({
            data: {
              organizationId,
              branchArtifactId: branchId,
              repositoryFullName: REPOSITORY,
              number: offset + 1,
            },
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
          const author = await db.externalCommentAuthor.findFirstOrThrow({
            where: { organizationId, providerUserId },
            select: { id: true },
          });
          const commentIds = Array.from({ length: count }, () => randomUUID());
          await db.comment.createMany({
            data: commentIds.map((id, index) => ({
              id,
              threadId: thread.id,
              authorId,
              body: "GitHub comment",
              bodyFormat: CommentBodyFormat.Markdown,
              createdAt: new Date(FIRST_PUSHED_AT.getTime() + offset + index),
            })),
          });
          await db.gitHubCommentProjection.createMany({
            data: commentIds.map((commentId) => ({
              commentId,
              threadId: thread.id,
              externalAuthorId: author.id,
              githubCommentId: commentId,
            })),
          });
        });
      }
      const js = await withDb((db) =>
        resolveBranchIdentities(
          db,
          organizationId,
          [hotBranchId, laterBranchId].map((branchId) => ({
            branchId,
            assigneeId: null,
            firstPushedAt: null,
            associatedPullRequestCount: 1,
          })),
          []
        )
      );
      expect(
        js.get(laterBranchId)?.collaborators.people.map(personKey)
      ).toEqual([closedloopKey(laterAuthor.id)]);
      const sql = await readSql(organizationId, laterBranchId);
      expect(sql.collaboratorKeys).toEqual(
        js.get(laterBranchId)?.collaborators.people.map(personKey)
      );
      expect(sql.collaboratorAvailability).toBe(
        js.get(laterBranchId)?.collaborators.availability
      );
    });

    it.each([
      BranchCollaboratorSource.BranchComments,
      BranchCollaboratorSource.SessionComments,
    ])(
      "retains each Branch's %s population when an earlier Branch saturates the batch cap",
      async (commentSource) => {
        const organizationId = await tracker.create();
        const hotAuthor = await createTestUser(organizationId);
        const laterAuthor = await createTestUser(organizationId);
        const hotBranchId = await seedBranch(
          organizationId,
          "feature/hot-comments",
          {
            firstPushedAt: null,
            pushCoverageAvailability: BranchIdentityAvailability.Complete,
          }
        );
        const laterBranchId = await seedBranch(
          organizationId,
          "feature/later-comments",
          {
            firstPushedAt: null,
            pushCoverageAvailability: BranchIdentityAvailability.Complete,
          }
        );
        let hotArtifactId = hotBranchId;
        let laterArtifactId = laterBranchId;
        if (commentSource === BranchCollaboratorSource.SessionComments) {
          hotArtifactId = await linkValidSessionToBranch({
            organizationId,
            userId: hotAuthor.id,
            branchArtifactId: hotBranchId,
            label: "hot-comments",
            linkKind: SessionArtifactLinkKind.SessionBranch,
          });
          laterArtifactId = await linkValidSessionToBranch({
            organizationId,
            userId: laterAuthor.id,
            branchArtifactId: laterBranchId,
            label: "later-comments",
            linkKind: SessionArtifactLinkKind.SessionBranch,
          });
        }
        await withDb(async (db) => {
          const hotThread = await db.commentThread.create({
            data: {
              organizationId,
              artifactId: hotArtifactId,
              source: ThreadSource.Native,
            },
            select: { id: true },
          });
          await db.comment.createMany({
            data: Array.from(
              { length: COMMENT_EVIDENCE_LIMIT * 2 + 1 },
              (_, index) => ({
                threadId: hotThread.id,
                authorId: hotAuthor.id,
                body: {},
                bodyFormat: CommentBodyFormat.RichV1,
                createdAt: new Date(FIRST_PUSHED_AT.getTime() + index),
              })
            ),
          });
          await db.commentThread.create({
            data: {
              organizationId,
              artifactId: laterArtifactId,
              source: ThreadSource.Liveblocks,
              comments: {
                create: {
                  authorId: laterAuthor.id,
                  body: {},
                  bodyFormat: CommentBodyFormat.RichV1,
                  createdAt: new Date(
                    FIRST_PUSHED_AT.getTime() + COMMENT_EVIDENCE_LIMIT * 3
                  ),
                },
              },
            },
            select: { id: true },
          });
        });
        const links = await withDb((db) =>
          db.artifactLink.findMany({
            where: {
              organizationId,
              targetId: { in: [hotBranchId, laterBranchId] },
            },
            select: {
              sourceId: true,
              targetId: true,
              branchParticipationMethod: true,
              branchParticipationObservedAt: true,
            },
          })
        );
        const js = await withDb((db) =>
          resolveBranchIdentities(
            db,
            organizationId,
            [hotBranchId, laterBranchId].map((branchId) => ({
              branchId,
              assigneeId: null,
              firstPushedAt: null,
              associatedPullRequestCount: 0,
            })),
            links.map((link) => ({
              sourceId: link.sourceId,
              targetId: link.targetId,
              branchParticipationMethod: link.branchParticipationMethod,
              branchParticipationObservedAt: link.branchParticipationObservedAt,
            }))
          )
        );
        expect(
          js.get(laterBranchId)?.collaborators.people.map(personKey)
        ).toEqual([closedloopKey(laterAuthor.id)]);
        expect(
          js.get(laterBranchId)?.collaborators.sources[commentSource]
        ).toBe(BranchIdentityAvailability.Complete);
        const sql = await readSql(organizationId, laterBranchId);
        expect(sql.collaboratorKeys).toEqual(
          js.get(laterBranchId)?.collaborators.people.map(personKey)
        );
        expect(sql.collaboratorAvailability).toBe(
          js.get(laterBranchId)?.collaborators.availability
        );
        expect(js.get(hotBranchId)?.collaborators.sources[commentSource]).toBe(
          BranchIdentityAvailability.Incomplete
        );
      }
    );

    it("reconciles a later verified account link without rewriting historical author receipts", async () => {
      const organizationId = await tracker.create();
      const linkedUser = await createTestUser(organizationId);
      const shadow = await createTestUser(organizationId, {
        clerkId: githubShadowClerkId(organizationId, "123"),
        active: false,
      });
      const branchId = await seedBranch(organizationId, "feature/later-link", {
        firstPushedAt: null,
      });
      await seedExternalAuthor(
        organizationId,
        shadow.id,
        "123",
        "github-person"
      );
      await seedPullRequest(
        organizationId,
        branchId,
        1,
        "123",
        GitHubActorType.User
      );
      await seedPush(
        organizationId,
        branchId,
        "feature/later-link",
        "123",
        "push-later-link"
      );
      await withDb(async (db) => {
        await db.commentThread.create({
          data: {
            organizationId,
            artifactId: branchId,
            source: ThreadSource.Native,
            comments: {
              create: {
                authorId: linkedUser.id,
                body: {},
                bodyFormat: CommentBodyFormat.RichV1,
              },
            },
          },
          select: { id: true },
        });
        await db.gitHubUserConnection.create({
          data: {
            organizationId,
            userId: linkedUser.id,
            githubUserId: "123",
            login: "github-person",
            normalizedLogin: "github-person",
          },
          select: { id: true },
        });
      });
      const js = await withDb((db) =>
        resolveBranchIdentities(
          db,
          organizationId,
          [
            {
              branchId,
              assigneeId: null,
              firstPushedAt: null,
              associatedPullRequestCount: 1,
            },
          ],
          []
        )
      );
      expect(js.get(branchId)?.collaborators.people.map(personKey)).toEqual([
        closedloopKey(linkedUser.id),
      ]);
      const sql = await readSql(organizationId, branchId);
      expect(sql.collaboratorKeys).toEqual([closedloopKey(linkedUser.id)]);
      const persisted = await withDb((db) =>
        db.externalCommentAuthor.findFirstOrThrow({
          where: { organizationId, providerUserId: "123" },
          select: { userId: true },
        })
      );
      expect(persisted.userId).toBe(shadow.id);
      for (const state of ["revoked", "inactive"] as const) {
        await withDb(async (db) => {
          await db.gitHubUserConnection.updateMany({
            where: { organizationId, userId: linkedUser.id },
            data: {
              revokedAt:
                state === "revoked"
                  ? new Date("2026-09-30T00:00:00.000Z")
                  : null,
            },
          });
          await db.user.updateMany({
            where: { organizationId, id: linkedUser.id },
            data: { active: state !== "inactive" },
          });
        });
        const read = await withDb((db) =>
          resolveBranchIdentities(
            db,
            organizationId,
            [
              {
                branchId,
                assigneeId: null,
                firstPushedAt: null,
                associatedPullRequestCount: 1,
              },
            ],
            []
          )
        );
        const expected = [
          closedloopKey(linkedUser.id),
          closedloopKey(shadow.id),
        ].sort();
        expect(read.get(branchId)?.collaborators.people.map(personKey)).toEqual(
          expected
        );
        expect(
          (await readSql(organizationId, branchId)).collaboratorKeys
        ).toEqual(expected);
      }
    });

    it("matches detail across PR authors, historical and force-push actors, Owner, bot, another Branch, and another org", async () => {
      const organizationId = await tracker.create();
      const foreignOrganizationId = await tracker.create();
      const owner = await createTestUser(organizationId);
      const bob = await createTestUser(organizationId);
      const alice = await createTestUser(organizationId);
      const carol = await createTestUser(organizationId);
      const dave = await createTestUser(organizationId);
      const foreign = await createTestUser(foreignOrganizationId);
      const branchId = await seedBranch(organizationId, BRANCH_NAME);
      const otherBranchId = await seedBranch(
        organizationId,
        "feature/unrelated"
      );
      const foreignBranchId = await seedBranch(
        foreignOrganizationId,
        BRANCH_NAME
      );
      const sessionId = await linkValidSessionToBranch({
        organizationId,
        userId: owner.id,
        branchArtifactId: branchId,
        label: "owner-session",
        linkKind: SessionArtifactLinkKind.SessionBranch,
      });
      await withDb((db) =>
        db.artifactLink.updateMany({
          where: { organizationId, sourceId: sessionId, targetId: branchId },
          data: {
            branchParticipationMethod: BRANCH_PUSH_METHOD_VALUES[0],
            branchParticipationObservedAt: FIRST_PUSHED_AT,
          },
        })
      );

      await seedExternalAuthor(organizationId, bob.id, "123", "bob");
      await seedExternalAuthor(organizationId, alice.id, "456", "alice");
      await seedExternalAuthor(organizationId, carol.id, "789", "carol");
      await seedExternalAuthor(organizationId, dave.id, "555", "dave");
      await seedExternalAuthor(
        foreignOrganizationId,
        foreign.id,
        "999",
        "foreign"
      );
      await seedPullRequest(
        organizationId,
        branchId,
        1,
        "123",
        GitHubActorType.User
      );
      await seedPullRequest(
        organizationId,
        branchId,
        2,
        "456",
        GitHubActorType.User
      );
      await seedPullRequest(
        organizationId,
        branchId,
        3,
        "888",
        GitHubActorType.Bot
      );
      await seedPullRequest(
        foreignOrganizationId,
        foreignBranchId,
        1,
        "999",
        GitHubActorType.User
      );
      await seedPush(
        organizationId,
        branchId,
        BRANCH_NAME,
        "456",
        "push-alice"
      );
      await seedPush(
        organizationId,
        branchId,
        BRANCH_NAME,
        "789",
        "push-carol",
        { observedAt: HISTORICAL_PUSH_AT }
      );
      await seedPush(
        organizationId,
        branchId,
        BRANCH_NAME,
        "555",
        "force-dave",
        {
          source: BranchPushContributionSource.HeadRefForcePushed,
          observedAt: HISTORICAL_PUSH_AT,
        }
      );
      await seedPush(
        organizationId,
        branchId,
        BRANCH_NAME,
        "666",
        "no-new-commits",
        { afterSha: BEFORE_SHA }
      );
      await seedPush(organizationId, branchId, BRANCH_NAME, "888", "bot-push", {
        actorType: GitHubActorType.Bot,
      });
      await seedPush(
        organizationId,
        otherBranchId,
        "feature/unrelated",
        "777",
        "push-other"
      );
      await seedPush(
        foreignOrganizationId,
        foreignBranchId,
        BRANCH_NAME,
        "999",
        "push-foreign"
      );

      const sql = await readSql(organizationId, branchId);
      const js = await withDb((db) =>
        resolveBranchIdentities(
          db,
          organizationId,
          [
            {
              branchId,
              assigneeId: null,
              firstPushedAt: FIRST_PUSHED_AT,
              associatedPullRequestCount: 3,
            },
          ],
          [
            {
              sourceId: sessionId,
              targetId: branchId,
              branchParticipationMethod: BRANCH_PUSH_METHOD_VALUES[0],
              branchParticipationObservedAt: FIRST_PUSHED_AT,
            },
          ]
        )
      );
      const people = js.get(branchId)?.collaborators.people ?? [];
      const expectedKeys = people.map(personKey);
      expect(sql.collaboratorKeys).toEqual(expectedKeys);
      expect(sql.collaboratorLabels).toEqual(
        people.map((person) => person.displayName ?? person.login ?? "")
      );
      expect(sql.collaboratorAvailability).toBe(
        BranchIdentityAvailability.Incomplete
      );
      expect(new Set(expectedKeys)).toEqual(
        new Set([
          closedloopKey(owner.id),
          closedloopKey(bob.id),
          closedloopKey(alice.id),
          closedloopKey(carol.id),
          closedloopKey(dave.id),
        ])
      );
    });

    it("keeps a known historical pusher visible when source coverage is unavailable", async () => {
      const organizationId = await tracker.create();
      const pusher = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "feature/partial", {
        firstPushedAt: null,
        pushCoverageAvailability: BranchIdentityAvailability.Unavailable,
      });
      await seedExternalAuthor(organizationId, pusher.id, "321", "pusher");
      await seedPush(
        organizationId,
        branchId,
        "feature/partial",
        "321",
        "historical-check-suite",
        { observedAt: HISTORICAL_PUSH_AT }
      );

      const sql = await readSql(organizationId, branchId);
      const js = await withDb((db) =>
        resolveBranchIdentities(
          db,
          organizationId,
          [
            {
              branchId,
              assigneeId: null,
              firstPushedAt: null,
              associatedPullRequestCount: 0,
            },
          ],
          []
        )
      );

      expect(sql.collaboratorKeys).toEqual([closedloopKey(pusher.id)]);
      expect(sql.collaboratorKeys).toEqual(
        js.get(branchId)?.collaborators.people.map(personKey)
      );
      expect(sql.collaboratorAvailability).toBe(
        BranchIdentityAvailability.Incomplete
      );
      expect(
        js.get(branchId)?.collaborators.sources[BranchCollaboratorSource.Pushes]
      ).toBe(BranchIdentityAvailability.Unavailable);
    });

    it("keeps an unlinked PR author separate from a same-named Liveblocks commenter", async () => {
      const organizationId = await tracker.create();
      const commenter = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "feature/same-name", {
        firstPushedAt: null,
        pushCoverageAvailability: BranchIdentityAvailability.Complete,
      });
      await withDb(async (db) => {
        await db.user.update({
          where: { id: commenter.id },
          data: { firstName: "sameperson", lastName: null },
          select: { id: true },
        });
        const thread = await db.commentThread.create({
          data: {
            organizationId,
            artifactId: branchId,
            source: ThreadSource.Liveblocks,
          },
          select: { id: true },
        });
        await db.comment.create({
          data: {
            threadId: thread.id,
            authorId: commenter.id,
            body: {},
            bodyFormat: CommentBodyFormat.LiveblocksV1,
          },
          select: { id: true },
        });
      });
      await seedPullRequest(
        organizationId,
        branchId,
        1,
        "424242",
        GitHubActorType.User
      );
      await withDb((db) =>
        db.pullRequestDetail.updateMany({
          where: { organizationId, branchArtifactId: branchId, number: 1 },
          data: { authorLogin: "sameperson" },
        })
      );

      const sql = await readSql(organizationId, branchId);
      const detail = await withDb((db) =>
        resolveBranchIdentities(
          db,
          organizationId,
          [
            {
              branchId,
              assigneeId: null,
              firstPushedAt: null,
              associatedPullRequestCount: 1,
            },
          ],
          []
        )
      );
      const people = detail.get(branchId)?.collaborators.people ?? [];
      expect(people.map(personKey)).toEqual(
        [closedloopKey(commenter.id), "github:424242"].sort()
      );
      expect(
        people.map((person) => person.displayName ?? person.login)
      ).toEqual(["sameperson", "sameperson"]);
      expect(sql.collaboratorKeys).toEqual(people.map(personKey));
      expect(sql.collaboratorLabels).toEqual(["sameperson", "sameperson"]);
    });

    it("keeps an old Branch with no pusher observations incomplete", async () => {
      const organizationId = await tracker.create();
      const branchId = await seedBranch(organizationId, "feature/no-history", {
        pushCoverageAvailability: null,
      });

      const sql = await readSql(organizationId, branchId);
      const js = await withDb((db) =>
        resolveBranchIdentities(
          db,
          organizationId,
          [
            {
              branchId,
              assigneeId: null,
              firstPushedAt: FIRST_PUSHED_AT,
              associatedPullRequestCount: 0,
            },
          ],
          []
        )
      );

      expect(sql.collaboratorKeys).toEqual([]);
      expect(sql.collaboratorAvailability).toBe(
        BranchIdentityAvailability.Incomplete
      );
      expect(sql.collaboratorAvailability).toBe(
        js.get(branchId)?.collaborators.availability
      );
      expect(
        js.get(branchId)?.collaborators.sources[BranchCollaboratorSource.Pushes]
      ).toBe(BranchIdentityAvailability.Incomplete);
    });

    it("does not treat an unobserved Branch with no first push as complete-empty", async () => {
      const organizationId = await tracker.create();
      const branchId = await seedBranch(
        organizationId,
        "feature/no-push-proof",
        {
          firstPushedAt: null,
          pushCoverageAvailability: null,
        }
      );

      const sql = await readSql(organizationId, branchId);
      const js = await withDb((db) =>
        resolveBranchIdentities(
          db,
          organizationId,
          [
            {
              branchId,
              assigneeId: null,
              firstPushedAt: null,
              associatedPullRequestCount: 0,
            },
          ],
          []
        )
      );

      expect(sql.collaboratorKeys).toEqual([]);
      expect(sql.collaboratorAvailability).toBe(
        BranchIdentityAvailability.Incomplete
      );
      expect(sql.collaboratorAvailability).toBe(
        js.get(branchId)?.collaborators.availability
      );
      expect(
        js.get(branchId)?.collaborators.sources[BranchCollaboratorSource.Pushes]
      ).toBe(BranchIdentityAvailability.Incomplete);
    });
  }
);
