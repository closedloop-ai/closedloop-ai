/**
 * @file invocation-sync-legacy-abandonment-marker.test.ts
 * @description ISS-5855 (codex review) — the abandonment marker this ticket
 * introduced is a RENAME of a durable value, so the population that matters most
 * is the one written before the rename.
 *
 * Every Desktop build before this one parked an outlived part with the cloud's ack
 * reason as its `last_error`. An installation that upgrades therefore carries dead
 * letters marked `session_missing` that are the same permanent loss under the
 * previous name, and this lane neither recovers nor deletes them — so an allow-list
 * that recognised only the new marker would omit exactly the installs that already
 * suffered the loss, forever. AGENTS.md ("Cross-Repo Compatibility Requirements")
 * requires the previous value stay ACCEPTED.
 *
 * The negative cases are the load-bearing half. `session_missing` is also carried by
 * every row still healthily deferring inside its horizon, so an alias keyed on that
 * value could just as easily turn the ordinary ordering race into a monitored
 * data-loss alert. What keeps it honest is that the alias is reachable only from the
 * `dead_lettered` branch of the scan.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { AgentComponentInvocationSyncRejectReason } from "@repo/api/src/types/agent-component-invocation";
import { describe, test } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_OUTBOX_TABLE,
  AgentComponentInvocationSyncLocalError,
  buildAgentComponentInvocationSyncSourceKey,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { runInvocationSyncOutboxIntegrityCheck } from "../src/main/database/invocation-sync-outbox-integrity.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  collectInvocationSyncOutboxIssues as collectIssues,
  type Db,
  makeInvocationSyncDir,
  NOW,
  openDb,
} from "./helpers/invocation-sync-fixtures.js";

/** The monitored issue category a permanently-lost part must reach. */
const ABANDONED_CATEGORY = "abandoned_invocation_sync_outbox_part";

