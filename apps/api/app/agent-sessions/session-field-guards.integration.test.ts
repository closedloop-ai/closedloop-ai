/**
 * ISS-9486 — the per-field optimistic guards on `PATCH /agent-sessions/[id]`
 * against a real Postgres.
 *
 * Every case commits for real (no `autoRollbackTransaction`) for the reason
 * `session-write.integration.test.ts` states: `withDb.tx` joins an ambient
 * transaction, so under an outer test transaction the row locks these guards
 * take would be held by the harness and prove nothing.
 */
import { randomUUID } from "node:crypto";
import { AgentSessionFieldMutationErrorCode } from "@repo/api/src/types/agent-session-field-mutation";
import { Status } from "@repo/api/src/types/result";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { holdRowLock } from "@/__tests__/support/row-lock-holder";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { searchIndexService } from "@/app/search/search-index-service";
import { sessionRenameService } from "./session-rename-service";
import { sessionWriteService } from "./session-write-service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizations = createCommittedTestOrganizationTracker();

const SEEDED_AT = new Date("2026-09-23T09:00:00.000Z");
const COLLECTED_NAME = "iss-9486 collected name";
const RENAMED = "Renamed under a guard";
const RENAMED_AGAIN = "Renamed a second time";

type World = {
  organizationId: string;
  ownerId: string;
  otherUserId: string;
  computeTargetId: string;
  projectId: string;
  otherProjectId: string;
};

