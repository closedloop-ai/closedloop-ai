/**
 * @file invocation-sync-validation-redrive.test.ts
 * @description ISS-6909: the one-shot re-drive of delivery rows ISS-6883's
 * pre-fix ingest dead-lettered with `validation_failed`.
 *
 * The load-bearing case is NOT "the row was re-driven" — a naive re-admission
 * that flips the dead-lettered row back to `pending` in place passes that, and
 * recovers nothing. `session_missing` is budgeted by ROW AGE from `created_at`,
 * so a stranded row is by definition already past its horizon: re-pended in
 * place it is instantly `Outlived` and terminalizes on its first ack. The test
 * that decides this ticket therefore evaluates the horizon of the row the lane
 * will actually send, at the instant it is re-admitted.
 *
 * Real SQLite throughout, for the reason the sibling promotion suite gives: the
 * decision is unit-testable, the ROW is not — and every claim here is about what
 * a persisted row carries after a real promotion transaction.
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { AgentComponentInvocationSyncRejectReason } from "@repo/api/src/types/agent-component-invocation";
import { describe, test } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AgentComponentInvocationSyncLocalError,
  buildAgentComponentInvocationSyncSourceKey,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import {
  classifySessionMissingRetryHorizon,
  SESSION_MISSING_MAX_RETRY_AGE_MS,
  SessionMissingRetryHorizon,
} from "../src/main/agent-sync/invocation-sync-rejection-policy.js";
import {
  INVOCATION_SYNC_VALIDATION_REDRIVE_REVISION,
  INVOCATION_SYNC_VALIDATION_REDRIVE_SESSION_ID,
  REDRIVE_SESSION_PAGE,
  redriveValidationFailedInvocationParts,
} from "../src/main/database/invocation-sync-validation-redrive.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  type Db,
  makeInvocationSyncDir,
  NOW,
  openDb,
  SKILL_CONTENT_V1,
  skillSession,
} from "./helpers/invocation-sync-fixtures.js";

/** The attempt count ISS-6883's defect burned before the row was parked. */
const EXHAUSTED_ATTEMPTS = 5;

/** The tally line `prepareInvocationSyncTarget` emits for this pass (ISS-9626). */
const REDRIVE_TALLY = /invocation sync validation re-drive \(ISS-6909\)/;

type DeliveryRow = {
  external_generation_id: string;
  part_index: number;
  status: string;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
};

function readDeliveryRows(
  db: Db,
  sourceKey: string,
  sessionId: string
): Promise<DeliveryRow[]> {
  return db.prisma.client.$queryRawUnsafe<DeliveryRow[]>(
    `SELECT external_generation_id, part_index, status, attempt_count,
            last_error, created_at
       FROM agent_component_invocation_sync_outbox
      WHERE source_key = $1 AND external_session_id = $2
      ORDER BY part_index ASC`,
    sourceKey,
    sessionId
  );
}

function readAllCreatedAt(
  db: Db
): Promise<{ source_key: string; part_index: number; created_at: string }[]> {
  return db.prisma.client.$queryRawUnsafe(
    `SELECT source_key, part_index, created_at
       FROM agent_component_invocation_sync_outbox
      ORDER BY source_key ASC, external_session_id ASC, part_index ASC`
  );
}

/**
 * Park every delivery row of `sessionId` exactly as the lane parks one, then AGE
 * it past the `session_missing` horizon.
 *
 * The ageing is a SEED — it reproduces the stranded row this ticket exists for,
 * a row that has been sitting since long before the ingest was fixed. It is
 * written relative to the real clock so the row is genuinely beyond the horizon
 * at the moment the re-drive runs, whatever day the suite runs on.
 */
