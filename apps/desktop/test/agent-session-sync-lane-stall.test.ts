/**
 * @file agent-session-sync-lane-stall.test.ts
 * @description ISS-7730 acceptance coverage for the session lane's LANE-WIDE
 * `ingestion_failed` class, driven through the real `AgentSessionSyncService`
 * and its durable outbox.
 *
 * `ingestion_failed` is the sync route's UNCLASSIFIED 500 fallthrough, so
 * `main/sync/AGENTS.md` invariant 4 forbids it exhausting a per-row retry
 * budget — and invariant 5 forbids removing its only bound without replacing
 * one. The three cases here are the three ways that pair can be got wrong, each
 * able to fail INDEPENDENTLY:
 *
 *  1. the exemption itself — no number of 5xx rejections may dead-letter a row;
 *  2. the replacement bound — a genuinely stalled row must still terminate, and
 *     its clock must survive the relaunch that an in-memory one would not;
 *  3. the blast radius — exempting the lane-wide class must not disarm the
 *     ROW-ATTRIBUTABLE ones, and a row-attributable verdict must end the stall.
 *
 * Split out of `agent-session-sync-service.test.ts`, which is over the file-size
 * ceiling and shrink-only (root `AGENTS.md`); the pure fold logic behind these
 * has its own unit coverage in `agent-session-sync-lane-stall-fold.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MAX_CONSECUTIVE_VALIDATION_FAILED,
  SESSION_LANE_STALL_CEILING_MS,
  SESSION_LANE_STALL_RETRY_MS,
  VALIDATION_FAILED_BACKOFF_MS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import {
  flushAgentSessionSync,
  makeServiceWithIdentity,
  runWithMockedNow,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

test("ISS-7730: a lane-wide ingestion_failed defers with its budget intact and only dead-letters on the wall clock", async () => {
  // FEA-3659's regression guard for the 179-row attempt_count=0 dead-letter
  // burst, carried forward onto ISS-7730's contract. `ingestion_failed` is the
  // route's UNCLASSIFIED 500 fallthrough, so per `main/sync/AGENTS.md`
  // invariant 4 no number of them may exhaust a per-row budget — the loop below
  // deliberately runs PAST the retired MAX_CONSECUTIVE_INGESTION_FAILED of 5 and
  // the row must still be pending. The durable attempt_count keeps growing
  // because it is evidence of how hard the lane tried, not a budget: nothing
  // terminal reads it. The one terminal path is the wall clock, and
  // `lane_stalled_since` must be stamped once and then hold still across every
  // retry — a clock that restarted each attempt would never reach the ceiling.
  // Comfortably above the retired MAX_CONSECUTIVE_INGESTION_FAILED (5) and
  // comfortably inside SESSION_LANE_STALL_CEILING_MS (24h at ~5min a rung).
  const ATTEMPTS_INSIDE_CEILING = 8;
  const TARGET = "target-ingestion-retry";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("ingest-retry", "2026-06-08T12:00:00.000Z"),
  ]);
  const outboxRowFor = (id: string) =>
    [...source.outbox.values()].find((r) => r.sourceKey === key && r.id === id);
  const service = makeServiceWithIdentity(
    source,
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    }),
    TARGET
  );

  try {
    await runWithMockedNow(async ({ advance }) => {
      service.start();
      await flushAgentSessionSync();

      // First failure: the row is deferred (retry), NOT dead-lettered, and the
      // durable outbox records attempt_count=1 with a next_attempt_at deadline.
      let row = outboxRowFor("ingest-retry");
      assert.equal(
        row?.status,
        "pending",
        "attempt 0 schedules a retry — the row stays pending, never dead-lettered"
      );
      assert.equal(
        row?.attemptCount,
        1,
        "first failure records attempt_count=1"
      );
      assert.equal(row?.reason, "ingestion_failed");
      assert.ok(
        row?.nextAttemptAt,
        "a deferred transient retry stamps a next_attempt_at backoff deadline"
      );

      const stalledSince = row?.laneStalledSince;
      assert.ok(
        stalledSince,
        "the first lane-wide failure stamps the durable stall clock"
      );

      // Drive far PAST the retired 5-attempt budget, all inside the ceiling.
      // Every one of these iterations dead-lettered the row before ISS-7730.
      //
      // ISS-8610 CHANGED HOW FAR EACH STEP ADVANCES, deliberately. The defer used
      // to be a flat `SESSION_LANE_STALL_RETRY_MS` on every attempt, so a fixed
      // advance of one floor always cleared it; the delay now stages off the
      // run's age (5 -> 10 -> 20 -> 40 -> 60 minutes), and a fixed one-floor
      // advance would leave the row parked and its attempt_count flat. Advancing
      // to the deadline the lane ITSELF wrote keeps this case asserting what it
      // was written to assert — that no number of lane-wide 5xx rejections
      // exhausts a row budget — without pinning a cadence it never claimed.
      for (let attempt = 2; attempt <= ATTEMPTS_INSIDE_CEILING; attempt += 1) {
        const deferredUntilMs = Date.parse(row?.nextAttemptAt ?? "");
        assert.ok(
          Number.isFinite(deferredUntilMs),
          "every deferral writes a readable deadline to advance to"
        );
        advance(deferredUntilMs - Date.now() + 1);
        service.refresh();
        await flushAgentSessionSync();
        row = outboxRowFor("ingest-retry");
        assert.equal(
          row?.status,
          "pending",
          `attempt ${attempt} still retries — a 5xx never exhausts a row budget`
        );
        assert.equal(
          row?.attemptCount,
          attempt,
          `attempt_count grows to ${attempt} as evidence, not as a budget`
        );
        assert.equal(
          row?.laneStalledSince,
          stalledSince,
          "the stall clock marks the START of the run and must not restart"
        );
      }

      // Past the ceiling the replacement bound fires and the row dead-letters.
      advance(SESSION_LANE_STALL_CEILING_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    });
  } finally {
    service.stop();
  }

  const finalRow = outboxRowFor("ingest-retry");
  assert.equal(
    finalRow?.status,
    "dead_lettered",
    "the wall-clock ceiling keeps invariant 5's terminal path reachable"
  );
  assert.equal(
    finalRow?.attemptCount,
    ATTEMPTS_INSIDE_CEILING + 1,
    "the dead-lettered row records the real attempt tally, not a misleading 0"
  );
  assert.equal(
    finalRow?.reason,
    "ingestion_failed_lane_stalled",
    "a wall-clock abandonment is distinguishable from a row still deferring"
  );
});

test("ISS-7730: a row-attributable rejection still burns its own budget, and ends the lane-wide stall run", async () => {
  // The invariant-5 trap has a second half, and it is the one a naive fix breaks
  // silently: exempting the LANE-WIDE class must not disarm the ROW-ATTRIBUTABLE
  // ones. This drives a 5xx first (stall clock stamped), then switches the server
  // to a 400 and proves two things independently — the durable stall run ENDS,
  // because a verdict about the row is proof the lane answered, and the
  // validation budget still reaches its own terminal path on schedule.
  //
  // Without the clear, a row that saw one 5xx a day ago would be abandoned as
  // "lane stalled" on a demonstrably healthy lane.
  const TARGET = "target-row-attributable";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("row-bad", "2026-06-08T12:00:00.000Z"),
  ]);
  const rowFor = () =>
    [...source.outbox.values()].find(
      (r) => r.sourceKey === key && r.id === "row-bad"
    );
  let laneWide = true;
  const service = makeServiceWithIdentity(
    source,
    async () => ({
      accepted: false,
      reason: laneWide
        ? DesktopAgentSessionsAckReason.IngestionFailed
        : DesktopAgentSessionsAckReason.ValidationFailed,
    }),
    TARGET
  );

  try {
    await runWithMockedNow(async ({ advance }) => {
      service.start();
      await flushAgentSessionSync();
      assert.ok(
        rowFor()?.laneStalledSince,
        "the lane-wide 5xx stamped a durable stall clock"
      );

      laneWide = false;
      advance(SESSION_LANE_STALL_RETRY_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        rowFor()?.laneStalledSince,
        null,
        "a verdict about the row proves the lane answered — the stall run ends"
      );
      assert.equal(
        rowFor()?.status,
        "pending",
        "one validation failure is not the whole validation budget"
      );

      // Spend the rest of the row-attributable budget.
      for (let i = 1; i < MAX_CONSECUTIVE_VALIDATION_FAILED; i += 1) {
        advance(VALIDATION_FAILED_BACKOFF_MS + 1);
        service.refresh();
        await flushAgentSessionSync();
      }
    });
  } finally {
    service.stop();
  }

  assert.equal(
    rowFor()?.status,
    "dead_lettered",
    "the row-attributable budget still reaches its terminal path — ISS-7730 exempted only the lane-wide class"
  );
  assert.equal(
    rowFor()?.laneStalledSince,
    null,
    "the abandoned row was not blamed on a lane-wide stall"
  );
});

test("ISS-7730: a cold restart mid-outage rehydrates the backoff deadline AND the lane-stall clock (no immediate retry, no clock reset)", async () => {
  // Recording the retry is write-only unless resume reads it back, and after
  // ISS-7730 the thing that MUST survive is the wall clock, because it is the
  // only terminal path a lane-wide failure has. A prior run left one session
  // mid-backoff with a future next_attempt_at and a stall clock already one rung
  // short of SESSION_LANE_STALL_CEILING_MS. On restart the in-memory maps start
  // EMPTY, so without rehydration the row would (a) retry immediately, ignoring
  // the persisted deadline, and (b) restart its stall clock from zero — which is
  // the failure mode that matters most here: a desktop relaunched inside a long
  // outage would reset the clock on every launch and NEVER dead-letter, turning
  // invariant 4 compliance into the invariant 5 violation this ticket exists to
  // avoid. That is why the clock is a column and not a Map.
  const TARGET = "target-resume-backoff";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("backing-off", "2026-06-08T12:03:00.000Z"),
  ]);
  // A persisted cursor at the corpus top so resume skips the full re-walk.
  source.seedSyncState(key, {
    observedTopUpdatedAt: "2026-06-08T12:03:00.000Z",
    observedIdsAtTopUpdatedAt: ["backing-off"],
  });

  const acked: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      acked.push(batch.sessions.map((s) => s.externalSessionId));
      return Promise.resolve({
        accepted: false as const,
        reason: DesktopAgentSessionsAckReason.IngestionFailed,
      });
    },
    TARGET
  );

  try {
    await runWithMockedNow(async ({ advance }) => {
      // Seed the durable mid-outage row exactly as the prior run left it: a
      // deadline one stall rung out, and a stall clock that started just inside
      // the ceiling, so a single post-resume failure crosses it.
      const deadlineIso = new Date(
        Date.now() + SESSION_LANE_STALL_RETRY_MS
      ).toISOString();
      const stalledSinceIso = new Date(
        Date.now() - SESSION_LANE_STALL_CEILING_MS + SESSION_LANE_STALL_RETRY_MS
      ).toISOString();
      source.recordOutboxRetry(
        key,
        "backing-off",
        4,
        deadlineIso,
        "ingestion_failed",
        stalledSinceIso
      );

      service.start();
      await flushAgentSessionSync();

      // The rehydrated deadline is still in the future → the row is deferred, NOT
      // retried on resume (an empty nextRetryAfterMs would have uploaded it now).
      assert.deepEqual(
        acked,
        [],
        "a resumed mid-backoff row is not retried before its persisted next_attempt_at"
      );

      // Past the deadline: one retry fires, and because the STALL CLOCK was
      // rehydrated (not reset to now), this failure lands past the ceiling and
      // dead-letters immediately instead of starting a fresh 24h run.
      advance(SESSION_LANE_STALL_RETRY_MS + 1);
      service.refresh();
      await flushAgentSessionSync();

      assert.deepEqual(
        acked,
        [["backing-off"]],
        "exactly one retry fires once the persisted deadline elapses"
      );
    });
  } finally {
    service.stop();
  }

  const finalRow = [...source.outbox.values()].find(
    (r) => r.sourceKey === key && r.id === "backing-off"
  );
  assert.equal(
    finalRow?.status,
    "dead_lettered",
    "the rehydrated stall clock + one more failure crosses the ceiling — proving the clock was NOT restarted on resume"
  );
  assert.equal(
    finalRow?.attemptCount,
    5,
    "the dead-lettered row records the rehydrated tally (4) plus this attempt"
  );
  assert.equal(
    finalRow?.reason,
    "ingestion_failed_lane_stalled",
    "the abandonment names the wall-clock stall, not a spent budget"
  );
});

/**
 * ISS-8605 (PRD-699 F2) — BEHAVIOUR CHANGE, replacing "ISS-7730: a
 * server-answered ack_timeout also ends the lane-wide stall run".
 *
 * That test rested on a premise the classification review retired: that a 408 is
 * the SERVER answering about this batch. The sync route was verified never to
 * emit one — a slow upsert surfaces as a 5xx → `ingestion_failed` — so every 408
 * this lane can receive was injected by an intermediary that never reached the
 * server at all. It is therefore no evidence the lane is reachable, and ending a
 * stall run on it would hand a row a fresh 24 hours in the middle of an outage,
 * pushing the only terminal environmental bound permanently out of reach.
 *
 * The expectation is inverted, not weakened: 400 `validation_failed` still ends
 * the run (asserted by the sibling case above), and this one now pins that 408
 * does NOT — the two halves of the same `noteLaneAnswered` contract, asserted in
 * opposite states.
 */
