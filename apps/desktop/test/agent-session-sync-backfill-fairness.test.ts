/**
 * @file agent-session-sync-backfill-fairness.test.ts
 * @description ISS-6166 regression coverage: a continuously-replenished
 * INCREMENTAL lane must not starve the historical backfill.
 *
 * BUG: candidate selection was strict priority — backfill was tried only when
 * the incremental pick returned zero candidates — and
 * `INCREMENTAL_SESSION_READY_THRESHOLD` is 1, so a single ready incremental row
 * wins the tick. On an install that keeps producing local session updates the
 * incremental lane never empties, so backfill was never selected at all. The
 * reported install held 646 backfill rows motionless for two days while
 * incremental trickled down, and the durable cursor — which only persists once
 * BOTH queues drain — stayed 29 hours stale behind it.
 *
 * ISS-4712 already removed one SOURCE of that pressure (rebuild `updated_at`
 * churn re-enqueuing rows the backfill queue already owned, covered by
 * `agent-session-sync-backfill-rebuild-starvation.test.ts`). That dedup cannot
 * help here: the incremental pressure in this test is GENUINELY NEW sessions,
 * which no dedup may drop.
 *
 * FIX: `shouldReserveTickForBackfill` reserves the tick after
 * `MAX_CONSECUTIVE_INCREMENTAL_PASSES` consecutive incremental wins, and hands
 * an unspent reservation straight back to incremental — a FLOOR on fairness,
 * never a ceiling on throughput (`main/sync/AGENTS.md` invariant 5).
 *
 * TEST SHAPE: drive the REAL `AgentSessionSyncService` over the shared
 * `FakeSyncSource`. `sendBatch` succeeds AND creates one brand-new local session
 * per batch, which is what an actively-used machine does — so the incremental
 * lane is non-empty at every selection point for the whole run. Assertions are
 * on OBSERVABLE state (`getSyncProgress()`, the source's recorded
 * `advanceSyncState` calls), never on log calls.
 *
 * WITHOUT the fix the backfill lane never drains past its first batch (it is
 * selected once, on the tick before any live session exists, and never again),
 * so `pendingBackfillSessions` stays pinned and `caughtUp` is never reached.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKFILL_SESSION_BATCH_SIZE } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const COMPUTE_TARGET = "backfill-fairness-target";

/**
 * Three full backfill batches, so draining the corpus REQUIRES the backfill lane
 * to win several separate ticks rather than one lucky first pass.
 */
const CORPUS = BACKFILL_SESSION_BATCH_SIZE * 3;

/**
 * How many selection ticks to drive. Generous against the reservation period
 * (one backfill tick per `MAX_CONSECUTIVE_INCREMENTAL_PASSES` incremental ones),
 * and bounded so a genuinely starved lane fails loudly instead of hanging.
 */
const MAX_SELECTION_TICKS = 80;

/** The corpus predates every live session, so live rows always sort past it. */
const CORPUS_DAY = "2026-06-08";
const LIVE_DAY = "2026-06-09";

/** Id prefix that identifies which lane a sent batch came from. */
const LIVE_ID_PREFIX = "live-";

