/**
 * ISS-11190: a trace comment's target id is NOT always a UUID. The desktop
 * sends OpenCode/Copilot sessions under their external id (`opencode-…`) and
 * every Branch under its `encodeBranchId` id (`repo::branch`). Both resolvers
 * used to probe a `@db.Uuid` artifact-id column with that raw value first, and
 * Postgres raises on a non-UUID there, so the fallback built for these ids
 * never ran and the route answered 500. Run against a real database because the
 * failure was the driver raising, which a mocked client cannot reproduce.
 */
import { randomUUID } from "node:crypto";
import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus, encodeBranchId } from "@repo/api/src/types/branch";
import { CommentTargetType } from "@repo/api/src/types/comment";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";

import {
  buildSessionChunk,
  createComputeTarget,
  ingestChunk,
} from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createTestOrganization,
  createTestUser,
  joinAmbientTransactionForSessionSyncWrites,
} from "@/__tests__/utils/db-helpers";
import { resolveProductBranchArtifactId } from "./trace-comment-product-read";
import { resolveSessionTraceCommentTarget } from "./trace-comment-target-lookup";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const OPENCODE_SESSION_ID = "opencode-ses_1";
const REPOSITORY_FULL_NAME = "acme/trace-comments";
const BRANCH_NAME = "feat/iss-11190";
const PUSHED_AT = new Date("2026-07-01T00:00:00.000Z");

type SessionFixture = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
  artifactId: string;
};

/** Import one session the way the desktop does, and resolve its cloud ids. */
async function importSession(
  externalSessionId: string
): Promise<SessionFixture> {
  const organizationId = await createTestOrganization();
  const owner = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    owner.id,
    "lane-11190"
  );
  await ingestChunk(
    { organizationId, userId: owner.id, computeTargetId },
    randomUUID(),
    buildSessionChunk({
      externalSessionId,
      name: "trace comment target",
      eventIds: ["evt-0"],
    })
  );
  const detail = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: { artifactId: true },
    })
  );
  return {
    organizationId,
    userId: owner.id,
    computeTargetId,
    artifactId: detail.artifactId,
  };
}

/** Seed one GitHub-backed Branch the `decodeBranchId` fallback can find. */
async function seedBranch(organizationId: string): Promise<string> {
  return await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: BRANCH_NAME,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    const installation = await db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `installation-${artifact.id}`,
        accountId: `account-${artifact.id}`,
        accountLogin: "acme",
        accountType: "Organization",
        senderLogin: "fixture-user",
        senderId: `sender-${artifact.id}`,
      },
      select: { id: true },
    });
    const repository = await db.gitHubInstallationRepository.create({
      data: {
        installationId: installation.id,
        githubRepoId: `repo-${artifact.id}`,
        fullName: REPOSITORY_FULL_NAME,
        name: "trace-comments",
        owner: "acme",
        private: false,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryId: repository.id,
        repositoryFullName: REPOSITORY_FULL_NAME,
        branchName: BRANCH_NAME,
        firstPushedAt: PUSHED_AT,
        pushSource: BranchPushSource.Session,
        lastActivityAt: PUSHED_AT,
      },
      select: { artifactId: true },
    });
    return artifact.id;
  });
}

describeIfDb("trace comment target resolution (real database)", () => {
  it("resolves a non-UUID session id through the compute-target fallback", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession(OPENCODE_SESSION_ID);

      const resolved = await resolveSessionTraceCommentTarget({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        target: {
          type: CommentTargetType.Session,
          id: OPENCODE_SESSION_ID,
        },
        computeTargetId: fixture.computeTargetId,
      });

      expect(resolved?.artifactId).toBe(fixture.artifactId);
    });
  });

  it("resolves a non-UUID session id through the user-scoped fallback", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession(OPENCODE_SESSION_ID);

      const resolved = await resolveSessionTraceCommentTarget({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        target: {
          type: CommentTargetType.Session,
          id: OPENCODE_SESSION_ID,
        },
      });

      expect(resolved?.artifactId).toBe(fixture.artifactId);
    });
  });

  // ISS-12251 (PLN-2176 D-4): the user-scoped fallback is whose session it is,
  // Created by, not the uploading user.
  it("scopes the user fallback to Created by, not the uploading user", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession(OPENCODE_SESSION_ID);
      const creator = await createTestUser(fixture.organizationId);
      await withDb((db) =>
        db.artifact.update({
          where: { id: fixture.artifactId },
          data: { createdById: creator.id },
          select: { id: true },
        })
      );
      const target = {
        type: CommentTargetType.Session,
        id: OPENCODE_SESSION_ID,
      };

      const asCreator = await resolveSessionTraceCommentTarget({
        organizationId: fixture.organizationId,
        userId: creator.id,
        target,
      });
      const asUploader = await resolveSessionTraceCommentTarget({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        target,
      });

      expect(asCreator?.artifactId).toBe(fixture.artifactId);
      expect(asUploader).toBeNull();
    });
  });

  it("still resolves a session by its artifact id", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession(OPENCODE_SESSION_ID);

      const resolved = await resolveSessionTraceCommentTarget({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        target: {
          type: CommentTargetType.Session,
          id: fixture.artifactId,
        },
      });

      expect(resolved?.artifactId).toBe(fixture.artifactId);
    });
  });

  // A UUID-shaped external id (Claude's) still probes the artifact id first,
  // misses, and must keep reaching the fallback.
  it.each([
    ["with", true],
    ["without", false],
  ])(
    "resolves a UUID-shaped external session id %s a compute target",
    async (_label, withComputeTarget) => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const externalSessionId = randomUUID();
        const fixture = await importSession(externalSessionId);

        const resolved = await resolveSessionTraceCommentTarget({
          organizationId: fixture.organizationId,
          userId: fixture.userId,
          target: {
            type: CommentTargetType.Session,
            id: externalSessionId,
          },
          computeTargetId: withComputeTarget ? fixture.computeTargetId : null,
        });

        expect(resolved?.artifactId).toBe(fixture.artifactId);
      });
    }
  );

  it("resolves an encoded Branch id through the decodeBranchId fallback", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const organizationId = await createTestOrganization();
      const branchArtifactId = await seedBranch(organizationId);

      const resolved = await withDb((db) =>
        resolveProductBranchArtifactId(db, {
          organizationId,
          targetId: encodeBranchId({
            repoFullName: REPOSITORY_FULL_NAME,
            branchName: BRANCH_NAME,
          }),
        })
      );

      expect(resolved).toBe(branchArtifactId);
    });
  });

  it("still resolves a Branch by its artifact id", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const organizationId = await createTestOrganization();
      const branchArtifactId = await seedBranch(organizationId);

      const resolved = await withDb((db) =>
        resolveProductBranchArtifactId(db, {
          organizationId,
          targetId: branchArtifactId,
        })
      );

      expect(resolved).toBe(branchArtifactId);
    });
  });
});
