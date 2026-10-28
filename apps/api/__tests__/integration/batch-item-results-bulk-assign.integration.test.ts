/**
 * ISS-9464 AC-003 — bulk-assign `/v2` stays all-or-nothing against a real
 * Postgres.
 *
 * NOT wrapped in `autoRollbackTransaction`, and that is load-bearing rather than
 * an omission — the same reason `app/agent-sessions/session-write.integration
 * .test.ts` commits for real. `withDb.tx` JOINS an ambient transaction through
 * AsyncLocalStorage (`packages/database/index.ts`), so under an outer test
 * transaction the write's `SessionWriteRefusal` unwinds nothing: `runSessionWrite`
 * catches it and the ambient transaction carries the partial `updateMany` on.
 * "Nothing was written" proved that way would be proving the harness backwards
 * — it would report a write that production rolls back as one that survived.
 * Every case here commits against tracked organizations and `afterEach` removes
 * them.
 *
 * BOTH assignment fields are covered. The refused write cannot say which id was
 * bad (it only sees a row-count shortfall), so the service re-reads
 * reachability afterwards with the write's own predicate. Both fields write the
 * SESSION artifact row (the Owner as its assignee, ISS-12251 D-1), so a session
 * with no `session_detail` row is reachable on either field.
 *
 * The other five per-item services live in the sibling
 * `batch-item-results.integration.test.ts`, which CAN use the rollback harness.
 */
import { randomUUID } from "node:crypto";
import { BatchItemFailureCode } from "@repo/api/src/types/batch-mutation-result";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  readArtifactProjectId,
  resultFor,
} from "@/__tests__/support/integration/batch-item-results.test-helpers";
import { sessionBulkAssignItemService } from "@/app/agent-sessions/session-bulk-assign-item-service";
import { AgentSessionBulkAssignField } from "@/app/agent-sessions/write-contract";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizations = createCommittedTestOrganizationTracker();

type World = {
  organizationId: string;
  userId: string;
  otherUserId: string;
  projectId: string;
};

async function seedWorld(): Promise<World> {
  const organizationId = await organizations.create();
  const [user, otherUser] = await Promise.all([
    createTestUser(organizationId),
    createTestUser(organizationId),
  ]);
  const projectId = await createTestProject(organizationId, user.id);
  return {
    organizationId,
    userId: user.id,
    otherUserId: otherUser.id,
    projectId,
  };
}

function seedSession(world: World, label: string): Promise<string> {
  return createTestSessionDetail({
    organizationId: world.organizationId,
    userId: world.userId,
    label,
  });
}

/** A SESSION artifact with no `session_detail` row — the half-synced shape. */
function seedSessionWithoutDetail(
  world: World,
  label: string
): Promise<string> {
  return withDb(async (db) => {
    const session = await db.artifact.create({
      data: {
        organizationId: world.organizationId,
        type: ArtifactType.SESSION,
        name: `session-${label}-${randomUUID().slice(0, 8)}`,
        status: SESSION_STATUS.ACTIVE,
      },
      select: { id: true },
    });
    return session.id;
  });
}

function readSessionAssigneeId(id: string): Promise<string | null | undefined> {
  return withDb(async (db) => {
    const row = await db.artifact.findUnique({
      where: { id },
      select: { assigneeId: true },
    });
    return row?.assigneeId;
  });
}

describe.skipIf(!hasDatabase)(
  "ISS-9464 bulk-assign v2 all-or-nothing against real Postgres",
  () => {
    afterEach(() => organizations.cleanup());

    it("writes nothing and names the unreachable id when assigning a project", async () => {
      const [world, foreign] = await Promise.all([seedWorld(), seedWorld()]);
      const [reachable, alsoReachable, foreignSession] = await Promise.all([
        seedSession(world, "reachable"),
        seedSession(world, "also-reachable"),
        seedSession(foreign, "foreign"),
      ]);

      const result = await sessionBulkAssignItemService.bulkAssign({
        organizationId: world.organizationId,
        sessionIds: [reachable, foreignSession, alsoReachable],
        field: AgentSessionBulkAssignField.Project,
        value: world.projectId,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(resultFor(result.value.results, foreignSession)).toMatchObject({
        id: foreignSession,
        status: 404,
        code: BatchItemFailureCode.ArtifactsNotFound,
      });
      for (const id of [reachable, alsoReachable]) {
        expect(resultFor(result.value.results, id)).toMatchObject({
          id,
          status: 424,
          code: BatchItemFailureCode.BatchRefused,
        });
      }

      await expect(readArtifactProjectId(reachable)).resolves.toBeNull();
      await expect(readArtifactProjectId(alsoReachable)).resolves.toBeNull();
      await expect(readArtifactProjectId(foreignSession)).resolves.toBeNull();
    });

    it("writes no owner, names the unreachable id, and refuses a session with no detail row as a sibling", async () => {
      const [world, foreign] = await Promise.all([seedWorld(), seedWorld()]);
      const [reachable, detachedSession, foreignSession] = await Promise.all([
        seedSession(world, "owner-reachable"),
        seedSessionWithoutDetail(world, "owner-detached"),
        seedSession(foreign, "owner-foreign"),
      ]);
      const sessions = [reachable, detachedSession, foreignSession];
      // ISS-12251: a seeded session starts owned by its uploader, as ingest
      // creates it, so "no owner written" is "the assignee did not move".
      const assigneesBefore = await Promise.all(
        sessions.map(readSessionAssigneeId)
      );

      const result = await sessionBulkAssignItemService.bulkAssign({
        organizationId: world.organizationId,
        sessionIds: [reachable, foreignSession, detachedSession],
        field: AgentSessionBulkAssignField.Owner,
        value: world.otherUserId,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(resultFor(result.value.results, foreignSession)).toMatchObject({
        id: foreignSession,
        status: 404,
        code: BatchItemFailureCode.ArtifactsNotFound,
      });
      for (const id of [reachable, detachedSession]) {
        expect(resultFor(result.value.results, id)).toMatchObject({
          id,
          status: 424,
          code: BatchItemFailureCode.BatchRefused,
        });
      }

      expect(assigneesBefore).not.toContain(world.otherUserId);
      await expect(
        Promise.all(sessions.map(readSessionAssigneeId))
      ).resolves.toEqual(assigneesBefore);
    });

    it("assigns the owner of a session with no detail row", async () => {
      const world = await seedWorld();
      const [reachable, detachedSession] = await Promise.all([
        seedSession(world, "owner-applied"),
        seedSessionWithoutDetail(world, "owner-applied-detached"),
      ]);

      const result = await sessionBulkAssignItemService.bulkAssign({
        organizationId: world.organizationId,
        sessionIds: [reachable, detachedSession],
        field: AgentSessionBulkAssignField.Owner,
        value: world.otherUserId,
      });

      expect(result.ok).toBe(true);
      for (const id of [reachable, detachedSession]) {
        await expect(readSessionAssigneeId(id)).resolves.toBe(
          world.otherUserId
        );
      }
    });
  }
);
