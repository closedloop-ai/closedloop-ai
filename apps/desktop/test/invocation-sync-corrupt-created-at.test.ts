/**
 * @file invocation-sync-corrupt-created-at.test.ts
 * @description ISS-6209 — an invocation-delivery row whose persisted `created_at`
 * cannot be read.
 *
 * Its own suite rather than more blocks in the rejection-budget file, because the
 * defect is not a mis-priced budget: it is a CLASSIFICATION collapse whose damage
 * lands two modules away, in promotion. ISS-5789 folded "unreadable timestamp" into
 * "the horizon still holds", which reads as a careful refusal to guess an age and
 * behaves as a permanent wedge —
 *
 *   unreadable `created_at` → `session_missing` stays transient forever
 *     → the row stays `pending` on the delivery queue forever
 *     → `loadBlockedInvocationDeliverySessionIds` reports that session blocked
 *     → every LATER generation of that session is skipped by promotion, forever.
 *
 * The last step is the one a classification-only test cannot see, so this file holds
 * the three-phase promotion proof against a real store: BLOCKED while the corrupt row
 * is pending, QUARANTINED by the lane, then PROMOTED.
 *
 * Every case here is a BEHAVIOUR against a real store. A case asserting that
 * `classifySessionMissingRetryHorizon` returns the new member was written and then
 * DELETED: it asserts the code built the right value, not that the queue unblocked,
 * and the three-phase test below already fails when that classification collapses
 * (proven by counterfactual). Coverage is not the deliverable here; a caught
 * regression is.
 *
 * The second block owns the OTHER half — that the corruption reaches the monitored
 * `store.integrity.*` event at all. Its race case exists because quarantine and the
 * integrity probe run on schedules three orders of magnitude apart (a 5s sync loop
 * against a 5-minute-then-30-minute probe), so a scan scoped to `pending` rows was
 * reliably too late to ever see one.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { describe, test } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AgentComponentInvocationSyncLocalError,
  buildAgentComponentInvocationSyncSourceKey,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { SESSION_MISSING_INVALID_TIMESTAMP_MAX_ATTEMPTS } from "../src/main/agent-sync/invocation-sync-rejection-policy.js";
import {
  STORE_INTEGRITY_INITIAL_DELAY_MS_DEFAULT,
  STORE_INTEGRITY_INTERVAL_MS_DEFAULT,
} from "../src/main/database/database-integrity/store-integrity-probe.js";
import {
  INVOCATION_SYNC_OUTBOX_INTEGRITY_PAGE_SIZE,
  INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS,
  runInvocationSyncOutboxIntegrityCheck,
} from "../src/main/database/invocation-sync-outbox-integrity.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  collectInvocationSyncOutboxIssues as collectIssues,
  deliveryRows,
  makeInvocationSyncDir,
  NOW,
  openDb,
  SKILL_CONTENT_V1,
  SKILL_CONTENT_V2,
  sessionMissingService,
  skillSession,
} from "./helpers/invocation-sync-fixtures.js";

/**
 * A `created_at` value `Date.parse` cannot read. The column is `NOT NULL` TEXT, so
 * this is reachable from a partial write or a hand-restored store — it is not a
 * type-impossible input, which is why it is tested.
 */
const CORRUPT_CREATED_AT = "not-a-timestamp";