test("ISS-8605: an intermediary ack_timeout does NOT end the lane-wide stall run", () => {
  const TARGET = "target-ack-timeout-clears";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("timed-out", "2026-06-08T12:00:00.000Z"),
  ]);
  const rowFor = () =>
    [...source.outbox.values()].find(
      (r) => r.sourceKey === key && r.id === "timed-out"
    );
  let laneWide = true;
  const service = makeServiceWithIdentity(
    source,
    () =>
      Promise.resolve({
        accepted: false as const,
        reason: laneWide
          ? DesktopAgentSessionsAckReason.IngestionFailed
          : DesktopAgentSessionsAckReason.AckTimeout,
      }),
    TARGET
  );

  return runWithMockedNow(async ({ advance }) => {
    try {
      service.start();
      await flushAgentSessionSync();
      const stampedAt = rowFor()?.laneStalledSince;
      assert.ok(stampedAt, "the lane-wide 5xx stamped a durable stall clock");

      laneWide = false;
      advance(SESSION_LANE_STALL_RETRY_MS + 1);
      service.refresh();
      await flushAgentSessionSync();

      assert.equal(
        rowFor()?.laneStalledSince,
        stampedAt,
        "a 408 no server emitted proves nothing about the lane — the run keeps its ORIGINAL start"
      );
    } finally {
      service.stop();
    }
  });
});
