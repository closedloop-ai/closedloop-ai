/**
 * @file invocation-sync-unreported-abandonment.test.ts
 * @description ISS-5855 (codex review) — the report window may only age out a loss
 * the monitor has already been told about.
 *
 * `INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS` is measured from the instant a
 * row was PARKED, and it is deliberate: nothing in this lane guarantees a
 * dead-lettered row is ever removed, so counting one forever pins the store unhealthy
 * for the life of the install. But "24h after it happened" is not "24h after anyone
 * saw it". Desktop can dead-letter a part, exit before the probe's five-minute first
 * run, and be closed or asleep past the window; the first probe after restart then
 * discards the row on age alone. The main-process line from the earlier launch is a
 * raw log, not an alert — which is the exact silent loss this ticket exists to close,
 * reintroduced by its own recovery edge.
 *
 * The durable observation marker is what separates the two readings. These cases pin
 * both directions, because either one alone is satisfiable by a mutation that breaks
 * the other: report the unseen row, AND still age out the one that was reported.
 *
 * The clock is INJECTED (`nowMs`) throughout. No timers are faked and nothing sleeps
 * — a shutdown is expressed as the gap between two probe instants, which is what it
 * actually is.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { describe, test } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AgentComponentInvocationSyncLocalError,
  buildAgentComponentInvocationSyncSourceKey,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { SESSION_MISSING_MAX_RETRY_AGE_MS } from "../src/main/agent-sync/invocation-sync-rejection-policy.js";
import {
  INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS,
  runInvocationSyncOutboxIntegrityCheck,
} from "../src/main/database/invocation-sync-outbox-integrity.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  collectInvocationSyncOutboxIssues as collectIssues,
  type Db,
  deliveryRows,
  makeInvocationSyncDir,
  NOW,
  openDb,
  SKILL_CONTENT_V1,
  sessionMissingService,
  skillSession,
} from "./helpers/invocation-sync-fixtures.js";

/** The monitored issue category a permanently-lost part must reach. */
const ABANDONED_CATEGORY = "abandoned_invocation_sync_outbox_part";

/** Long enough past the window that no margin in the constant can absorb it. */
const LONG_SHUTDOWN_MS = 3 * INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS;

