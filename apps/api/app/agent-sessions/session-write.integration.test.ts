/**
 * ISS-8745 — the Sessions write paths (PR #6330) against a real Postgres.
 *
 * The sibling `session-write-service.test.ts` proves the same invariants against
 * a fake seam that interprets the `where` clauses production builds. This suite
 * exists because three of those invariants are claims about the DATABASE, not
 * about the clauses:
 *
 *  • a nested `artifact: { is: { organizationId, type } }` filter on a to-one
 *    relation has to compile to a correctly org-scoped UPDATE on Prisma 7.8;
 *  • "the transaction unwound" is only observable by RE-READING the authorized
 *    rows after the refusing call has ended;
 *  • `pg_advisory_xact_lock` is a Postgres primitive with no fake at all.
 *
 * NOT wrapped in `autoRollbackTransaction`, and that is load-bearing rather than
 * an omission. `withDb.tx` JOINS an ambient transaction through AsyncLocalStorage
 * (`packages/database/index.ts`), so under an outer test transaction the
 * service's `SessionWriteRefusal` would unwind nothing — it is caught by
 * `runSessionWrite` and the ambient transaction carries the partial write on. A
 * rollback proved that way would be proving the harness. Every case here commits
 * for real against tracked organizations and `afterEach` removes them.
 *
 * Authorization is UNCHANGED here: ISS-8675 settled that organization membership
 * is the boundary and no member-role gate exists. Nothing in this file asserts a
 * role.
 */
import { randomUUID } from "node:crypto";
import { Status } from "@repo/api/src/types/result";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { IndexKeyOrigin } from "@/lib/index-key-lookup";
import { acquireSessionAdvisoryLocks } from "./service/advisory-locks";
import { sessionWriteService } from "./session-write-service";
import { AgentSessionBulkAssignField } from "./write-contract";

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizations = createCommittedTestOrganizationTracker();

/** Fixed so nothing in this suite reads a wall clock. */
const SEEDED_AT = new Date("2026-09-01T09:00:00.000Z");

type OrgWorld = {
  organizationId: string;
  userId: string;
  otherUserId: string;
  computeTargetId: string;
  projectId: string;
  otherProjectId: string;
};