/** Advance one event-loop turn (microtasks + one macrotask). */
async function pumpOneTurn(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function timestampAt(day: string, index: number): string {
  const hour = String(Math.floor(index / 60) % 24).padStart(2, "0");
  const minute = String(index % 60).padStart(2, "0");
  return `${day}T${hour}:${minute}:00.000Z`;
}

/** A historical corpus, all of it destined for the backfill lane on pass zero. */
function makeBackfillCorpus(): { source: FakeSyncSource; ids: string[] } {
  const sessions: SyncedAgentSession[] = [];
  const ids: string[] = [];
  for (let i = 0; i < CORPUS; i += 1) {
    const id = `corpus-${String(i).padStart(3, "0")}`;
    ids.push(id);
    sessions.push(makeSyncedSession(id, timestampAt(CORPUS_DAY, i)));
  }
  return { source: new FakeSyncSource(sessions), ids };
}

test("ISS-6166: a continuously-replenished incremental lane does not starve the historical backfill", async () => {
  const { source, ids } = makeBackfillCorpus();
  const acceptedIds = new Set<string>();
  let liveSessionsCreated = 0;
  let liveChurnEnabled = true;
  // Which lane WON each tick, read off the batch the service actually sent —
  // selection-time truth, not a sample of queue depth that the self-continuing
  // drain can settle away between ticks.
  let incrementalWins = 0;
  let backfillWins = 0;
  /** Every win in order, so the INTERLEAVE itself can be asserted. */
  const laneOrder: string[] = [];

  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: (batch) => {
      const wonByIncremental = batch.sessions.some((session) =>
        session.externalSessionId.startsWith(LIVE_ID_PREFIX)
      );
      if (wonByIncremental) {
        incrementalWins += 1;
        laneOrder.push("incremental");
      } else {
        backfillWins += 1;
        laneOrder.push("backfill");
      }
      for (const session of batch.sessions) {
        acceptedIds.add(session.externalSessionId);
      }
      if (liveChurnEnabled) {
        // The machine keeps working while the backlog uploads: one brand-new
        // local session lands per batch. Its `updated_at` is past the observed
        // corpus top, so `enqueueIncrementalUpdates` puts it on the HIGH-priority
        // incremental lane, and it is a genuinely new id no dedup may drop.
        liveSessionsCreated += 1;
        source.upsert(
          makeSyncedSession(
            `${LIVE_ID_PREFIX}${String(liveSessionsCreated).padStart(3, "0")}`,
            timestampAt(LIVE_DAY, liveSessionsCreated)
          )
        );
      }
      return Promise.resolve({ accepted: true });
    },
  });

  // Run in try/finally so a failed assertion still clears the 5s interval
  // start() installs; otherwise a real failure hangs the node:test process.
  try {
    service.start();
    for (let tick = 0; tick < MAX_SELECTION_TICKS; tick += 1) {
      await service.whenSessionSyncSettled();
      await pumpOneTurn();
      if (service.getSyncProgress().pendingBackfillSessions === 0) {
        break;
      }
      service.refresh();
    }

    // The starvation precondition really held: the incremental lane won ticks
    // throughout the run. Without this the corpus could have drained simply
    // because no live session ever arrived.
    assert.ok(
      incrementalWins > 0,
      "the incremental lane won ticks while the backfill still owed rows"
    );
    assert.equal(
      service.getSyncProgress().pendingBackfillSessions,
      0,
      `the historical backfill drained despite unbroken incremental pressure (backfill won ${backfillWins} tick(s), incremental ${incrementalWins}, accepted ${acceptedIds.size} session(s))`
    );
    // Three full batches of corpus can only clear across three separate backfill
    // wins. Pre-fix the lane got exactly ONE — the pass before any live session
    // existed — and never won another.
    assert.ok(
      backfillWins >= 3,
      `the backfill lane won a tick repeatedly, not once (won ${backfillWins})`
    );
    // The reservation is a FLOOR, not a ceiling — it must be SPENT on the tick
    // it fires, so live sync is never starved behind the backlog in reverse
    // (`main/sync/AGENTS.md` invariant 5: "A fairness policy that shrinks the
    // window is the same starvation, reversed"). A counter that never reset
    // would latch the reservation on and hand backfill every remaining tick,
    // which shows up here as two backfill wins in a row.
    const adjacentBackfillWins = laneOrder.filter(
      (lane, index) =>
        index > 0 && lane === "backfill" && laneOrder[index - 1] === "backfill"
    ).length;
    assert.equal(
      adjacentBackfillWins,
      0,
      `the backfill reservation was spent each time it fired, never latched on (order: ${laneOrder.join(",")})`
    );
    for (const id of ids) {
      assert.ok(
        acceptedIds.has(id),
        `historical session ${id} reached the cloud`
      );
    }

    // With the churn stopped the lane must reach a genuinely caught-up state and
    // PERSIST the watermark. A cursor that can only ever be written when both
    // queues empty is a cursor a starved backfill pins forever — the 29h-stale
    // cursor on the reported install (`main/sync/AGENTS.md` invariant 1).
    liveChurnEnabled = false;
    const sourceKey = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);
    // Refresh BEFORE testing the predicate: the last churned batch created a
    // session the lane has not observed yet, and breaking on the stale
    // caught-up reading would leave it un-enqueued and the watermark one row
    // behind the corpus the source actually holds.
    for (let tick = 0; tick < MAX_SELECTION_TICKS; tick += 1) {
      service.refresh();
      await service.whenSessionSyncSettled();
      await pumpOneTurn();
      const progress = service.getSyncProgress();
      if (
        progress.caughtUp &&
        progress.pendingIncrementalSessions === 0 &&
        progress.pendingBackfillSessions === 0
      ) {
        break;
      }
    }

    assert.equal(
      service.getSyncProgress().caughtUp,
      true,
      "the lane reached a caught-up state once the live churn stopped"
    );
    const lastAdvance = source.advanceCalls.at(-1);
    assert.equal(
      lastAdvance?.sourceKey,
      sourceKey,
      "the durable cursor was persisted for this source key"
    );
    assert.equal(
      lastAdvance?.state.observedTopUpdatedAt,
      timestampAt(LIVE_DAY, liveSessionsCreated),
      "the persisted watermark advanced to the newest session the lane acked, not the pre-backlog position"
    );
  } finally {
    service.stop();
  }
});