describe("ISS-5855 an abandonment reaches the monitor before it may age out", () => {
  /**
   * The interleaving codex named, end to end through the real lane: the part is
   * abandoned, NO probe runs, the machine is away for longer than the window, and
   * the first probe after restart is the first that could ever have seen the row.
   *
   * Counterfactual: delete the `isUnreportedParkedRow` guard from
   * `classifyScannedOutboxRow` and this case fails with zero abandoned rows and no
   * issue — the permanent loss is discarded silently, which is the state the branch
   * was in before this change. Every other case in the ISS-5855 suites still passes
   * under that mutation, because every one of them probes inside the window.
   */
  test("a part abandoned while no probe ran is still reported after the window", async () => {
    const dir = await makeInvocationSyncDir("aci-unreported-");
    const db = await openDb(dir);
    const sessionId = "session-unreported";
    const computeTargetId = "target-unreported";
    const target = buildAgentComponentInvocationSyncSourceKey(computeTargetId);
    try {
      const parkedAtMs = await abandonOnePart(db, sessionId, computeTargetId);

      // The first probe this store has ever completed, long after the shutdown.
      const firstProbe = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        parkedAtMs + LONG_SHUTDOWN_MS
      );

      assert.equal(
        firstProbe.recentlyAbandonedPartRows,
        1,
        "a loss no probe has ever seen must not expire before it is reported"
      );
      assert.deepEqual(
        collectIssues(firstProbe).map((issue) => issue.category),
        [ABANDONED_CATEGORY],
        "the monitored event is the only thing a human ever notices"
      );

      // The bound is still a bound. The next probe finds the row observed and past
      // its window, so the store recovers instead of alerting forever.
      const secondProbe = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        parkedAtMs + LONG_SHUTDOWN_MS + 1
      );
      assert.equal(
        secondProbe.recentlyAbandonedPartRows,
        0,
        "once reported, a parked row must age out — nothing ever deletes it"
      );
      assert.deepEqual(collectIssues(secondProbe), []);

      // The row is untouched: the marker is what changed, not the evidence.
      const parked = await deliveryRows(db, target, sessionId);
      assert.equal(parked[0]?.status, OutboxStatus.DeadLettered);
      assert.equal(
        parked[0]?.last_error,
        AgentComponentInvocationSyncLocalError.SessionMissingHorizonExhausted
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The marker has to survive the process, not just the call. This reopens the store
   * between the two probes, which is the only version of the case that distinguishes
   * durable state from a value the first call happened to leave in memory.
   *
   * Counterfactual: make the observation marker a module-level variable instead of a
   * cursor row and this case fails — the reopened store reports the row a second
   * time, forever, on every probe of every launch.
   */
  test("the observation survives a restart, so a reported row stays reported", async () => {
    const dir = await makeInvocationSyncDir("aci-unreported-restart-");
    const sessionId = "session-unreported-restart";
    const computeTargetId = "target-unreported-restart";
    const first = await openDb(dir);
    let parkedAtMs = 0;
    try {
      parkedAtMs = await abandonOnePart(first, sessionId, computeTargetId);
      const reported = await runInvocationSyncOutboxIntegrityCheck(
        first.prisma,
        parkedAtMs + LONG_SHUTDOWN_MS
      );
      assert.equal(reported.recentlyAbandonedPartRows, 1);
    } finally {
      await first.close();
    }

    const second = await openDb(dir);
    try {
      const afterRestart = await runInvocationSyncOutboxIntegrityCheck(
        second.prisma,
        parkedAtMs + LONG_SHUTDOWN_MS + 1
      );
      assert.equal(
        afterRestart.recentlyAbandonedPartRows,
        0,
        "the marker is durable state, not a per-process memo"
      );
      assert.deepEqual(collectIssues(afterRestart), []);
    } finally {
      await second.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The reported-then-aged-out path on its own schedule, without a shutdown: the row
   * is seen inside its window, keeps raising the issue while the window holds, and
   * stops at the boundary. Without this the case above could be satisfied by a scan
   * that simply ignores the window.
   */
  test("a reported row keeps raising the issue only until its window closes", async () => {
    const dir = await makeInvocationSyncDir("aci-unreported-window-");
    const db = await openDb(dir);
    const sessionId = "session-unreported-window";
    const computeTargetId = "target-unreported-window";
    try {
      const parkedAtMs = await abandonOnePart(db, sessionId, computeTargetId);

      const seen = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        parkedAtMs + 1
      );
      assert.equal(seen.recentlyAbandonedPartRows, 1);

      const stillInside = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        parkedAtMs + INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS - 1
      );
      assert.equal(
        stillInside.recentlyAbandonedPartRows,
        1,
        "the issue is raised for the whole window, not only on first sight"
      );

      const atBoundary = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        parkedAtMs + INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS
      );
      assert.equal(
        atBoundary.recentlyAbandonedPartRows,
        0,
        "the recovery edge must still close on schedule"
      );
      assert.deepEqual(collectIssues(atBoundary), []);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The negative that stops "report anything never observed" from degenerating into
   * "report something". A store with a healthy queue has nothing parked, so the first
   * probe on it — the run that would sweep an unbounded fetch — must stay silent and
   * still record its observation.
   */
  test("a healthy store reports nothing on the first probe it ever runs", async () => {
    const dir = await makeInvocationSyncDir("aci-unreported-healthy-");
    const db = await openDb(dir);
    const sessionId = "session-unreported-healthy";
    const target = buildAgentComponentInvocationSyncSourceKey("target-healthy");
    try {
      await seedDeliveryRow(db, sessionId, target);

      const firstProbe = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        Date.parse(NOW) + LONG_SHUTDOWN_MS
      );
      assert.equal(firstProbe.recentlyAbandonedPartRows, 0);
      assert.equal(firstProbe.recentlyQuarantinedCorruptRows, 0);
      assert.equal(firstProbe.unreadableCreatedAtRows, 0);
      assert.deepEqual(
        collectIssues(firstProbe),
        [],
        "an unswept store is not an unhealthy one"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * ISS-6209's parked population rides the same window, so it inherits the same hole
   * and the same fix. Asserted here because a guard applied to only one of the two
   * findings would leave the corruption alert silently expiring across a shutdown
   * while the abandonment alert survived.
   */
  test("a quarantined corrupt row no probe saw is reported on the same terms", async () => {
    const dir = await makeInvocationSyncDir("aci-unreported-corrupt-");
    const db = await openDb(dir);
    const target = buildAgentComponentInvocationSyncSourceKey("target-corrupt");
    const parkedAt = NOW;
    try {
      await db.prisma.write((client) =>
        client.agentComponentInvocationSyncOutbox.create({
          data: {
            sourceKey: target,
            externalSessionId: "session-unreported-corrupt",
            externalGenerationId: "g".repeat(64),
            partIndex: 0,
            partCount: 1,
            partHash: "h".repeat(64),
            sourceUpdatedAt: NOW,
            dataRevision: 1,
            sourceSequence: 0,
            payload: "{}",
            status: OutboxStatus.DeadLettered,
            lastError: AgentComponentInvocationSyncLocalError.CorruptCreatedAt,
            createdAt: "not-a-timestamp",
            updatedAt: parkedAt,
          },
        })
      );

      const parkedAtMs = Date.parse(parkedAt);
      const firstProbe = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        parkedAtMs + LONG_SHUTDOWN_MS
      );
      assert.equal(
        firstProbe.recentlyQuarantinedCorruptRows,
        1,
        "corruption quarantined across a shutdown must reach the monitor too"
      );

      const secondProbe = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        parkedAtMs + LONG_SHUTDOWN_MS + 1
      );
      assert.equal(
        secondProbe.recentlyQuarantinedCorruptRows,
        0,
        "and must then age out, exactly as ISS-6209 established"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Drive the real lane until it abandons one part, and answer with the instant it
 * stamped on the row.
 *
 * The parking instant is read back rather than assumed: the service clock is
 * injected but `deadLetterInvocationSyncPart` stamps `updated_at` from the real wall
 * clock, so an assumed instant would make every window assertion here compare against
 * a time the row does not carry.
 */
async function abandonOnePart(
  db: Db,
  sessionId: string,
  computeTargetId: string
): Promise<number> {
  const target = buildAgentComponentInvocationSyncSourceKey(computeTargetId);
  await seedDeliveryRow(db, sessionId, target);
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `UPDATE agent_component_invocation_sync_outbox
          SET created_at = $1
        WHERE source_key = $2 AND external_session_id = $3`,
      new Date(
        Date.parse(NOW) - SESSION_MISSING_MAX_RETRY_AGE_MS
      ).toISOString(),
      target,
      sessionId
    )
  );
  await sessionMissingService(db, computeTargetId).syncOnce();

  const parked = await deliveryRows(db, target, sessionId);
  const parkedAtMs = Date.parse(parked[0]?.updated_at ?? "");
  if (
    parked[0]?.status !== OutboxStatus.DeadLettered ||
    !Number.isFinite(parkedAtMs)
  ) {
    throw new Error("the fixture must park exactly one abandoned part");
  }
  return parkedAtMs;
}

/** Import one skill session and promote its generation onto the delivery queue. */
async function seedDeliveryRow(
  db: Db,
  sessionId: string,
  targetSourceKey: string
): Promise<void> {
  await db.importer.importSession(
    skillSession(sessionId, [SKILL_CONTENT_V1]),
    "claude"
  );
  const prepare = db.syncSource.prepareInvocationSyncTarget;
  if (!prepare) {
    throw new Error("the on-disk sync source cannot promote delivery rows");
  }
  await prepare(
    targetSourceKey,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    10
  );
  const seeded = await deliveryRows(db, targetSourceKey, sessionId);
  if (seeded.length !== 1 || seeded[0]?.status !== OutboxStatus.Pending) {
    throw new Error("the fixture must promote exactly one pending part");
  }
}