describe.skipIf(!hasDatabase)(
  "ISS-9486 session field guards against real Postgres",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await organizations.cleanup();
    });

    describe("status", () => {
      it("refuses a stale expectedStatus with stale_status and writes nothing", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world);
        await setStatus(sessionId, SESSION_STATUS.INACTIVE);

        const result = await sessionWriteService.updateSession({
          organizationId: world.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" },
          status: SESSION_STATUS.ERROR,
          expectedStatus: SESSION_STATUS.ACTIVE,
        });

        expect(result).toEqual({
          ok: false,
          error: expect.objectContaining({
            status: Status.Conflict,
            code: AgentSessionFieldMutationErrorCode.StaleStatus,
            details: {
              staleStatuses: [
                {
                  documentId: sessionId,
                  currentStatus: SESSION_STATUS.INACTIVE,
                  expectedStatus: SESSION_STATUS.ACTIVE,
                },
              ],
            },
          }),
        });
        await expect(readRow(sessionId)).resolves.toMatchObject({
          status: SESSION_STATUS.INACTIVE,
        });
      });

      it("accepts a same-value retry whose expectation is stale", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world);
        const write = {
          organizationId: world.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" as const },
          status: SESSION_STATUS.INACTIVE,
          expectedStatus: SESSION_STATUS.ACTIVE,
        };

        const first = await sessionWriteService.updateSession(write);
        const retry = await sessionWriteService.updateSession(write);

        expect(first.ok).toBe(true);
        expect(retry.ok).toBe(true);
        await expect(readRow(sessionId)).resolves.toMatchObject({
          status: SESSION_STATUS.INACTIVE,
        });
      });

      it("does not rewrite the row on a guarded same-value retry", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world);
        const write = {
          organizationId: world.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" as const },
          status: SESSION_STATUS.INACTIVE,
          expectedStatus: SESSION_STATUS.ACTIVE,
          ownerUserId: world.ownerId,
          expectedOwnerUserId: null,
        };
        const first = await sessionWriteService.updateSession(write);
        const afterFirst = await readRow(sessionId);

        const retry = await sessionWriteService.updateSession(write);

        expect([first.ok, retry.ok]).toEqual([true, true]);
        await expect(readRow(sessionId)).resolves.toEqual(afterFirst);
      });

      it("keeps last-write-wins when no expectation is sent", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world);
        await setStatus(sessionId, SESSION_STATUS.INACTIVE);

        const result = await sessionWriteService.updateSession({
          organizationId: world.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" },
          status: SESSION_STATUS.ERROR,
        });

        expect(result.ok).toBe(true);
        await expect(readRow(sessionId)).resolves.toMatchObject({
          status: SESSION_STATUS.ERROR,
        });
      });

      it("makes a guarded write wait behind a concurrent writer, then refuse the value that writer committed", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world);
        const holder = await holdRowLock((tx) =>
          tx.artifact.update({
            where: { id: sessionId },
            data: { status: SESSION_STATUS.INACTIVE },
            select: { id: true },
          })
        );

        const guarded = sessionWriteService.updateSession({
          organizationId: world.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" },
          status: SESSION_STATUS.ERROR,
          expectedStatus: SESSION_STATUS.ACTIVE,
        });
        const blocked = await holder.waitForWaiters(1);
        await holder.release();
        const result = await guarded;

        expect(blocked).toBe(true);
        expect(result.ok ? null : result.error).toMatchObject({
          code: AgentSessionFieldMutationErrorCode.StaleStatus,
        });
        await expect(readRow(sessionId)).resolves.toMatchObject({
          status: SESSION_STATUS.INACTIVE,
        });
      }, 20_000);
    });

    describe("projectId", () => {
      it("refuses a stale expectedProjectId, where null asserts no project", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world, {
          projectId: world.projectId,
        });

        const result = await sessionWriteService.updateSession({
          organizationId: world.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" },
          projectId: world.otherProjectId,
          expectedProjectId: null,
        });

        expect(result.ok ? null : result.error).toMatchObject({
          status: Status.Conflict,
          code: AgentSessionFieldMutationErrorCode.StaleProjectId,
          details: {
            staleProjectIds: [
              {
                documentId: sessionId,
                currentProjectId: world.projectId,
                expectedProjectId: null,
              },
            ],
          },
        });
        await expect(readRow(sessionId)).resolves.toMatchObject({
          projectId: world.projectId,
        });
      });

      it("honors a null expectation on an unassigned session, and accepts its same-value retry", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world);
        const write = {
          organizationId: world.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" as const },
          projectId: world.projectId,
          expectedProjectId: null,
        };

        const first = await sessionWriteService.updateSession(write);
        const retry = await sessionWriteService.updateSession(write);

        expect([first.ok, retry.ok]).toEqual([true, true]);
        await expect(readRow(sessionId)).resolves.toMatchObject({
          projectId: world.projectId,
        });
      });

      it("keeps last-write-wins when no expectation is sent", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world, {
          projectId: world.projectId,
        });

        const result = await sessionWriteService.updateSession({
          organizationId: world.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" },
          projectId: world.otherProjectId,
        });

        expect(result.ok).toBe(true);
        await expect(readRow(sessionId)).resolves.toMatchObject({
          projectId: world.otherProjectId,
        });
      });

      it("refuses a foreign project TARGET before it evaluates the guard", async () => {
        const [world, foreign] = await Promise.all([seedWorld(), seedWorld()]);
        const sessionId = await seedSession(world, {
          projectId: world.projectId,
        });

        const result = await sessionWriteService.updateSession({
          organizationId: world.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" },
          projectId: foreign.projectId,
          expectedProjectId: world.otherProjectId,
        });

        expect(result).toEqual({ ok: false, error: Status.BadRequest });
      });
    });

    describe("ownerUserId", () => {
      it("refuses a stale expectedOwnerUserId with stale_owner_user_id", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world, {
          ownerUserId: world.otherUserId,
        });

        const result = await sessionWriteService.updateSession({
          organizationId: world.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" as const },
          ownerUserId: world.ownerId,
          expectedOwnerUserId: null,
        });

        expect(result.ok ? null : result.error).toMatchObject({
          status: Status.Conflict,
          code: AgentSessionFieldMutationErrorCode.StaleOwnerUserId,
          details: {
            staleOwnerUserIds: [
              {
                documentId: sessionId,
                currentOwnerUserId: world.otherUserId,
                expectedOwnerUserId: null,
              },
            ],
          },
        });
        await expect(readRow(sessionId)).resolves.toMatchObject({
          ownerUserId: world.otherUserId,
        });
      });

      it("accepts a same-value retry whose expectation is stale", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world);
        const write = {
          organizationId: world.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" as const },
          ownerUserId: world.ownerId,
          expectedOwnerUserId: null,
        };

        const first = await sessionWriteService.updateSession(write);
        const retry = await sessionWriteService.updateSession(write);

        expect([first.ok, retry.ok]).toEqual([true, true]);
        await expect(readRow(sessionId)).resolves.toMatchObject({
          ownerUserId: world.ownerId,
        });
      });

      it("keeps last-write-wins when no expectation is sent", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world, {
          ownerUserId: world.otherUserId,
        });

        const result = await sessionWriteService.updateSession({
          organizationId: world.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" },
          ownerUserId: world.ownerId,
        });

        expect(result.ok).toBe(true);
        await expect(readRow(sessionId)).resolves.toMatchObject({
          ownerUserId: world.ownerId,
        });
      });

      it("reports every stale guard of one write, and names the first in its code", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world, {
          projectId: world.projectId,
          ownerUserId: world.otherUserId,
        });

        const result = await sessionWriteService.updateSession({
          organizationId: world.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" },
          projectId: world.otherProjectId,
          expectedProjectId: null,
          ownerUserId: world.ownerId,
          expectedOwnerUserId: null,
        });

        expect(result.ok ? null : result.error).toMatchObject({
          code: AgentSessionFieldMutationErrorCode.StaleProjectId,
          details: {
            staleProjectIds: [
              expect.objectContaining({ documentId: sessionId }),
            ],
            staleOwnerUserIds: [
              expect.objectContaining({ documentId: sessionId }),
            ],
          },
        });
        await expect(readRow(sessionId)).resolves.toMatchObject({
          projectId: world.projectId,
          ownerUserId: world.otherUserId,
        });
      });

      it("does not deadlock a guarded owner write against an unguarded write of the same row", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world, {
          ownerUserId: world.ownerId,
        });

        for (let round = 0; round < 5; round += 1) {
          const results = await Promise.all([
            sessionWriteService.updateSession({
              organizationId: world.organizationId,
              sessionId,
              actor: { userId: "test-actor", authMethod: "session" },
              status: SESSION_STATUS.INACTIVE,
              ownerUserId: world.ownerId,
              expectedOwnerUserId: world.ownerId,
            }),
            sessionWriteService.updateSession({
              organizationId: world.organizationId,
              sessionId,
              actor: { userId: "test-actor", authMethod: "session" },
              status: SESSION_STATUS.ACTIVE,
              ownerUserId: world.ownerId,
            }),
          ]);
          expect(results.map((result) => result.ok)).toEqual([true, true]);
        }
      }, 20_000);
    });

    describe("name", () => {
      it("refuses a stale expectedName with stale_name, and schedules no retitle", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world, {
          ownerUserId: world.ownerId,
        });
        const retitle = vi.spyOn(searchIndexService, "updateTitleAfterCommit");

        const result = await sessionRenameService.rename({
          id: sessionId,
          organizationId: world.organizationId,
          actorUserId: world.ownerId,
          authMethod: "session",
          actorIsOrgAdmin: false,
          name: RENAMED,
          expectedName: "a name this session never had",
        });

        expect(result.ok ? null : result.error).toMatchObject({
          status: Status.Conflict,
          code: AgentSessionFieldMutationErrorCode.StaleName,
          details: {
            staleNames: [
              {
                documentId: sessionId,
                currentName: COLLECTED_NAME,
                expectedName: "a name this session never had",
              },
            ],
          },
        });
        expect(retitle).not.toHaveBeenCalled();
        await expect(readRow(sessionId)).resolves.toMatchObject({
          nameOverride: null,
        });
      });

      it("compares with the rendered name, so a guarded second rename expects the first", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world, {
          ownerUserId: world.ownerId,
        });
        const rename = (name: string, expectedName: string) =>
          sessionRenameService.rename({
            id: sessionId,
            organizationId: world.organizationId,
            actorUserId: world.ownerId,
            authMethod: "session",
            actorIsOrgAdmin: false,
            name,
            expectedName,
          });

        const first = await rename(RENAMED, COLLECTED_NAME);
        const retry = await rename(RENAMED, COLLECTED_NAME);
        const staleSecond = await rename(RENAMED_AGAIN, COLLECTED_NAME);
        const second = await rename(RENAMED_AGAIN, RENAMED);

        expect([first.ok, retry.ok, second.ok]).toEqual([true, true, true]);
        expect(staleSecond.ok ? null : staleSecond.error).toMatchObject({
          code: AgentSessionFieldMutationErrorCode.StaleName,
        });
        await expect(readRow(sessionId)).resolves.toMatchObject({
          nameOverride: RENAMED_AGAIN,
        });
      });

      it("writes no override and queues no retitle for the name the session already shows", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world, {
          ownerUserId: world.ownerId,
        });
        const retitle = vi.spyOn(searchIndexService, "updateTitleAfterCommit");
        const rename = (expectedName?: string) =>
          sessionRenameService.rename({
            id: sessionId,
            organizationId: world.organizationId,
            actorUserId: world.ownerId,
            authMethod: "session",
            actorIsOrgAdmin: false,
            name: COLLECTED_NAME,
            ...(expectedName === undefined ? {} : { expectedName }),
          });

        const unguarded = await rename();
        const staleGuard = await rename("a name this session never had");

        expect([unguarded.ok, staleGuard.ok]).toEqual([true, true]);
        expect(retitle).not.toHaveBeenCalled();
        await expect(readRow(sessionId)).resolves.toMatchObject({
          nameOverride: null,
        });
      });

      it("answers a non-owner 403, not a 409 that would disclose the current name", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world, {
          ownerUserId: world.ownerId,
        });

        const result = await sessionRenameService.rename({
          id: sessionId,
          organizationId: world.organizationId,
          actorUserId: world.otherUserId,
          authMethod: "session",
          actorIsOrgAdmin: false,
          name: RENAMED,
          expectedName: "a name this session never had",
        });

        expect(result).toEqual({ ok: false, error: Status.Forbidden });
      });

      it("keeps last-write-wins when no expectation is sent", async () => {
        const world = await seedWorld();
        const sessionId = await seedSession(world, {
          ownerUserId: world.ownerId,
        });

        const result = await sessionRenameService.rename({
          id: sessionId,
          organizationId: world.organizationId,
          actorUserId: world.ownerId,
          authMethod: "session",
          actorIsOrgAdmin: false,
          name: RENAMED,
        });

        expect(result.ok).toBe(true);
        await expect(readRow(sessionId)).resolves.toMatchObject({
          nameOverride: RENAMED,
        });
      });
    });
  }
);

