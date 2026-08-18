/**
 * Integration test for the FEA-3810 session-reopen transaction.
 *
 * Exercises the full production path: upsertSessions persists a session and its
 * events, the stale-session reaper marks the session inactive (ISS-4586 — the
 * terminal-not-failed state that supersedes abandoned), then a second
 * upsertSessions call with genuinely newer events reopens it (or correctly
 * leaves it inactive when no newer events arrive).
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
  type SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { staleSessionReaperService } from "@/app/agent-sessions/stale-session-reaper-service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;
const describeIfDb = hasDatabase ? describe : describe.skip;

// Session timestamps: old enough that a 1-hour reaper threshold marks them stale.
const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
// A "now" timestamp whose millisecond precision is stable across the test body.
const TEST_NOW = new Date();

function createComputeTarget(organizationId: string, userId: string) {
  return withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: "reopen-integration-test",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
}

function makeEvent(
  externalEventId: string,
  createdAt: Date
): SyncedAgentSessionEvent {
  return {
    externalEventId,
    eventType: "assistant",
    createdAt: createdAt.toISOString(),
  };
}

function buildSession(
  externalSessionId: string,
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId,
    name: "FEA-3810 reopen test",
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    cwd: "/tmp/worktree",
    model: "claude-opus",
    startedAt: TWO_DAYS_AGO.toISOString(),
    updatedAt: TWO_DAYS_AGO.toISOString(),
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
    batchId: randomUUID(),
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

function findSessionRow(computeTargetId: string, externalSessionId: string) {
  return withDb((db) =>
    db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: {
        sessionEndedAt: true,
        awaitingInputSince: true,
        lastActivityAt: true,
        artifact: { select: { status: true } },
      },
    })
  );
}

/**
 * Set STALE_SESSION_AGE_HOURS for the duration of `fn` and restore the previous
 * value (including undefined) in a finally block, matching the project's env-
 * mutation test rule.
 */
async function withStaleSessionThresholdHours<T>(
  hours: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = process.env.STALE_SESSION_AGE_HOURS;
  process.env.STALE_SESSION_AGE_HOURS = hours;
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      Reflect.deleteProperty(process.env, "STALE_SESSION_AGE_HOURS");
    } else {
      process.env.STALE_SESSION_AGE_HOURS = prev;
    }
  }
}

describeIfDb("agent-session reopen (FEA-3810)", () => {
  it("reopens an inactive session when a strictly newer event arrives via upsertSessions", async () => {
    // Unique external id per run so parallel CI executions do not collide.
    const extId = `reopen-newer-${randomUUID()}`;

    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const ctx = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };

      // 1. Initial sync: active session with one old event.
      const initialEvent = makeEvent("evt-initial", TWO_DAYS_AGO);
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSession(extId, {
            status: SESSION_STATUS.ACTIVE,
            events: [initialEvent],
          }),
        ])
      );

      // 2. Run the reaper with a 1-hour threshold. The session's lastActivityAt
      //    is TWO_DAYS_AGO, which is older than the cutoff, so it gets reaped.
      const sweepResult = await withStaleSessionThresholdHours("1", () =>
        staleSessionReaperService.runStaleSessionSweep()
      );
      expect(sweepResult.reaped).toBeGreaterThanOrEqual(1);

      const afterReap = await findSessionRow(computeTarget.id, extId);
      expect(afterReap?.artifact.status).toBe(SESSION_STATUS.INACTIVE);
      expect(afterReap?.sessionEndedAt).not.toBeNull();

      // 3. Resync with a new event whose timestamp is strictly after sessionEndedAt.
      //    The reopen predicate fires iff maxEventCreatedAt > persistedSessionEndedAt.
      const newerEvent = makeEvent("evt-newer", TEST_NOW);
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSession(extId, {
            status: SESSION_STATUS.ACTIVE,
            // Include the original event plus the new one so the payload is
            // additive. The aggregate max across both yields TEST_NOW.
            events: [initialEvent, newerEvent],
          }),
        ])
      );

      const afterReopen = await findSessionRow(computeTarget.id, extId);
      expect(afterReopen?.artifact.status).toBe(SESSION_STATUS.ACTIVE);
      expect(afterReopen?.sessionEndedAt).toBeNull();
    });
  });

  it("leaves an inactive session inactive when the resync carries no new events", async () => {
    const extId = `reopen-stale-${randomUUID()}`;

    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const ctx = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };

      // 1. Initial sync: active session with one old event.
      const staleEvent = makeEvent("evt-stale", TWO_DAYS_AGO);
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSession(extId, {
            status: SESSION_STATUS.ACTIVE,
            events: [staleEvent],
          }),
        ])
      );

      // 2. Reap the session.
      await withStaleSessionThresholdHours("1", () =>
        staleSessionReaperService.runStaleSessionSweep()
      );

      const afterReap = await findSessionRow(computeTarget.id, extId);
      expect(afterReap?.artifact.status).toBe(SESSION_STATUS.INACTIVE);
      expect(afterReap?.sessionEndedAt).not.toBeNull();
      // Capture reaper's exact value to assert it is unchanged after the stale retry.
      const reaperEndedAt = afterReap!.sessionEndedAt!;

      // 3. Stale retry: status=waiting, awaitingInputSince set, but NO new events.
      //    maxEventCreatedAt (TWO_DAYS_AGO) is not strictly greater than
      //    sessionEndedAt (also TWO_DAYS_AGO), so the reopen predicate is false.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSession(extId, {
            status: DISPLAYED_SESSION_STATUS.WAITING,
            awaitingInputSince: TEST_NOW.toISOString(),
            events: [],
          }),
        ])
      );

      const afterStaleRetry = await findSessionRow(computeTarget.id, extId);
      expect(afterStaleRetry?.artifact.status).toBe(SESSION_STATUS.INACTIVE);
      // awaitingInputSince must remain null: the guarded status is terminal so
      // the upsert forces null, and the reopen path did not fire.
      expect(afterStaleRetry?.awaitingInputSince).toBeNull();
      // sessionEndedAt must be unchanged from the reaper's write.
      expect(afterStaleRetry?.sessionEndedAt?.getTime()).toBe(
        reaperEndedAt.getTime()
      );
    });
  });
});