describe("ISS-6209 a corrupt delivery row is quarantined and stops wedging promotion", () => {
  /**
   * AC-3 and AC-4 together, against a real store and through the production
   * service — the assertion the ticket was actually filed for.
   *
   * Phase D is what makes phase F mean something. Without it, "the newer generation
   * promoted" is satisfiable by a promotion that would have succeeded anyway; with
   * it, the same session is proven UNPROMOTABLE one step earlier, under the same
   * fixture, so the only thing that changed between D and F is the quarantine.
   */
  test("blocked while pending, quarantined by the lane, then the newer generation promotes", async () => {
    const dir = await makeInvocationSyncDir("aci-corrupt-");
    const db = await openDb(dir);
    const sessionId = "session-corrupt-created-at";
    const computeTargetId = "target-corrupt";
    const target = buildAgentComponentInvocationSyncSourceKey(computeTargetId);
    try {
      // Phase A — one generation, promoted onto the delivery queue.
      await db.importer.importSession(
        skillSession(sessionId, [SKILL_CONTENT_V1]),
        "claude"
      );
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);

      const seeded = await deliveryRows(db, target, sessionId);
      assert.equal(seeded.length, 1, "the first generation must be promoted");
      assert.equal(seeded[0]?.status, OutboxStatus.Pending);
      const firstGenerationId = seeded[0]?.external_generation_id;
      assert.ok(firstGenerationId);

      // Phase B — the corruption this ticket is about, injected on the persisted
      // row rather than mocked at the reader, so the whole production read path
      // (row → `loadReadyInvocationSyncParts` → `rejectionBudgetForRow`) sees it.
      // `permanent_attempt_count` is set to one short of the quarantine budget in
      // the same write: an unreadable timestamp is bounded but NOT immediate (a
      // fresh row still gets real retries — see the rejection-budget suite), so a
      // row only reaches the terminal branch once that budget is spent. Derived
      // from the production constant so retuning the budget cannot leave this test
      // asserting a threshold the lane no longer uses.
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `UPDATE agent_component_invocation_sync_outbox
              SET created_at = $1, permanent_attempt_count = $2
            WHERE source_key = $3 AND external_session_id = $4`,
          CORRUPT_CREATED_AT,
          SESSION_MISSING_INVALID_TIMESTAMP_MAX_ATTEMPTS - 1,
          target,
          sessionId
        )
      );

      // Phase C — a NEWER generation of the same session becomes available.
      await db.importer.importSession(
        skillSession(sessionId, [SKILL_CONTENT_V1, SKILL_CONTENT_V2]),
        "claude"
      );

      // Phase D — the wedge. Promotion runs and cannot touch this session,
      // because its own corrupt row is still `pending`.
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      const blocked = await deliveryRows(db, target, sessionId);
      assert.deepEqual(
        blocked.map((row) => row.external_generation_id),
        [firstGenerationId],
        "while the corrupt row is pending, the newer generation must NOT be promoted"
      );

      // Phase E — the lane drains, the cloud answers `session_missing`, and the
      // row is quarantined rather than deferred for a horizon it cannot evaluate.
      await sessionMissingService(db, computeTargetId).syncOnce();

      const quarantined = await deliveryRows(db, target, sessionId);
      assert.equal(quarantined.length, 1);
      assert.equal(
        quarantined[0]?.status,
        OutboxStatus.DeadLettered,
        "an unreadable created_at must terminalize the row, not defer it forever"
      );
      assert.equal(
        quarantined[0]?.last_error,
        AgentComponentInvocationSyncLocalError.CorruptCreatedAt,
        "the row must name the corruption, not the ack reason that exposed it"
      );
      // No fabricated age: the lane quarantines on the strength of "unreadable",
      // and never writes a timestamp it does not have.
      assert.equal(
        quarantined[0]?.created_at,
        CORRUPT_CREATED_AT,
        "the corrupt value must be left exactly as found, never repaired to a guess"
      );

      // Phase F — the point of the ticket. The same promotion call that did
      // nothing in phase D now supersedes the quarantined row.
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      const promoted = await deliveryRows(db, target, sessionId);
      assert.ok(
        promoted.length > 0,
        "the session must be promotable once its corrupt row is quarantined"
      );
      assert.ok(
        promoted.every((row) => row.status === OutboxStatus.Pending),
        "the promoted generation must be live delivery work"
      );
      assert.ok(
        promoted.every(
          (row) => row.external_generation_id !== firstGenerationId
        ),
        "promotion must have superseded the wedged generation, not re-cloned it"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ISS-6209 corrupt delivery rows reach the monitored store-integrity event", () => {
  // AC-2. The alert path, asserted through the real scan rather than the
  // classifier alone — a classifier that is never fed by a working read reports
  // nothing in production.
  test("the integrity scan counts a corrupt pending row and raises one content-free issue", async () => {
    const dir = await makeInvocationSyncDir("aci-corrupt-probe-");
    const db = await openDb(dir);
    const sessionId = "session-corrupt-probe";
    const target = buildAgentComponentInvocationSyncSourceKey("target-probe");
    try {
      await db.importer.importSession(
        skillSession(sessionId, [SKILL_CONTENT_V1]),
        "claude"
      );
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);

      // A healthy store reports nothing — so the positive case below cannot be
      // satisfied by a scan that flags every row it sees.
      const healthy = await runInvocationSyncOutboxIntegrityCheck(db.prisma);
      assert.equal(healthy.unreadableCreatedAtRows, 0);
      assert.deepEqual(collectIssues(healthy), []);

      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `UPDATE agent_component_invocation_sync_outbox
              SET created_at = $1
            WHERE source_key = $2 AND external_session_id = $3`,
          CORRUPT_CREATED_AT,
          target,
          sessionId
        )
      );

      const corrupt = await runInvocationSyncOutboxIntegrityCheck(db.prisma);
      assert.equal(corrupt.unreadableCreatedAtRows, 1);
      const issues = collectIssues(corrupt);
      assert.equal(issues.length, 1);
      assert.equal(issues[0]?.check, "invocation_sync_outbox");
      assert.equal(
        issues[0]?.category,
        "unreadable_invocation_sync_outbox_timestamp"
      );
      assert.equal(
        issues[0]?.object,
        "agent_component_invocation_sync_outbox",
        "`object` must be the table identifier the monitored event expects"
      );
      // Content-free by construction: no session id, generation id, or the
      // offending value may ride an event that reaches Datadog.
      const serialized = JSON.stringify(issues[0]);
      assert.ok(!serialized.includes(sessionId));
      assert.ok(!serialized.includes(CORRUPT_CREATED_AT));

      // Quarantine, exactly as the lane writes it: `dead_lettered`, the
      // `corrupt_created_at` marker, and a fresh readable `updated_at`.
      //
      // This assertion is DELIBERATELY REVERSED from what it used to be. It
      // previously required the signal to clear the moment the row was
      // quarantined, and that expectation was the defect: the sync loop ticks
      // every 5s while this probe's first run is 5 minutes out and later runs 30
      // minutes apart, so on any active lane the row leaves the `pending` set
      // before a probe ever looks. The old contract therefore promised a
      // monitored event that in practice never fired.
      const quarantinedAt = new Date(Date.parse(NOW)).toISOString();
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `UPDATE agent_component_invocation_sync_outbox
              SET status = $1, last_error = $2, updated_at = $3
            WHERE source_key = $4 AND external_session_id = $5`,
          OutboxStatus.DeadLettered,
          AgentComponentInvocationSyncLocalError.CorruptCreatedAt,
          quarantinedAt,
          target,
          sessionId
        )
      );
      const afterQuarantine = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        Date.parse(quarantinedAt)
      );
      assert.equal(
        afterQuarantine.unreadableCreatedAtRows,
        0,
        "the row has left the pending population"
      );
      assert.equal(
        afterQuarantine.recentlyQuarantinedCorruptRows,
        1,
        "the quarantined row must still be visible to the probe that reports it"
      );
      assert.deepEqual(
        collectIssues(afterQuarantine).map((issue) => issue.category),
        ["unreadable_invocation_sync_outbox_timestamp"],
        "quarantine must not silence the monitored event"
      );

      // The recovery edge the `pending` scope used to supply. Nothing ever
      // DELETES a dead-lettered row, so without this bound one corruption event
      // would pin the store unhealthy for the life of the install.
      const afterWindow = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        Date.parse(quarantinedAt) +
          INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS
      );
      assert.equal(
        afterWindow.recentlyQuarantinedCorruptRows,
        0,
        "past its report window the quarantined row must stop raising the issue"
      );
      assert.deepEqual(collectIssues(afterWindow), []);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The scan pages on a 4-part composite cursor. Every assertion above runs on a
  // single row, so the continuation logic is entirely unexercised by them: drop
  // `skip: 1` and the scan re-reads the same last row forever, or reorder the
  // cursor fields against `orderBy` and it silently skips or double-counts
  // everything past the first page. A cloud outage backlogging this outbox is
  // exactly when the second page first executes, so the untested path is the one
  // that runs during the incident this ticket came from.
  test("the scan pages past its cursor without losing or double-counting rows", async () => {
    const dir = await makeInvocationSyncDir("aci-corrupt-page-");
    const db = await openDb(dir);
    const target = buildAgentComponentInvocationSyncSourceKey("target-page");
    // One full page plus a remainder, so the cursor is followed at least twice.
    const corruptRows = INVOCATION_SYNC_OUTBOX_INTEGRITY_PAGE_SIZE + 7;
    try {
      await db.prisma.write((client) =>
        client.agentComponentInvocationSyncOutbox.createMany({
          data: Array.from({ length: corruptRows }, (_, index) => ({
            sourceKey: target,
            externalSessionId: `session-page-${`${index}`.padStart(4, "0")}`,
            externalGenerationId: "g".repeat(64),
            partIndex: 0,
            partCount: 1,
            partHash: "h".repeat(64),
            sourceUpdatedAt: NOW,
            dataRevision: 1,
            sourceSequence: 0,
            payload: "{}",
            status: OutboxStatus.Pending,
            createdAt: CORRUPT_CREATED_AT,
            updatedAt: NOW,
          })),
        })
      );

      const scanned = await runInvocationSyncOutboxIntegrityCheck(db.prisma);
      assert.equal(
        scanned.unreadableCreatedAtRows,
        corruptRows,
        "every corrupt row across every page must be counted exactly once"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The interleaving the probe actually meets in production, driven end to end by
   * the real service: the lane quarantines the corrupt row BEFORE any probe has
   * run. Every other case in this file hands the probe a row someone else parked;
   * this one lets the lane park it, which is the only version that proves the two
   * schedules no longer race.
   *
   * Counterfactual: restore `where: { status: pending }` in
   * `scanInvocationSyncOutboxRows` and this test fails with zero issues — the
   * monitored event the ticket promises is never emitted and the corruption
   * survives only as a main-process log line. Every other assertion in this file
   * still passes under that mutation.
   */
  test("a row quarantined before the first probe still reaches the monitored event", async () => {
    const dir = await makeInvocationSyncDir("aci-corrupt-race-");
    const db = await openDb(dir);
    const sessionId = "session-corrupt-race";
    const computeTargetId = "target-race";
    const target = buildAgentComponentInvocationSyncSourceKey(computeTargetId);
    try {
      await db.importer.importSession(
        skillSession(sessionId, [SKILL_CONTENT_V1]),
        "claude"
      );
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `UPDATE agent_component_invocation_sync_outbox
              SET created_at = $1, permanent_attempt_count = $2
            WHERE source_key = $3 AND external_session_id = $4`,
          CORRUPT_CREATED_AT,
          SESSION_MISSING_INVALID_TIMESTAMP_MAX_ATTEMPTS - 1,
          target,
          sessionId
        )
      );

      // The 5s sync loop wins the race against the 5-minute first probe: the lane
      // drains, quarantines, and the row is `dead_lettered` with no probe having
      // observed it as `pending`.
      await sessionMissingService(db, computeTargetId).syncOnce();
      const quarantined = await deliveryRows(db, target, sessionId);
      assert.equal(
        quarantined[0]?.status,
        OutboxStatus.DeadLettered,
        "the fixture must reproduce the race — the row is already quarantined"
      );
      const quarantinedAtMs = Date.parse(quarantined[0]?.updated_at ?? "");
      assert.ok(
        Number.isFinite(quarantinedAtMs),
        "the quarantine write must stamp a readable updated_at"
      );

      // The first probe finally runs. It must find the corruption anyway.
      const firstProbe = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        quarantinedAtMs
      );
      assert.equal(
        firstProbe.unreadableCreatedAtRows,
        0,
        "the row is already out of the pending population — that is the race"
      );
      assert.equal(
        firstProbe.recentlyQuarantinedCorruptRows,
        1,
        "the probe must still see the corruption the lane quarantined without it"
      );
      assert.deepEqual(
        collectIssues(firstProbe).map((issue) => issue.category),
        ["unreadable_invocation_sync_outbox_timestamp"],
        "exactly one monitored issue, from the probe that owns the emit cadence"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The window only closes the race while it outlasts the probe's own worst-case
   * first-observation latency. Retuning either probe constant without revisiting
   * the window would silently reopen the gap this ticket closed, so the
   * relationship is pinned rather than left to a comment.
   */
  test("the quarantine report window outlasts the probe's first-observation latency", () => {
    assert.ok(
      INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS >
        STORE_INTEGRITY_INITIAL_DELAY_MS_DEFAULT +
          STORE_INTEGRITY_INTERVAL_MS_DEFAULT,
      "a quarantine must survive at least until the probe's second scheduled run"
    );
  });
});
