/**
 * @file agent-session-sync-backfill-rebuild-starvation.test.ts
 * @description ISS-4712 regression coverage: a DATA_REVISION rebuild that bumps
 * every re-derived session's `updated_at` must NOT starve the historical
 * backfill drain.
 *
 * BUG: `enqueueIncrementalUpdates` re-selects every row whose `updated_at`
 * advanced past the cursor and pushes it onto the HIGH-priority incremental
 * lane. During a rebuild the re-derivation bumps `updated_at` on sessions that
 * are STILL sitting in the backfill queue, so those rows re-enter the
 * incremental lane on every tick. The incremental-first gate then keeps
 * preferring that perpetually-non-empty lane, and the 1,700+ session historical
 * backfill is starved (observed: ~10 incremental / 90s while backfill sits
 * pinned for minutes).
 *
 * FIX: `enqueueIncrementalUpdates` skips any id already tracked in
 * `backfillQueuedIds` (mirroring the existing `incrementalQueuedIds` dedup), so
 * rebuild `updated_at` churn cannot repopulate the incremental lane with rows
 * the backfill lane already owns. Backfill syncs those rows anyway — with
 * fresher data — so nothing is lost; the rebuild simply stops preempting it.
 *
 * TEST SHAPE: drive the REAL `AgentSessionSyncService` through its public tick
 * surface (`start()` fires the first tick, `refresh()` drives each subsequent
 * one) with the shared `FakeSyncSource`, like the sibling bulk-drain suite. To
 * hold the corpus in the backfill lane while the rebuild churns `updated_at`,
 * `sendBatch` throws a TRANSIENT transport error while `blockSends` is set — a
 * thrown transport error leaves the batch queued for retry (below the
 * dead-letter budget) and does NOT self-continue, so the corpus stays in
 * `backfillQueue` across the rebuild ticks without runaway re-entry. Assertions
 * are on OBSERVABLE queue state (`getSyncProgress()`), never on log calls.
 *
 * WITHOUT the fix, the three rebuild ticks push all six bumped ids onto the
 * incremental lane (`pendingIncrementalSessions` climbs to 6 while backfill
 * still shows 6) — the starvation. WITH the fix, the incremental lane stays
 * empty every tick, and once the send gate is released the backfill lane drains
 * the whole corpus.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncProgress } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const COMPUTE_TARGET = "rebuild-starvation-target";

// A transient (non-serialization) transport failure: the service leaves the
// batch queued for retry until MAX_CONSECUTIVE_TRANSPORT_ERRORS, and — unlike an
// accepted ack — does NOT schedule the self-continuing drain. That keeps the
// corpus in `backfillQueue` across the rebuild ticks without runaway re-entry or
// the corpus dead-lettering (kept well under the 5-error budget).
const TRANSIENT_TRANSPORT_FAILURE = "socket hang up";

const MAX_SETTLE_TURNS = 500;

/** Advance one event-loop turn (microtasks + one macrotask). */
async function pumpOneTurn(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Pump event-loop turns until `predicate(getSyncProgress())` holds, then return.
 * THROWS on timeout so a missed settle surfaces as an explicit, labeled failure
 * instead of silently falling through onto a stale-state assertion.
 */
async function waitForSyncSettled(
  service: AgentSessionSyncService,
  predicate: (progress: AgentSessionSyncProgress) => boolean,
  label: string
): Promise<void> {
  for (let turn = 0; turn < MAX_SETTLE_TURNS; turn += 1) {
    if (predicate(service.getSyncProgress())) {
      return;
    }
    await pumpOneTurn();
  }
  throw new Error(
    `sync never settled after ${MAX_SETTLE_TURNS} turns waiting for: ${label} ` +
      `(last progress: ${JSON.stringify(service.getSyncProgress())})`
  );
}

/** The whole corpus is queued into the backfill lane. */
function backfillSeeded(count: number) {
  return (progress: AgentSessionSyncProgress): boolean =>
    progress.pendingBackfillSessions === count;
}

/** The whole corpus is fully accounted for (nothing left pending in either lane). */
function caughtUp(progress: AgentSessionSyncProgress): boolean {
  return (
    progress.caughtUp &&
    progress.pendingBackfillSessions === 0 &&
    progress.pendingIncrementalSessions === 0
  );
}

/**
 * A substantive-session corpus whose `updated_at` timestamps ascend, so a later
 * rebuild re-derivation can push a row STRICTLY past the observed cursor top —
 * the exact condition that makes `enqueueIncrementalUpdates` want to re-enqueue
 * it.
 */
function makeRebuildCorpus(count: number): {
  source: FakeSyncSource;
  ids: string[];
} {
  const sessions: SyncedAgentSession[] = [];
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `session-${String(i).padStart(3, "0")}`;
    ids.push(id);
    const minute = String(i % 60).padStart(2, "0");
    sessions.push(makeSyncedSession(id, `2026-06-08T12:${minute}:00.000Z`));
  }
  return { source: new FakeSyncSource(sessions), ids };
}