async function strandSession(
  db: Db,
  sourceKey: string,
  sessionId: string,
  cause: string
): Promise<string> {
  const load = db.syncSource.loadReadyInvocationSyncParts;
  const deadLetter = db.syncSource.deadLetterInvocationSyncPart;
  if (!(load && deadLetter)) {
    throw new Error("the sync source is missing its invocation outbox methods");
  }
  const ready = await load(sourceKey, NOW, 100);
  const parts = ready.filter(
    (entry) => entry.part.externalSessionId === sessionId
  );
  if (parts.length === 0) {
    throw new Error(`no ready parts for ${sessionId}`);
  }
  for (const entry of parts) {
    const parked = await deadLetter(sourceKey, entry.part, {
      attemptCount: EXHAUSTED_ATTEMPTS,
      permanentAttemptCount: EXHAUSTED_ATTEMPTS,
      error: cause,
    });
    if (!parked) {
      throw new Error(`could not park part ${entry.part.partIndex}`);
    }
  }
  const strandedCreatedAt = new Date(
    Date.now() - SESSION_MISSING_MAX_RETRY_AGE_MS - 60_000
  ).toISOString();
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `UPDATE agent_component_invocation_sync_outbox
        SET created_at = $3
      WHERE source_key = $1 AND external_session_id = $2`,
      sourceKey,
      sessionId,
      strandedCreatedAt
    )
  );
  return strandedCreatedAt;
}

/**
 * Give `sessionId`'s generation a sibling part parked for a DIFFERENT cause —
 * the realistic mixed shape, seeded by copying the row the fixture already
 * produced. A session carrying one of these is declined rather than re-driven.
 */