/**
 * ISS-4439: the collapsed persistSessionChildren derives last_activity_at from
 * MAX("event_created_at") and lands it via a single monotonic
 * `GREATEST("last_activity_at", $4::timestamp, $5::timestamp)` UPDATE. This is
 * the real-Postgres proof that the GREATEST truly runs against the column's own
 * stored value (the unit test mocks the raw calls and cannot exercise the DB
 * function): a later event's timestamp survives a subsequent replacement sync
 * that re-inserts a strictly OLDER event set, so last_activity_at never moves
 * backward. Self-skips locally when DATABASE_URL is unset; CI runs it.
 */
describeIfDb("agent-session last_activity_at monotonicity (ISS-4439)", () => {
  // startAt < olderAt < laterAt: all distinct so no two can be confused, and
  // startAt precedes both events so last_activity_at tracks the event-max, not
  // the session-start floor.
  const startAt = new Date("2026-05-01T00:00:00.000Z");
  const olderAt = new Date("2026-05-10T00:00:00.000Z");
  const laterAt = new Date("2026-05-20T17:00:00.000Z");

  it("keeps last_activity_at at the later event's time when a replacement sync re-inserts an older event set", async () => {
    const extId = `iss4439-monotonic-${randomUUID()}`;

    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const ctx = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };

      // 1. Initial sync (revision 1): one event at the LATER timestamp. The
      //    collapsed UPDATE's GREATEST(existing=null, start, maxEvent=laterAt)
      //    advances last_activity_at to laterAt.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSession(extId, {
            status: SESSION_STATUS.ACTIVE,
            startedAt: startAt.toISOString(),
            updatedAt: laterAt.toISOString(),
            dataRevision: 1,
            events: [makeEvent("evt-later", laterAt)],
          }),
        ])
      );

      const afterFirst = await findSessionRow(computeTarget.id, extId);
      expect(afterFirst?.lastActivityAt?.getTime()).toBe(laterAt.getTime());

      // 2. Replacement sync (revision 2 → shouldReplace: the events are deleted
      //    and re-inserted). The replacement carries a strictly OLDER event set,
      //    so MAX("event_created_at") is now olderAt. The monotonic
      //    GREATEST(existing=laterAt, start, maxEvent=olderAt) must keep
      //    last_activity_at at laterAt — the older replacement can never move it
      //    backward.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSession(extId, {
            status: SESSION_STATUS.ACTIVE,
            startedAt: startAt.toISOString(),
            updatedAt: laterAt.toISOString(),
            dataRevision: 2,
            events: [makeEvent("evt-older", olderAt)],
          }),
        ])
      );

      const afterReplacement = await findSessionRow(computeTarget.id, extId);
      // Unchanged: still the later event's time, NOT regressed to olderAt.
      expect(afterReplacement?.lastActivityAt?.getTime()).toBe(
        laterAt.getTime()
      );
    });
  });
});