test("ISS-4712: a rebuild bumping updated_at on backfill-queued sessions does NOT repopulate the incremental lane or starve the backfill drain", async () => {
  const CORPUS = 6;
  const { source, ids } = makeRebuildCorpus(CORPUS);
  let blockSends = true;
  const acceptedIds = new Set<string>();
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: (batch) => {
      if (blockSends) {
        return Promise.reject(new Error(TRANSIENT_TRANSPORT_FAILURE));
      }
      for (const session of batch.sessions) {
        acceptedIds.add(session.externalSessionId);
      }
      return Promise.resolve({ accepted: true });
    },
  });

  // ISS-4807: await the REAL session-tick completion signal instead of pumping a
  // fixed, guessed number of event-loop turns. `whenSessionSyncSettled()` resolves
  // only once the in-flight pass (hydrate → initializeBackfillQueueIfNeeded →
  // enqueueIncrementalUpdates → candidate selection → send attempt → finally) has
  // actually settled, so the assertions below read genuinely-settled queue state
  // rather than state that merely survived TICK_TURNS turns. One extra turn is
  // pumped afterwards so the pass's own `.finally` bookkeeping has run before the
  // caller reads `getSyncProgress()`.
  const settleTick = async (): Promise<void> => {
    await service.whenSessionSyncSettled();
    await pumpOneTurn();
  };

  // wongk (PR #4185): the body runs in try/finally so a rejected wait/assertion
  // still stops the service. Otherwise the 5-second interval installed by start()
  // stays live and can hang the node:test process after the real failure. stop()
  // is idempotent, so the finally is safe even on the all-green path.
  try {
    // First tick: the whole corpus seeds into the backfill lane; the backfill send
    // throws (transient) so the queue stays fully populated.
    service.start();
    await waitForSyncSettled(
      service,
      backfillSeeded(CORPUS),
      "corpus seeded into backfill"
    );
    await settleTick();
    assert.equal(
      service.getSyncProgress().pendingIncrementalSessions,
      0,
      "nothing is on the incremental lane after the initial full-corpus seed"
    );

    // The rebuild: every re-derived session's `updated_at` is bumped STRICTLY past
    // the observed cursor top. Absent the fix, the next enqueueIncrementalUpdates
    // re-selects all of them onto the high-priority incremental lane.
    for (let i = 0; i < CORPUS; i += 1) {
      const minute = String(i % 60).padStart(2, "0");
      source.upsert(
        makeSyncedSession(ids[i], `2026-06-08T13:${minute}:00.000Z`)
      );
    }

    // Drive rebuild-churn ticks. Each re-runs enqueueIncrementalUpdates with every
    // bumped id already in `backfillQueuedIds`. With the fix, the incremental lane
    // stays EMPTY on every tick and the backfill lane keeps the whole corpus — the
    // rebuild never preempts it.
    for (let tick = 0; tick < 3; tick += 1) {
      service.refresh();
      // Drain THIS tick's promise chain before reading queue state — otherwise the
      // assertion could observe state before the incremental enqueue (which the
      // bug performs) has run.
      await settleTick();
      assert.equal(
        service.getSyncProgress().pendingIncrementalSessions,
        0,
        `rebuild churn did not repopulate the incremental lane (tick ${tick})`
      );
      assert.equal(
        service.getSyncProgress().pendingBackfillSessions,
        CORPUS,
        `backfill still owns the full corpus after rebuild tick ${tick}`
      );
    }

    // No session was permanently lost to a dead-letter by the transient failures.
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      0,
      "the transient transport failures did not dead-letter any session"
    );

    // Release the send gate: the backfill lane drains the whole corpus — proving
    // the rebuild-churned rows were reachable via backfill all along, so skipping
    // the incremental enqueue lost nothing.
    blockSends = false;
    service.refresh();
    await waitForSyncSettled(
      service,
      caughtUp,
      "backfill drains the whole corpus after the rebuild"
    );

    assert.equal(
      acceptedIds.size,
      CORPUS,
      "every rebuild-churned session ultimately synced via the backfill lane"
    );
  } finally {
    service.stop();
  }
});