describe("ISS-5855 a legacy abandonment marker is still reported", () => {
  /**
   * The upgrade case. The row is seeded directly rather than driven through the
   * lane because the lane on THIS branch can no longer produce it — that is the
   * point: only an earlier build wrote this value, and the rows it wrote outlive
   * the build that wrote them.
   *
   * Counterfactual: drop the `session_missing` entry from
   * `DEAD_LETTER_CAUSE_FINDINGS` and this case fails with zero abandoned rows and
   * no issue, which is the state every upgraded install would have shipped in.
   */
  test("a part parked by an earlier build raises the abandoned-part issue", async () => {
    const dir = await makeInvocationSyncDir("aci-legacy-marker-");
    const db = await openDb(dir);
    const target = buildAgentComponentInvocationSyncSourceKey("target-legacy");
    try {
      await seedParkedRow(db, {
        target,
        sessionId: "session-legacy-abandoned",
        status: OutboxStatus.DeadLettered,
        lastError: AgentComponentInvocationSyncRejectReason.SessionMissing,
      });

      const probe = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        Date.parse(NOW)
      );

      assert.equal(
        probe.recentlyAbandonedPartRows,
        1,
        "a dead letter written under the previous marker is the same loss"
      );
      assert.equal(
        probe.recentlyQuarantinedCorruptRows,
        0,
        "nothing about this row says the local store is corrupt"
      );
      assert.deepEqual(
        collectIssues(probe).map((issue) => issue.category),
        [ABANDONED_CATEGORY]
      );
      assert.equal(
        collectIssues(probe)[0]?.object,
        AGENT_COMPONENT_INVOCATION_SYNC_OUTBOX_TABLE
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The alias's whole risk, in one case. `session_missing` is what the cloud says
   * on EVERY attempt while a parent is merely late, so a row still deferring
   * inside its horizon carries the identical `last_error`. Accepting the value
   * unconditionally would fire the monitored data-loss event on the ordinary,
   * self-healing ordering race — the exact reflex ISS-5855's marker exists to
   * avoid training.
   *
   * Counterfactual: move the alias lookup ahead of the status branch in
   * `classifyScannedOutboxRow` and this case reports a loss that has not happened.
   */
  test("a part still deferring under the same ack reason raises nothing", async () => {
    const dir = await makeInvocationSyncDir("aci-legacy-deferring-");
    const db = await openDb(dir);
    const target =
      buildAgentComponentInvocationSyncSourceKey("target-deferring");
    try {
      await seedParkedRow(db, {
        target,
        sessionId: "session-legacy-deferring",
        status: OutboxStatus.Pending,
        lastError: AgentComponentInvocationSyncRejectReason.SessionMissing,
      });

      const probe = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        Date.parse(NOW)
      );

      assert.equal(
        probe.recentlyAbandonedPartRows,
        0,
        "a queued row is still being retried — it is not a loss"
      );
      assert.equal(
        probe.unreadableCreatedAtRows,
        0,
        "its created_at is readable, so it is not ISS-6209's population either"
      );
      assert.deepEqual(collectIssues(probe), []);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The other way an alias widens too far: the allow-list must stay an allow-list.
   * `validation_failed` is a dead letter the cloud attributed to this row's own
   * content, which is attributable and terminal by design; reporting it would fire
   * the monitored event on ordinary rejection traffic.
   */
  test("a content-rejected dead letter is still outside the reported set", async () => {
    const dir = await makeInvocationSyncDir("aci-legacy-content-");
    const db = await openDb(dir);
    const target = buildAgentComponentInvocationSyncSourceKey("target-content");
    try {
      await seedParkedRow(db, {
        target,
        sessionId: "session-content-rejected",
        status: OutboxStatus.DeadLettered,
        lastError: AgentComponentInvocationSyncRejectReason.ValidationFailed,
      });

      const probe = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        Date.parse(NOW)
      );

      assert.equal(probe.recentlyAbandonedPartRows, 0);
      assert.equal(probe.recentlyQuarantinedCorruptRows, 0);
      assert.deepEqual(collectIssues(probe), []);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Both names describe one finding, so an install mid-upgrade — holding rows from
   * the previous build alongside rows this one parked — must count them together
   * rather than let either name shadow the other.
   */
  test("legacy and current markers are counted as one population", async () => {
    const dir = await makeInvocationSyncDir("aci-legacy-mixed-");
    const db = await openDb(dir);
    const target = buildAgentComponentInvocationSyncSourceKey("target-mixed");
    try {
      await seedParkedRow(db, {
        target,
        sessionId: "session-mixed-legacy",
        status: OutboxStatus.DeadLettered,
        lastError: AgentComponentInvocationSyncRejectReason.SessionMissing,
      });
      await seedParkedRow(db, {
        target,
        sessionId: "session-mixed-current",
        status: OutboxStatus.DeadLettered,
        lastError:
          AgentComponentInvocationSyncLocalError.SessionMissingHorizonExhausted,
      });

      const probe = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        Date.parse(NOW)
      );

      assert.equal(
        probe.recentlyAbandonedPartRows,
        2,
        "a rename does not make two findings out of one"
      );
      assert.deepEqual(
        collectIssues(probe).map((issue) => issue.category),
        [ABANDONED_CATEGORY],
        "one category, however the rows are marked"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * One delivery row in a chosen terminal state, written directly.
 *
 * `created_at` is READABLE on purpose: a parked row's finding is the lane's own
 * conclusion recorded in `last_error`, and the scan must be reading that marker
 * rather than re-deriving corruption from the timestamp.
 */
function seedParkedRow(
  db: Db,
  row: {
    target: string;
    sessionId: string;
    status: string;
    lastError: string;
  }
): Promise<unknown> {
  return db.prisma.write((client) =>
    client.agentComponentInvocationSyncOutbox.create({
      data: {
        sourceKey: row.target,
        externalSessionId: row.sessionId,
        externalGenerationId: "g".repeat(64),
        partIndex: 0,
        partCount: 1,
        partHash: "h".repeat(64),
        sourceUpdatedAt: NOW,
        dataRevision: 1,
        sourceSequence: 0,
        payload: "{}",
        status: row.status,
        lastError: row.lastError,
        createdAt: NOW,
        updatedAt: NOW,
      },
    })
  );
}