function addSiblingPartWithCause(
  db: Db,
  sourceKey: string,
  sessionId: string,
  cause: string
): Promise<unknown> {
  return db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_component_invocation_sync_outbox
           (source_key, external_session_id, external_generation_id, part_index,
            part_count, part_hash, source_updated_at, data_revision,
            source_sequence, payload, status, attempt_count, next_attempt_at,
            last_error, created_at, updated_at)
         SELECT source_key, external_session_id, external_generation_id,
                part_index + 1, part_count, part_hash, source_updated_at,
                data_revision, source_sequence, payload, status, attempt_count,
                next_attempt_at, $3, created_at, updated_at
           FROM agent_component_invocation_sync_outbox
          WHERE source_key = $1 AND external_session_id = $2`,
      sourceKey,
      sessionId,
      cause
    )
  );
}

/**
 * Clear the one-shot sentinel, modelling a store that upgraded INTO this build
 * with rows already stranded.
 *
 * The suite has to materialize its delivery rows through a real promotion, and
 * that same promotion is what runs the re-drive — so without this the pass would
 * always have fired on an empty store before the fixture could strand anything.
 * On a real install the ordering is the other way round: the stranded rows are
 * already on disk when the upgraded build first prepares.
 */
async function resetRedriveSentinel(db: Db): Promise<void> {
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `DELETE FROM agent_component_invocation_sync_cursors
      WHERE source_key = $1 AND external_session_id = $2`,
      AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
      INVOCATION_SYNC_VALIDATION_REDRIVE_SESSION_ID
    )
  );
}

describe("ISS-6909 validation_failed re-drive", () => {
  test("an empty page writes the completion sentinel and later runs no-op", async () => {
    const dir = await makeInvocationSyncDir("aci-redrive-empty-");
    const db = await openDb(dir);
    try {
      assert.deepEqual(
        await redriveValidationFailedInvocationParts(db.prisma),
        { redrivenSessions: 0, skippedMixedSessions: 0 }
      );
      const sentinel = await db.prisma.client.$queryRawUnsafe<
        { external_generation_id: string; source_sequence: unknown }[]
      >(
        `SELECT external_generation_id, source_sequence
           FROM agent_component_invocation_sync_cursors
          WHERE source_key = $1 AND external_session_id = $2`,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        INVOCATION_SYNC_VALIDATION_REDRIVE_SESSION_ID
      );
      assert.equal(sentinel.length, 1);
      assert.equal(sentinel[0]?.external_generation_id, "");
      assert.equal(
        Number(sentinel[0]?.source_sequence),
        INVOCATION_SYNC_VALIDATION_REDRIVE_REVISION
      );
      assert.equal(
        await redriveValidationFailedInvocationParts(db.prisma),
        null
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a malformed persisted source sequence re-arms the pass", async () => {
    const dir = await makeInvocationSyncDir("aci-redrive-sentinel-");
    const db = await openDb(dir);
    try {
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `INSERT INTO agent_component_invocation_sync_cursors
             (source_key, external_session_id, external_generation_id,
              source_sequence, updated_at)
           VALUES ($1, $2, $3, $4, $5)`,
          AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
          INVOCATION_SYNC_VALIDATION_REDRIVE_SESSION_ID,
          "stale-cursor",
          -1,
          NOW
        )
      );

      assert.deepEqual(
        await redriveValidationFailedInvocationParts(db.prisma),
        { redrivenSessions: 0, skippedMixedSessions: 0 }
      );
      const sentinel = await db.prisma.client.$queryRawUnsafe<
        { external_generation_id: string; source_sequence: unknown }[]
      >(
        `SELECT external_generation_id, source_sequence
           FROM agent_component_invocation_sync_cursors
          WHERE source_key = $1 AND external_session_id = $2`,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        INVOCATION_SYNC_VALIDATION_REDRIVE_SESSION_ID
      );
      assert.equal(sentinel[0]?.external_generation_id, "stale-cursor");
      assert.equal(
        Number(sentinel[0]?.source_sequence),
        INVOCATION_SYNC_VALIDATION_REDRIVE_REVISION
      );
      assert.equal(
        await redriveValidationFailedInvocationParts(db.prisma),
        null
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // THE case. A re-driven row that keeps the stranded row's `created_at` is
  // `Outlived` the moment it is re-admitted, so the very next ack terminalizes
  // it again and the whole pass recovers nothing. Both classifications are taken
  // at ONE instant — the moment of re-admission — so the assertion is about the
  // rows and not about how long the test took to run.
  test("the re-driven row is INSIDE the session_missing horizon at the instant it is re-admitted", async () => {
    const dir = await makeInvocationSyncDir("aci-redrive-clock-");
    const db = await openDb(dir);
    try {
      await db.importer.importSession(
        skillSession("session-redrive", [SKILL_CONTENT_V1]),
        "claude"
      );
      const target = buildAgentComponentInvocationSyncSourceKey("target-clock");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      const load = db.syncSource.loadReadyInvocationSyncParts;
      assert.ok(prepare && load);

      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      const strandedCreatedAt = await strandSession(
        db,
        target,
        "session-redrive",
        AgentComponentInvocationSyncRejectReason.ValidationFailed
      );
      assert.equal(
        (await load(target, new Date().toISOString(), 10)).length,
        0,
        "a dead-lettered row must not be drainable before the re-drive"
      );
      await resetRedriveSentinel(db);

      // The instant recovery begins, captured OUTSIDE the rows so neither
      // classification below can be derived from the row it is judging.
      const recoveryStartedAtMs = Date.now();
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);

      const rows = await readDeliveryRows(db, target, "session-redrive");
      assert.ok(rows.length > 0, "the session must still have delivery rows");
      for (const row of rows) {
        assert.equal(row.status, OutboxStatus.Pending);
        assert.equal(
          Number(row.attempt_count),
          0,
          "a re-materialized row starts its bounded budget from scratch"
        );
        assert.equal(row.last_error, null);
      }
      // Setup sanity, true under every implementation: the row this ticket is
      // about had already spent its whole horizon when recovery began.
      assert.equal(
        classifySessionMissingRetryHorizon(
          strandedCreatedAt,
          recoveryStartedAtMs
        ),
        SessionMissingRetryHorizon.Outlived
      );
      for (const row of rows) {
        // THE assertion. A re-admission that keeps the stranded `created_at`
        // reads `outlived` here and dead-letters again on its first ack.
        assert.equal(
          classifySessionMissingRetryHorizon(
            row.created_at,
            recoveryStartedAtMs
          ),
          SessionMissingRetryHorizon.Within,
          "the re-driven row must carry a horizon it can actually spend"
        );
        assert.notEqual(
          row.created_at,
          strandedCreatedAt,
          "the replacement is derived from the template, not the parked row"
        );
      }
      // And it is genuinely back on the wire, not merely re-shaped in the store.
      const ready = await load(target, new Date().toISOString(), 10);
      assert.deepEqual(
        ready.map((entry) => entry.part.externalSessionId),
        rows.map(() => "session-redrive")
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The pass is a SWEEP, and every other case here has exactly one candidate —
  // which is a count of 1 whether the fold walked its whole population or
  // stopped at the first entry it found. Two sessions across two delivery
  // queues (two compute targets sharing one store) is what makes "all of them"
  // separable from "the first one", and it exercises the per-source-key map the
  // apply step iterates.
  test("every qualifying session is re-driven, across delivery queues", async () => {
    const dir = await makeInvocationSyncDir("aci-redrive-many-");
    const db = await openDb(dir);
    try {
      for (const sessionId of ["session-many-a", "session-many-b"]) {
        await db.importer.importSession(
          skillSession(sessionId, [SKILL_CONTENT_V1]),
          "claude"
        );
      }
      const targetOne = buildAgentComponentInvocationSyncSourceKey("many-one");
      const targetTwo = buildAgentComponentInvocationSyncSourceKey("many-two");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);
      for (const target of [targetOne, targetTwo]) {
        await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      }
      const stranded: [string, string][] = [
        [targetOne, "session-many-a"],
        [targetOne, "session-many-b"],
        [targetTwo, "session-many-a"],
        [targetTwo, "session-many-b"],
      ];
      for (const [target, sessionId] of stranded) {
        await strandSession(
          db,
          target,
          sessionId,
          AgentComponentInvocationSyncRejectReason.ValidationFailed
        );
      }

      await resetRedriveSentinel(db);
      assert.deepEqual(
        await redriveValidationFailedInvocationParts(db.prisma),
        { redrivenSessions: stranded.length, skippedMixedSessions: 0 },
        "one pass owes every qualifying session, not just the first"
      );
      for (const target of [targetOne, targetTwo]) {
        await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      }

      // The count alone cannot tell a dropped candidate from a processed one,
      // so every identity is checked on its own row.
      for (const [target, sessionId] of stranded) {
        const rows = await readDeliveryRows(db, target, sessionId);
        assert.ok(rows.length > 0, `${target}/${sessionId} lost its rows`);
        for (const row of rows) {
          assert.equal(
            row.status,
            OutboxStatus.Pending,
            `${target}/${sessionId} was not re-driven`
          );
        }
      }
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The pass runs inside the lane's single write transaction, so it is paged:
  // ISS-6883 was a systemic ingest defect and the stranded population is not
  // guaranteed small. Paging is only worth having if the cursor actually
  // RESUMES — a cursor that failed to advance would hand back the same page
  // forever, and one that jumped would strand the tail silently.
  test("the pass pages over a population larger than one page, then completes", async () => {
    const dir = await makeInvocationSyncDir("aci-redrive-page-");
    const db = await openDb(dir);
    try {
      const target = buildAgentComponentInvocationSyncSourceKey("target-page");
      const overflow = REDRIVE_SESSION_PAGE + 1;
      await db.prisma.write((client) =>
        client.agentComponentInvocationSyncOutbox.createMany({
          data: Array.from({ length: overflow }, (_unused, index) => ({
            sourceKey: target,
            externalSessionId: `page-${String(index).padStart(4, "0")}`,
            externalGenerationId: "gen",
            partIndex: 0,
            partCount: 1,
            partHash: "hash",
            sourceUpdatedAt: NOW,
            dataRevision: 1,
            sourceSequence: 1,
            payload: {},
            status: OutboxStatus.DeadLettered,
            attemptCount: EXHAUSTED_ATTEMPTS,
            lastError:
              AgentComponentInvocationSyncRejectReason.ValidationFailed,
            createdAt: NOW,
            updatedAt: NOW,
          })),
        })
      );

      const firstPage = await redriveValidationFailedInvocationParts(db.prisma);
      assert.equal(
        firstPage?.redrivenSessions,
        REDRIVE_SESSION_PAGE,
        "one pass takes at most a page"
      );
      // Nothing has retired these rows, so a cursor that did not advance would
      // hand back the identical page here.
      const secondPage = await redriveValidationFailedInvocationParts(
        db.prisma
      );
      assert.equal(
        secondPage?.redrivenSessions,
        overflow - REDRIVE_SESSION_PAGE,
        "the next pass resumes after the page boundary"
      );
      assert.equal(
        await redriveValidationFailedInvocationParts(db.prisma),
        null,
        "a drained population marks the pass complete"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // `created_at` is the evidence of how long a row has been trying, and the only
  // input to the `session_missing` budget. The re-drive earns its clock from the
  // clone, so it must not touch a single stored timestamp itself.
  test("the re-drive pass rewrites no created_at", async () => {
    const dir = await makeInvocationSyncDir("aci-redrive-createdat-");
    const db = await openDb(dir);
    try {
      await db.importer.importSession(
        skillSession("session-createdat", [SKILL_CONTENT_V1]),
        "claude"
      );
      const target = buildAgentComponentInvocationSyncSourceKey("target-ca");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      await strandSession(
        db,
        target,
        "session-createdat",
        AgentComponentInvocationSyncRejectReason.ValidationFailed
      );

      await resetRedriveSentinel(db);

      const before = await readAllCreatedAt(db);
      assert.ok(before.length > 0);
      // The pass ALONE — no promotion after it, so nothing but this code has
      // written to the table between the two reads.
      const result = await redriveValidationFailedInvocationParts(db.prisma);
      assert.deepEqual(result, {
        redrivenSessions: 1,
        skippedMixedSessions: 0,
      });
      assert.deepEqual(
        await readAllCreatedAt(db),
        before,
        "the re-drive must not rewrite any row's created_at"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // One-shot means one shot. Without the sentinel this pass would clear a
  // per-session cursor on every prepare, re-materializing sessions forever and
  // resetting the bounded budget invariant 5 requires to stay reachable.
  test("a second run does not re-drive a newly dead-lettered validation_failed row", async () => {
    const dir = await makeInvocationSyncDir("aci-redrive-once-");
    const db = await openDb(dir);
    try {
      await db.importer.importSession(
        skillSession("session-once", [SKILL_CONTENT_V1]),
        "claude"
      );
      const target = buildAgentComponentInvocationSyncSourceKey("target-once");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      await strandSession(
        db,
        target,
        "session-once",
        AgentComponentInvocationSyncRejectReason.ValidationFailed
      );

      await resetRedriveSentinel(db);
      assert.deepEqual(
        await redriveValidationFailedInvocationParts(db.prisma),
        { redrivenSessions: 1, skippedMixedSessions: 0 },
        "the first run re-drives"
      );
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);

      // A row parked AFTER the pass ran is the sharp case: it is exactly what
      // the selection would pick up, so anything green here is green because the
      // sentinel held and not because there was nothing to find.
      const strandedAgain = await strandSession(
        db,
        target,
        "session-once",
        AgentComponentInvocationSyncRejectReason.ValidationFailed
      );
      assert.equal(
        await redriveValidationFailedInvocationParts(db.prisma),
        null,
        "a second run must return without scanning"
      );
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);

      const rows = await readDeliveryRows(db, target, "session-once");
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.equal(
          row.status,
          OutboxStatus.DeadLettered,
          "the re-drive is one-shot; a later dead-letter stays parked"
        );
        assert.equal(row.created_at, strandedAgain);
      }
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Everything ISS-6909 does NOT authorize. Promotion re-materializes a session
  // WHOLE, so a session that also carries another terminal cause would have that
  // cause re-driven as a side effect — which is ISS-5855's undecided general
  // recovery, not this ticket. Both shapes are covered: a session with no
  // `validation_failed` at all (never a candidate) and a MIXED one (a candidate
  // that is deliberately declined).
  test("rows dead-lettered for another cause are left alone", async () => {
    const dir = await makeInvocationSyncDir("aci-redrive-other-");
    const db = await openDb(dir);
    try {
      await db.importer.importSession(
        skillSession("session-other", [SKILL_CONTENT_V1]),
        "claude"
      );
      await db.importer.importSession(
        skillSession("session-mixed", [SKILL_CONTENT_V1]),
        "claude"
      );
      const target = buildAgentComponentInvocationSyncSourceKey("target-other");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      const otherCreatedAt = await strandSession(
        db,
        target,
        "session-other",
        AgentComponentInvocationSyncLocalError.SessionMissingHorizonExhausted
      );
      const mixedCreatedAt = await strandSession(
        db,
        target,
        "session-mixed",
        AgentComponentInvocationSyncRejectReason.ValidationFailed
      );
      await addSiblingPartWithCause(
        db,
        target,
        "session-mixed",
        AgentComponentInvocationSyncLocalError.SessionMissingHorizonExhausted
      );

      await resetRedriveSentinel(db);
      assert.deepEqual(
        await redriveValidationFailedInvocationParts(db.prisma),
        { redrivenSessions: 0, skippedMixedSessions: 1 },
        "only the mixed session is a declined candidate; the other is not one at all"
      );
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);

      for (const [sessionId, createdAt] of [
        ["session-other", otherCreatedAt],
        ["session-mixed", mixedCreatedAt],
      ] as const) {
        const rows = await readDeliveryRows(db, target, sessionId);
        assert.ok(rows.length > 0, `${sessionId} lost its rows`);
        for (const row of rows) {
          assert.equal(row.status, OutboxStatus.DeadLettered);
          assert.equal(
            Number(row.attempt_count),
            EXHAUSTED_ATTEMPTS,
            "an untouched row keeps the evidence of how hard the lane tried"
          );
          assert.equal(row.created_at, createdAt);
        }
      }
      assert.deepEqual(
        (await readDeliveryRows(db, target, "session-other")).map(
          (row) => row.last_error
        ),
        [AgentComponentInvocationSyncLocalError.SessionMissingHorizonExhausted]
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ISS-9626: the pass returns a tally the production caller used to discard, so
  // a declined mixed-cause session — the pass's own statement that it left
  // recoverable rows parked — was observable only from a test holding the return
  // value. Driven through `prepareInvocationSyncTarget` rather than the pass, so
  // dropping the tally or the `log` argument again fails here.
  test("the promotion step reports the re-drive tally on the diagnostic sink", async () => {
    const dir = await makeInvocationSyncDir("aci-redrive-count-");
    const logged: string[] = [];
    const db = await openDb(dir, (message: string) => logged.push(message));
    try {
      for (const sessionId of ["session-count-ok", "session-count-mixed"]) {
        await db.importer.importSession(
          skillSession(sessionId, [SKILL_CONTENT_V1]),
          "claude"
        );
      }
      const target = buildAgentComponentInvocationSyncSourceKey("target-count");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      // The materializing prepare ran the pass against a store with nothing
      // stranded. A tally line here would mean the report fires on every tick
      // rather than on an actual re-drive.
      assert.deepEqual(
        logged.filter((m) => REDRIVE_TALLY.test(m)),
        []
      );

      // Each half of the report's `||` is exercised ALONE. A run where both
      // counts are nonzero cannot tell the guard from an `&&`, so a re-driven
      // population with nothing declined comes first, and a declined population
      // with nothing re-driven second.
      await strandSession(
        db,
        target,
        "session-count-ok",
        AgentComponentInvocationSyncRejectReason.ValidationFailed
      );
      await resetRedriveSentinel(db);
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);

      assert.deepEqual(
        logged.filter((message) => REDRIVE_TALLY.test(message)),
        [
          "invocation sync validation re-drive (ISS-6909): handed 1 session(s) back to promotion, declined 0 carrying another dead-letter cause",
        ],
        "a re-drive with nothing declined still reports"
      );

      // `session-count-ok` is pending again after that pass, so it is no longer
      // a candidate and this run's only finding is the declined one.
      await strandSession(
        db,
        target,
        "session-count-mixed",
        AgentComponentInvocationSyncRejectReason.ValidationFailed
      );
      await addSiblingPartWithCause(
        db,
        target,
        "session-count-mixed",
        AgentComponentInvocationSyncLocalError.SessionMissingHorizonExhausted
      );
      await resetRedriveSentinel(db);
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);

      assert.deepEqual(
        logged.filter((message) => REDRIVE_TALLY.test(message)).slice(1),
        [
          "invocation sync validation re-drive (ISS-6909): handed 0 session(s) back to promotion, declined 1 carrying another dead-letter cause",
        ],
        "a declined mixed-cause session reports even with nothing re-driven"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
