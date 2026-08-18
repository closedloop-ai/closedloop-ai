import { randomUUID } from "node:crypto";
/**
 * FEA-1718 back-link, PRODUCTION WIRING. These drive the real ingest entry point
 * — `agentSessionsService.upsertSessions` — against a real Postgres, so deleting
 * the `linkLoopSessionArtifact` call from the ingest loop turns them red. A unit
 * test of the helper alone would stay green through exactly that deletion, which
 * is the failure mode this column already had: a schema declaration, a unique
 * index, and no production writer.
 *
 * Only a real database can prove the two properties that matter here — that a
 * re-sync does not trip `loops_session_artifact_id_key`, and that the guarded
 * single-statement claim is genuinely idempotent rather than idempotent-looking.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { LoopCommand, LoopStatus, SessionOrigin, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { agentSessionsService } from "@/app/agent-sessions/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const describeIfDb = env.DATABASE_URL ? describe : describe.skip;

const SESSION_STARTED_AT = "2026-08-10T10:00:00.000Z";
const SESSION_UPDATED_AT = "2026-08-10T11:00:00.000Z";

function createComputeTarget(organizationId: string, userId: string) {
  return withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: "backlink-integration-machine",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
}

function createLoop(organizationId: string, userId: string) {
  return withDb((db) =>
    db.loop.create({
      data: {
        organizationId,
        userId,
        command: LoopCommand.EXECUTE,
        status: LoopStatus.RUNNING,
      },
      select: { id: true },
    })
  );
}

function readLoopSessionArtifactId(loopId: string) {
  return withDb(async (db) => {
    const loop = await db.loop.findUnique({
      where: { id: loopId },
      select: { sessionArtifactId: true },
    });
    return loop?.sessionArtifactId ?? null;
  });
}

function readSessionArtifactId(
  computeTargetId: string,
  externalSessionId: string
) {
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

function readSessionRow(computeTargetId: string, externalSessionId: string) {
  return withDb((db) =>
    db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: { artifactId: true, origin: true, sourceLoopId: true },
    })
  );
}

function buildSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "ext-backlink-1",
    name: "Materialized run",
    status: "active",
    harness: "claude",
    startedAt: SESSION_STARTED_AT,
    updatedAt: SESSION_UPDATED_AT,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

function buildPayload(
  sessions: SyncedAgentSession[]
): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "0f4a1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

async function seedIngestFixture() {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const computeTarget = await createComputeTarget(organizationId, user.id);
  return {
    computeTargetId: computeTarget.id,
    context: {
      organizationId,
      userId: user.id,
      computeTargetId: computeTarget.id,
    },
    organizationId,
    userId: user.id,
  };
}

describeIfDb("Loop.sessionArtifactId back-link at materialization", () => {
  it("points the loop at the session artifact that materialized it", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedIngestFixture();
      const loop = await createLoop(fixture.organizationId, fixture.userId);

      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([buildSession({ attribution: { sourceLoopId: loop.id } })])
      );

      const sessionArtifactId = await readSessionArtifactId(
        fixture.computeTargetId,
        "ext-backlink-1"
      );
      expect(sessionArtifactId).not.toBeNull();
      expect(await readLoopSessionArtifactId(loop.id)).toBe(sessionArtifactId);
    });
  });

  it("survives a re-sync of the same session without a unique violation", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedIngestFixture();
      const loop = await createLoop(fixture.organizationId, fixture.userId);
      const payload = buildPayload([
        buildSession({ attribution: { sourceLoopId: loop.id } }),
      ]);

      await agentSessionsService.upsertSessions(fixture.context, payload);
      // The at-least-once desktop sync redelivers the same session; the claim
      // must no-op rather than re-test `loops_session_artifact_id_key`.
      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([
          buildSession({
            attribution: { sourceLoopId: loop.id },
            updatedAt: "2026-08-10T12:00:00.000Z",
          }),
        ])
      );

      expect(await readLoopSessionArtifactId(loop.id)).toBe(
        await readSessionArtifactId(fixture.computeTargetId, "ext-backlink-1")
      );
    });
  });

  it("keeps the earlier session's claim when a later one names the same loop", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedIngestFixture();
      const loop = await createLoop(fixture.organizationId, fixture.userId);

      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([buildSession({ attribution: { sourceLoopId: loop.id } })])
      );
      const firstArtifactId = await readSessionArtifactId(
        fixture.computeTargetId,
        "ext-backlink-1"
      );

      // A resumed run syncs as a SECOND session naming the same loop. At most
      // one Session per Loop, so the session that STARTED first keeps the link
      // and the continuation is ingested normally. The start times are explicit:
      // equal timestamps would resolve on the uuid tie-break instead, which
      // would make this assert id ordering rather than the winner policy.
      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([
          buildSession({
            externalSessionId: "ext-backlink-2",
            startedAt: "2026-08-10T16:00:00.000Z",
            attribution: { sourceLoopId: loop.id },
          }),
        ])
      );

      const secondArtifactId = await readSessionArtifactId(
        fixture.computeTargetId,
        "ext-backlink-2"
      );
      expect(secondArtifactId).not.toBeNull();
      expect(secondArtifactId).not.toBe(firstArtifactId);
      expect(await readLoopSessionArtifactId(loop.id)).toBe(firstArtifactId);
    });
  });

  it("leaves the column unset for a session that names no loop", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedIngestFixture();
      const loop = await createLoop(fixture.organizationId, fixture.userId);

      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([
          buildSession({ attribution: { repositoryFullName: "acme/app" } }),
        ])
      );

      expect(
        await readSessionArtifactId(fixture.computeTargetId, "ext-backlink-1")
      ).not.toBeNull();
      // No loop was named, so nothing is written — the unrelated loop is not
      // claimed by an arbitrary session.
      expect(await readLoopSessionArtifactId(loop.id)).toBeNull();
    });
  });

  // wongk (review): the live claim previously fired only when the loop was
  // unclaimed, so ARRIVAL ORDER picked the winner while the backfill picked the
  // earliest `sessionStartedAt`. The same two rows then resolved differently
  // depending on rollout timing. These two cases pin the SAME winner in BOTH
  // arrival orders, which is the property that makes live and backfill agree.
  it("picks the earliest-started session when the newer one syncs first", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedIngestFixture();
      const loop = await createLoop(fixture.organizationId, fixture.userId);

      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([
          buildSession({
            externalSessionId: "ext-backlink-late",
            startedAt: "2026-08-10T14:00:00.000Z",
            attribution: { sourceLoopId: loop.id },
          }),
        ])
      );
      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([
          buildSession({
            externalSessionId: "ext-backlink-early",
            startedAt: "2026-08-10T09:00:00.000Z",
            attribution: { sourceLoopId: loop.id },
          }),
        ])
      );

      const early = await readSessionArtifactId(
        fixture.computeTargetId,
        "ext-backlink-early"
      );
      // The later-arriving but earlier-STARTED session takes the link over.
      expect(await readLoopSessionArtifactId(loop.id)).toBe(early);
    });
  });

  it("reaches the same winner when the earlier one syncs first", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedIngestFixture();
      const loop = await createLoop(fixture.organizationId, fixture.userId);

      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([
          buildSession({
            externalSessionId: "ext-backlink-early",
            startedAt: "2026-08-10T09:00:00.000Z",
            attribution: { sourceLoopId: loop.id },
          }),
        ])
      );
      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([
          buildSession({
            externalSessionId: "ext-backlink-late",
            startedAt: "2026-08-10T14:00:00.000Z",
            attribution: { sourceLoopId: loop.id },
          }),
        ])
      );

      const early = await readSessionArtifactId(
        fixture.computeTargetId,
        "ext-backlink-early"
      );
      expect(await readLoopSessionArtifactId(loop.id)).toBe(early);
    });
  });

  // wongk (review): `origin` is what the stale reaper and both retention sweeps
  // filter on. Left at DESKTOP_SYNC, the phantom sweep deletes the artifact and
  // `onDelete: SetNull` erases the back-link within a retention window.
  it("marks a validated loop-materialized session as LOOP origin", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedIngestFixture();
      const loop = await createLoop(fixture.organizationId, fixture.userId);

      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([buildSession({ attribution: { sourceLoopId: loop.id } })])
      );

      const row = await readSessionRow(
        fixture.computeTargetId,
        "ext-backlink-1"
      );
      expect(row?.origin).toBe(SessionOrigin.LOOP);
    });
  });

  it("leaves origin at DESKTOP_SYNC for an unvalidated cross-org loop id", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedIngestFixture();
      const otherOrganizationId = await createTestOrganization();
      const otherUser = await createTestUser(otherOrganizationId);
      const foreignLoop = await createLoop(otherOrganizationId, otherUser.id);

      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([
          buildSession({ attribution: { sourceLoopId: foreignLoop.id } }),
        ])
      );

      // Origin decides retention exemption, so an unvalidated loop id must not
      // be able to buy a row immunity from deletion.
      const row = await readSessionRow(
        fixture.computeTargetId,
        "ext-backlink-1"
      );
      expect(row?.origin).toBe(SessionOrigin.DESKTOP_SYNC);
    });
  });

  // wongk (review): the update arm writes only NON-NULL attribution, so a
  // delivery omitting sourceLoopId preserves the stored loop. Deriving the
  // back-link from the incoming payload skipped exactly this case.
  it("still links when a later delivery omits the attribution", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedIngestFixture();
      const loop = await createLoop(fixture.organizationId, fixture.userId);

      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([buildSession({ attribution: { sourceLoopId: loop.id } })])
      );
      await withDb((db) =>
        db.loop.update({
          where: { id: loop.id },
          data: { sessionArtifactId: null },
        })
      );
      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([buildSession({ updatedAt: "2026-08-10T13:00:00.000Z" })])
      );

      const row = await readSessionRow(
        fixture.computeTargetId,
        "ext-backlink-1"
      );
      expect(row?.sourceLoopId).toBe(loop.id);
      expect(await readLoopSessionArtifactId(loop.id)).toBe(row?.artifactId);
    });
  });

  // wongk (review): when a session's attribution moves A -> B, A's pointer is
  // both stale and the reason B's claim would raise 23505. Both sides must be
  // reconciled so the two columns cannot tell different stories.
  it("moves the link when the session is re-attributed to another loop", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedIngestFixture();
      const loopA = await createLoop(fixture.organizationId, fixture.userId);
      const loopB = await createLoop(fixture.organizationId, fixture.userId);

      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([
          buildSession({ attribution: { sourceLoopId: loopA.id } }),
        ])
      );
      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([
          buildSession({
            updatedAt: "2026-08-10T13:00:00.000Z",
            attribution: { sourceLoopId: loopB.id },
          }),
        ])
      );

      const row = await readSessionRow(
        fixture.computeTargetId,
        "ext-backlink-1"
      );
      expect(row?.sourceLoopId).toBe(loopB.id);
      expect(await readLoopSessionArtifactId(loopB.id)).toBe(row?.artifactId);
      // A no longer has a session, so its stale pointer is released rather than
      // left contradicting session_detail.source_loop_id.
      expect(await readLoopSessionArtifactId(loopA.id)).toBeNull();
    });
  });

  it("keeps a real link when the payload names a loop that does not exist", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedIngestFixture();
      const loop = await createLoop(fixture.organizationId, fixture.userId);

      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([buildSession({ attribution: { sourceLoopId: loop.id } })])
      );
      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([
          buildSession({
            updatedAt: "2026-08-10T13:00:00.000Z",
            attribution: { sourceLoopId: randomUUID() },
          }),
        ])
      );

      // The release is guarded on the new target existing in the same org, so a
      // bogus id cannot destroy a link and put nothing in its place.
      const artifactId = await readSessionArtifactId(
        fixture.computeTargetId,
        "ext-backlink-1"
      );
      expect(await readLoopSessionArtifactId(loop.id)).toBe(artifactId);
    });
  });

  // A back-link that simply matches no rows is benign. The THROWING case — the
  // one wongk's review is actually about — cannot be forced deterministically
  // against a real database, so it is pinned in
  // `service/upsert-sessions-batch.test.ts`, which makes the claim raise and
  // asserts the following sessions still ingest.
  it("ingests every session in a batch when one back-link matches nothing", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedIngestFixture();
      const loop = await createLoop(fixture.organizationId, fixture.userId);

      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([
          buildSession({
            externalSessionId: "ext-batch-1",
            // Not a loop this org owns, and not even a real one.
            attribution: { sourceLoopId: randomUUID() },
          }),
          buildSession({
            externalSessionId: "ext-batch-2",
            attribution: { sourceLoopId: loop.id },
          }),
        ])
      );

      expect(
        await readSessionArtifactId(fixture.computeTargetId, "ext-batch-1")
      ).not.toBeNull();
      const second = await readSessionArtifactId(
        fixture.computeTargetId,
        "ext-batch-2"
      );
      expect(second).not.toBeNull();
      expect(await readLoopSessionArtifactId(loop.id)).toBe(second);
    });
  });

  it("refuses to claim a loop belonging to another organization", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedIngestFixture();
      const otherOrganizationId = await createTestOrganization();
      const otherUser = await createTestUser(otherOrganizationId);
      const foreignLoop = await createLoop(otherOrganizationId, otherUser.id);

      await agentSessionsService.upsertSessions(
        fixture.context,
        buildPayload([
          buildSession({ attribution: { sourceLoopId: foreignLoop.id } }),
        ])
      );

      // `sourceLoopId` is caller-supplied, so the org predicate is the only
      // thing stopping one tenant's sync from writing another tenant's row.
      expect(
        await readSessionArtifactId(fixture.computeTargetId, "ext-backlink-1")
      ).not.toBeNull();
      expect(await readLoopSessionArtifactId(foreignLoop.id)).toBeNull();
    });
  });
});
