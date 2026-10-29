import { randomUUID } from "node:crypto";
import {
  CollaboratorArtifactType,
  SessionCollaboratorSource,
} from "@repo/api/src/types/artifact-collaborators";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { ThreadSource } from "@repo/api/src/types/comment";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { artifactCollaboratorsService } from "./service";

const tracker = createCommittedTestOrganizationTracker();
const COVERAGE_STARTED_AT = new Date("2026-09-30T00:00:00.000Z");

describe.skipIf(!keys().DATABASE_URL)("Session comment windows", () => {
  afterEach(() => tracker.cleanup());

  it("keeps a saturated Session incomplete without spending another Session's evidence window", async () => {
    const organizationId = await tracker.create();
    const owner = await createTestUser(organizationId);
    const laterCommenter = await createTestUser(organizationId);
    const deletedCommenter = await createTestUser(organizationId);
    const ids: string[] = [];
    for (const label of ["saturated-session", "later-session"]) {
      ids.push(
        await createTestSessionDetail({
          organizationId,
          userId: owner.id,
          label,
          metadataActivityCoverageStartedAt: COVERAGE_STARTED_AT,
        })
      );
    }
    const users = Array.from({ length: 1001 }, (_, index) => ({
      id: randomUUID(),
      organizationId,
      clerkId: `comment-window-${randomUUID()}`,
      email: `comment-window-${index}@example.test`,
    }));
    await withDb(async (db) => {
      await db.user.createMany({ data: users });
      const saturated = await db.commentThread.create({
        data: {
          organizationId,
          artifactId: ids[0],
          source: ThreadSource.Native,
        },
      });
      await db.comment.createMany({
        data: users.map((user) => ({
          threadId: saturated.id,
          authorId: user.id,
          body: {},
          bodyFormat: CommentBodyFormat.RichV1,
        })),
      });
      const later = await db.commentThread.create({
        data: {
          organizationId,
          artifactId: ids[1],
          source: ThreadSource.Liveblocks,
        },
      });
      await db.comment.createMany({
        data: [
          {
            threadId: later.id,
            authorId: laterCommenter.id,
            body: {},
            bodyFormat: CommentBodyFormat.LiveblocksV1,
          },
          {
            threadId: later.id,
            authorId: deletedCommenter.id,
            body: {},
            bodyFormat: CommentBodyFormat.LiveblocksV1,
            deletedAt: COVERAGE_STARTED_AT,
          },
        ],
      });
    });
    const result = await artifactCollaboratorsService.readBatch(
      organizationId,
      { artifactType: CollaboratorArtifactType.Session, artifactIds: ids }
    );
    const saturated = result.results.find(
      (item) =>
        item.artifactId === ids[0] &&
        item.artifactType === CollaboratorArtifactType.Session
    );
    if (saturated?.artifactType !== CollaboratorArtifactType.Session) {
      throw new Error("expected Session");
    }
    expect(saturated?.collaborators.people).toHaveLength(1002);
    expect(
      saturated?.collaborators.sources[SessionCollaboratorSource.Comments]
    ).toBe(BranchIdentityAvailability.Incomplete);
    const later = result.results.find(
      (item) =>
        item.artifactId === ids[1] &&
        item.artifactType === CollaboratorArtifactType.Session
    );
    if (later?.artifactType !== CollaboratorArtifactType.Session) {
      throw new Error("expected Session");
    }
    expect(
      later?.collaborators.people.map((person) => person.userId).sort()
    ).toEqual([owner.id, laterCommenter.id].sort());
    expect(
      later?.collaborators.sources[SessionCollaboratorSource.Comments]
    ).toBe(BranchIdentityAvailability.Complete);
  }, 20_000);
});