async function seedWorld(): Promise<World> {
  const organizationId = await organizations.create();
  const [owner, otherUser] = await Promise.all([
    createTestUser(organizationId),
    createTestUser(organizationId),
  ]);
  const [computeTargetId, projectId, otherProjectId] = await Promise.all([
    createComputeTarget(organizationId, owner.id, `lane-9486-${randomUUID()}`),
    createTestProject(organizationId, owner.id, { name: "Seeded project" }),
    createTestProject(organizationId, owner.id, { name: "Target project" }),
  ]);
  return {
    organizationId,
    ownerId: owner.id,
    otherUserId: otherUser.id,
    computeTargetId,
    projectId,
    otherProjectId,
  };
}

/** Raw Prisma, so no expectation here derives from the code under test. */
function seedSession(
  world: World,
  overrides: { projectId?: string; ownerUserId?: string } = {}
): Promise<string> {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId: world.organizationId,
        type: ArtifactType.SESSION,
        name: COLLECTED_NAME,
        status: SESSION_STATUS.ACTIVE,
        ...(overrides.projectId ? { projectId: overrides.projectId } : {}),
        // ISS-12251 D-1: the Owner is the assignee.
        ...(overrides.ownerUserId ? { assigneeId: overrides.ownerUserId } : {}),
        session: {
          create: {
            computeTargetId: world.computeTargetId,
            externalSessionId: `iss-9486-${randomUUID()}`,
            sessionStartedAt: SEEDED_AT,
            sessionUpdatedAt: SEEDED_AT,
            lastActivityAt: SEEDED_AT,
          },
        },
      },
      select: { id: true },
    });
    return artifact.id;
  });
}

function setStatus(sessionId: string, status: string): Promise<unknown> {
  return withDb((db) =>
    db.artifact.update({
      where: { id: sessionId },
      data: { status },
      select: { id: true },
    })
  );
}

async function readRow(sessionId: string) {
  const row = await withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        status: true,
        projectId: true,
        assigneeId: true,
        updatedAt: true,
        session: {
          select: { nameOverride: true, updatedAt: true },
        },
      },
    })
  );
  return {
    status: row.status,
    projectId: row.projectId,
    ownerUserId: row.assigneeId,
    nameOverride: row.session?.nameOverride ?? null,
    updatedAt: row.updatedAt.toISOString(),
    detailUpdatedAt: row.session?.updatedAt.toISOString() ?? null,
  };
}