describe.skipIf(!hasDatabase)(
  "ISS-8745 Sessions write isolation against real Postgres",
  () => {
    afterEach(() => organizations.cleanup());

    it("scopes the owner patch by the artifact organization predicate", async () => {
      const [home, foreign] = await Promise.all([seedOrg(), seedOrg()]);
      const sessionId = await seedSession(home);

      await expect(
        sessionWriteService.updateSession({
          organizationId: foreign.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" },
          ownerUserId: foreign.userId,
        })
      ).resolves.toEqual({ ok: false, error: Status.NotFound });
      await expect(readOwnerUserId(sessionId)).resolves.toBeNull();

      const admitted = await sessionWriteService.updateSession({
        organizationId: home.organizationId,
        sessionId,
        actor: { userId: "test-actor", authMethod: "session" },
        ownerUserId: home.userId,
      });
      expect(admitted.ok).toBe(true);
      await expect(readOwnerUserId(sessionId)).resolves.toBe(home.userId);
    });

    it("scopes a status-only patch by the FLAT artifact organization predicate", async () => {
      // The same flat `id + organizationId + type` predicate the owner patch
      // above uses (ISS-12251 D-1 moved the owner onto the artifact), driven by
      // a status-only body.
      const [home, foreign] = await Promise.all([seedOrg(), seedOrg()]);
      const sessionId = await seedSession(home);

      await expect(
        sessionWriteService.updateSession({
          organizationId: foreign.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" },
          status: SESSION_STATUS.INACTIVE,
        })
      ).resolves.toEqual({ ok: false, error: Status.NotFound });
      await expect(readArtifactStatus(sessionId)).resolves.toBe(
        SESSION_STATUS.ACTIVE
      );

      const admitted = await sessionWriteService.updateSession({
        organizationId: home.organizationId,
        sessionId,
        actor: { userId: "test-actor", authMethod: "session" },
        status: SESSION_STATUS.INACTIVE,
      });
      expect(admitted.ok).toBe(true);
      await expect(readArtifactStatus(sessionId)).resolves.toBe(
        SESSION_STATUS.INACTIVE
      );
    });

    it("keeps the artifact TYPE in the owner patch's predicate", async () => {
      const home = await seedOrg();
      const documentId = await seedSession(home, {
        type: ArtifactType.DOCUMENT,
      });

      await expect(
        sessionWriteService.updateSession({
          organizationId: home.organizationId,
          sessionId: documentId,
          actor: { userId: "test-actor", authMethod: "session" },
          ownerUserId: home.userId,
        })
      ).resolves.toEqual({ ok: false, error: Status.NotFound });
      await expect(readOwnerUserId(documentId)).resolves.toBeNull();
    });

    it("leaves the authorized rows at their pre-call project when a bulk set mixes in a cross-org id", async () => {
      const [home, foreign] = await Promise.all([seedOrg(), seedOrg()]);
      const [first, second] = await Promise.all([
        seedSession(home, { projectId: home.projectId }),
        seedSession(home, { projectId: home.projectId }),
      ]);
      const foreignSessionId = await seedSession(foreign);

      await expect(
        sessionWriteService.bulkAssignSessions({
          organizationId: home.organizationId,
          sessionIds: [first, second, foreignSessionId],
          field: AgentSessionBulkAssignField.Project,
          value: home.otherProjectId,
        })
      ).resolves.toEqual({ ok: false, error: Status.NotFound });
      // The refusal is only meaningful if the authorized rows were untouched, so
      // re-read them rather than trusting the returned error.
      await expect(readProjectIds([first, second])).resolves.toEqual([
        home.projectId,
        home.projectId,
      ]);
      await expect(readProjectIds([foreignSessionId])).resolves.toEqual([null]);

      // ...and only if the same call WOULD have written without the foreign id.
      const admitted = await sessionWriteService.bulkAssignSessions({
        organizationId: home.organizationId,
        sessionIds: [first, second],
        field: AgentSessionBulkAssignField.Project,
        value: home.otherProjectId,
      });
      expect(admitted.ok).toBe(true);
      await expect(readProjectIds([first, second])).resolves.toEqual([
        home.otherProjectId,
        home.otherProjectId,
      ]);
    });

    it("leaves the surviving rows' owner unchanged when a bulk set names a deleted id", async () => {
      const home = await seedOrg();
      const [first, second, doomed] = await Promise.all([
        seedSession(home, { ownerUserId: home.userId }),
        seedSession(home, { ownerUserId: home.userId }),
        seedSession(home),
      ]);
      await withDb((db) => db.artifact.delete({ where: { id: doomed } }));

      // `updateMany` reports `{count: 0}` for the deleted id where `update` would
      // have thrown P2025, so this is the shape that goes silently partial if the
      // count comparison is dropped.
      await expect(
        sessionWriteService.bulkAssignSessions({
          organizationId: home.organizationId,
          sessionIds: [first, second, doomed],
          field: AgentSessionBulkAssignField.Owner,
          value: home.otherUserId,
        })
      ).resolves.toEqual({ ok: false, error: Status.NotFound });
      await expect(readOwnerUserIds([first, second])).resolves.toEqual([
        home.userId,
        home.userId,
      ]);

      const admitted = await sessionWriteService.bulkAssignSessions({
        organizationId: home.organizationId,
        sessionIds: [first, second],
        field: AgentSessionBulkAssignField.Owner,
        value: home.otherUserId,
      });
      expect(admitted.ok).toBe(true);
      await expect(readOwnerUserIds([first, second])).resolves.toEqual([
        home.otherUserId,
        home.otherUserId,
      ]);
    });

    it("leaves the authorized rows' owner unchanged when a bulk OWNER set mixes in a cross-org id", async () => {
      // The org predicate under `id: { in: [...] }` — a different query from
      // the single-row owner patch, and the one that has to exclude a foreign
      // row from a MULTI-row update.
      const [home, foreign] = await Promise.all([seedOrg(), seedOrg()]);
      const [first, second] = await Promise.all([
        seedSession(home, { ownerUserId: home.userId }),
        seedSession(home, { ownerUserId: home.userId }),
      ]);
      const foreignSessionId = await seedSession(foreign);

      await expect(
        sessionWriteService.bulkAssignSessions({
          organizationId: home.organizationId,
          sessionIds: [first, second, foreignSessionId],
          field: AgentSessionBulkAssignField.Owner,
          value: home.otherUserId,
        })
      ).resolves.toEqual({ ok: false, error: Status.NotFound });
      await expect(readOwnerUserIds([first, second])).resolves.toEqual([
        home.userId,
        home.userId,
      ]);
      await expect(readOwnerUserIds([foreignSessionId])).resolves.toEqual([
        null,
      ]);

      const admitted = await sessionWriteService.bulkAssignSessions({
        organizationId: home.organizationId,
        sessionIds: [first, second],
        field: AgentSessionBulkAssignField.Owner,
        value: home.otherUserId,
      });
      expect(admitted.ok).toBe(true);
      await expect(readOwnerUserIds([first, second])).resolves.toEqual([
        home.otherUserId,
        home.otherUserId,
      ]);
    });

    it("refuses a cross-org project TARGET on a bulk assign whose every session id is authorized", async () => {
      const [home, foreign] = await Promise.all([seedOrg(), seedOrg()]);
      const [first, second] = await Promise.all([
        seedSession(home, { projectId: home.projectId }),
        seedSession(home, { projectId: home.projectId }),
      ]);

      await expect(
        sessionWriteService.bulkAssignSessions({
          organizationId: home.organizationId,
          sessionIds: [first, second],
          field: AgentSessionBulkAssignField.Project,
          value: foreign.projectId,
        })
      ).resolves.toEqual({ ok: false, error: Status.BadRequest });
      await expect(readProjectIds([first, second])).resolves.toEqual([
        home.projectId,
        home.projectId,
      ]);
    });

    it("refuses a cross-org owner TARGET on a single-session update", async () => {
      const [home, foreign] = await Promise.all([seedOrg(), seedOrg()]);
      const sessionId = await seedSession(home, { ownerUserId: home.userId });

      await expect(
        sessionWriteService.updateSession({
          organizationId: home.organizationId,
          sessionId,
          actor: { userId: "test-actor", authMethod: "session" },
          ownerUserId: foreign.userId,
        })
      ).resolves.toEqual({ ok: false, error: Status.BadRequest });
      await expect(readOwnerUserId(sessionId)).resolves.toBe(home.userId);
    });

    it("refuses a cross-org compute TARGET on create and leaves no session behind", async () => {
      const [home, foreign] = await Promise.all([seedOrg(), seedOrg()]);
      const externalSessionId = `iss-8745-${randomUUID()}`;

      await expect(
        sessionWriteService.createSession({
          organizationId: home.organizationId,
          actorUserId: home.userId,
          computeTargetId: foreign.computeTargetId,
          externalSessionId,
        })
      ).resolves.toEqual({ ok: false, error: Status.BadRequest });
      await expect(
        readDetailArtifactId(foreign.computeTargetId, externalSessionId)
      ).resolves.toBeNull();

      const admitted = await sessionWriteService.createSession({
        organizationId: home.organizationId,
        actorUserId: home.userId,
        computeTargetId: home.computeTargetId,
        externalSessionId,
      });
      expect(admitted.ok).toBe(true);
      const created = await withDb((db) =>
        db.sessionDetail.findUniqueOrThrow({
          where: {
            computeTargetId_externalSessionId: {
              computeTargetId: home.computeTargetId,
              externalSessionId,
            },
          },
          select: { metadataActivityCoverageStartedAt: true },
        })
      );
      expect(created.metadataActivityCoverageStartedAt).toBeInstanceOf(Date);
    });

    it("writes a status and an owner in one artifact update", async () => {
      const home = await seedOrg();
      // ISS-12251 D-1: the owner lives on the artifact, so there is no second
      // row whose miss could leave the status half applied.
      const sessionId = await seedSession(home);

      const admitted = await sessionWriteService.updateSession({
        organizationId: home.organizationId,
        sessionId,
        actor: { userId: "test-actor", authMethod: "session" },
        status: SESSION_STATUS.INACTIVE,
        ownerUserId: home.userId,
      });

      expect(admitted.ok).toBe(true);
      await expect(readArtifactStatus(sessionId)).resolves.toBe(
        SESSION_STATUS.INACTIVE
      );
      await expect(readOwnerUserId(sessionId)).resolves.toBe(home.userId);
    });

    it("creates the session with the validated ownerUserId as its assignee, and none when omitted", async () => {
      const home = await seedOrg();
      const create = (ownerUserId?: string) =>
        sessionWriteService.createSession({
          organizationId: home.organizationId,
          actorUserId: home.userId,
          computeTargetId: home.computeTargetId,
          externalSessionId: `iss-12251-${randomUUID()}`,
          ...(ownerUserId ? { ownerUserId } : {}),
        });

      const owned = await create(home.otherUserId);
      const unowned = await create();
      if (!(owned.ok && unowned.ok)) {
        throw new Error("expected both creates to succeed");
      }

      await expect(readOwnerUserId(owned.value.session.id)).resolves.toBe(
        home.otherUserId
      );
      // No fallback to the caller (PR #8734 review).
      await expect(
        readOwnerUserId(unowned.value.session.id)
      ).resolves.toBeNull();
    });

    it("serializes two concurrent creates of one session identity onto a single row", async () => {
      const home = await seedOrg();
      const externalSessionId = `iss-8745-${randomUUID()}`;
      const create = () =>
        sessionWriteService.createSession({
          organizationId: home.organizationId,
          actorUserId: home.userId,
          computeTargetId: home.computeTargetId,
          externalSessionId,
        });

      const [first, second] = await Promise.all([create(), create()]);
      if (!(first.ok && second.ok)) {
        throw new Error("a concurrent create did not resolve to a Result");
      }
      expect([first.value.created, second.value.created].sort()).toEqual([
        false,
        true,
      ]);
      expect(first.value.session.id).toBe(second.value.session.id);
      await expect(
        countDetails(home.computeTargetId, externalSessionId)
      ).resolves.toBe(1);
    }, 20_000);

    it("makes a create WAIT behind the lock an in-flight sync holds, then adopt its row", async () => {
      const home = await seedOrg();
      const externalSessionId = `iss-8745-${randomUUID()}`;
      const release = deferred<void>();
      // A desktop ingest mid-transaction: same per-session advisory lock, row
      // inserted, not yet committed. A create that skips the lock reads past the
      // uncommitted row and races its own INSERT into the unique index.
      const holder = withDb.tx(
        async (tx) => {
          await acquireSessionAdvisoryLocks(
            tx,
            externalSessionId,
            IndexKeyOrigin.Wire
          );
          await tx.sessionDetail.create({
            data: {
              artifact: {
                create: {
                  organizationId: home.organizationId,
                  type: ArtifactType.SESSION,
                  name: "iss-8745 in-flight sync",
                  status: SESSION_STATUS.ACTIVE,
                },
              },
              computeTarget: { connect: { id: home.computeTargetId } },
              externalSessionId,
              sessionStartedAt: SEEDED_AT,
              sessionUpdatedAt: SEEDED_AT,
              lastActivityAt: SEEDED_AT,
            },
            select: { artifactId: true },
          });
          await release.promise;
        },
        { timeout: 20_000 }
      );
      // Assert the precondition instead of assuming it. If the holder has not
      // taken the lock yet, starting the create below would let it acquire the
      // lock UNCONTENDED and race the holder's own INSERT into the unique
      // index — reporting a P2002 that reads like a production defect when the
      // real fault is a scheduling delay in this test. Release the holder first
      // so its transaction cannot outlive the failure.
      if (!(await waitForLockState(externalSessionId, "held"))) {
        release.resolve();
        const holderOutcome = await holder.then(
          () => "committed",
          (error: unknown) => `failed with ${String(error)}`
        );
        throw new Error(
          `precondition unmet: the in-flight sync never took the advisory lock within ${LOCK_POLL_DEADLINE_MS}ms (holder ${holderOutcome}); createSession was not started`
        );
      }

      const creating = sessionWriteService.createSession({
        organizationId: home.organizationId,
        actorUserId: home.userId,
        computeTargetId: home.computeTargetId,
        externalSessionId,
      });
      const blocked = await waitForLockState(externalSessionId, "waiting");
      release.resolve();
      const [, created] = await Promise.all([holder, creating]);

      expect(blocked).toBe(true);
      if (!created.ok) {
        throw new Error(`create refused with status ${created.error}`);
      }
      expect(created.value.created).toBe(false);
      await expect(
        countDetails(home.computeTargetId, externalSessionId)
      ).resolves.toBe(1);
    }, 20_000);
  }
);

async function seedOrg(): Promise<OrgWorld> {
  const organizationId = await organizations.create();
  const [user, otherUser] = await Promise.all([
    createTestUser(organizationId),
    createTestUser(organizationId),
  ]);
  const [computeTargetId, projectId, otherProjectId] = await Promise.all([
    createComputeTarget(organizationId, user.id, `lane-8745-${randomUUID()}`),
    createTestProject(organizationId, user.id, { name: "Seeded project" }),
    createTestProject(organizationId, user.id, { name: "Target project" }),
  ]);
  return {
    organizationId,
    userId: user.id,
    otherUserId: otherUser.id,
    computeTargetId,
    projectId,
    otherProjectId,
  };
}

/**
 * Seed a session with raw Prisma rather than through `createSession`, so no
 * expectation in this suite is derived from a predicate the suite is proving.
 */
function seedSession(
  world: OrgWorld,
  overrides: {
    projectId?: string;
    ownerUserId?: string;
    type?: (typeof ArtifactType)[keyof typeof ArtifactType];
  } = {}
): Promise<string> {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId: world.organizationId,
        type: overrides.type ?? ArtifactType.SESSION,
        name: `iss-8745-${randomUUID()}`,
        status: SESSION_STATUS.ACTIVE,
        ...(overrides.projectId ? { projectId: overrides.projectId } : {}),
        // ISS-12251 D-1: the Owner is the assignee.
        ...(overrides.ownerUserId ? { assigneeId: overrides.ownerUserId } : {}),
        session: {
          create: {
            computeTargetId: world.computeTargetId,
            externalSessionId: `iss-8745-${randomUUID()}`,
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

/** The session's Owner: its artifact assignee (ISS-12251 D-1). */
function readOwnerUserId(artifactId: string): Promise<string | null> {
  return withDb(async (db) => {
    const artifact = await db.artifact.findUnique({
      where: { id: artifactId },
      select: { assigneeId: true },
    });
    return artifact?.assigneeId ?? null;
  });
}

async function readOwnerUserIds(
  artifactIds: readonly string[]
): Promise<(string | null)[]> {
  const owners = await Promise.all(artifactIds.map(readOwnerUserId));
  return owners;
}

function readProjectIds(
  artifactIds: readonly string[]
): Promise<(string | null)[]> {
  return withDb(async (db) => {
    const rows = await db.artifact.findMany({
      where: { id: { in: [...artifactIds] } },
      select: { id: true, projectId: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row.projectId]));
    return artifactIds.map((id) => byId.get(id) ?? null);
  });
}

function readArtifactStatus(artifactId: string): Promise<string> {
  return withDb(async (db) => {
    const artifact = await db.artifact.findUniqueOrThrow({
      where: { id: artifactId },
      select: { status: true },
    });
    return artifact.status;
  });
}

function readDetailArtifactId(
  computeTargetId: string,
  externalSessionId: string
): Promise<string | null> {
  return withDb(async (db) => {
    const detail = await db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: { artifactId: true },
    });
    return detail?.artifactId ?? null;
  });
}

function countDetails(
  computeTargetId: string,
  externalSessionId: string
): Promise<number> {
  return withDb((db) =>
    db.sessionDetail.count({
      where: { computeTargetId, externalSessionId },
    })
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * Poll `pg_locks` for the 32-bit half of this session's advisory-lock pair — the
 * one `acquireSessionAdvisoryLocks` takes FIRST, so it is where a second writer
 * queues. The key is recomputed with `hashtext` in SQL rather than read back from
 * the production helper, so "waiting" reports the lock the service actually took
 * rather than one this suite handed it.
 *
 * `pg_advisory_xact_lock` resolves to the bigint overload, which splits the key
 * across `classid` (high 32, sign-extended — 4294967295 for a negative hash) and
 * `objid` (low 32). Matching on `classid = 0` silently sees nothing for half of
 * all ids.
 *
 * Bounded, and returns the verdict instead of throwing: a caller that never sees
 * a waiter still has to release its blocker before it can assert, or the holding
 * transaction outlives the test.
 *
 * The deadline is the load-bearing half of that bound. A contender parked on this
 * lock is inside its own `withDb.tx`, which takes Prisma's default 5s
 * interactive-transaction timeout because `runSessionWrite` passes no options; a poll
 * that outran it would kill the contender's transaction and surface as an
 * unhandled rejection instead of the assertion below. Give up well short of it.
 */
const LOCK_POLL_DEADLINE_MS = 2000;

async function waitForLockState(
  externalSessionId: string,
  state: "held" | "waiting"
): Promise<boolean> {
  const granted = state === "held";
  const giveUpAt = Date.now() + LOCK_POLL_DEADLINE_MS;
  for (let attempt = 0; attempt < 400 && Date.now() < giveUpAt; attempt += 1) {
    const [row] = await withDb(
      (db) => db.$queryRaw<{ matches: number }[]>`
        SELECT count(*)::int AS matches
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND granted = ${granted}
          AND classid::bigint =
            ((hashtext(${externalSessionId})::bigint >> 32) & 4294967295)
          AND objid::bigint =
            (hashtext(${externalSessionId})::bigint & 4294967295)
      `
    );
    if ((row?.matches ?? 0) > 0) {
      return true;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return false;
}
